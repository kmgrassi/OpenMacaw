defmodule SymphonyElixir.Runner.LlmToolRunner do
  @moduledoc """
  Generic LLM runner for agents whose turn loop is model + runtime tools.
  """

  @behaviour SymphonyElixir.Runner

  alias SymphonyElixir.{MessageHistory, WorkItem}
  alias SymphonyElixir.Runner.LlmToolRunner.{Cutover, SessionConfig, ToolExecutor}
  alias SymphonyElixir.Runner.Observability

  @impl true
  def start_session(config, workspace) when is_map(config) do
    if SessionConfig.probe_only?(config) do
      with :ok <- ping(config) do
        {:ok, %{probe_only: true, runner: "manager"}}
      end
    else
      model_client = SessionConfig.model_client(config)

      with {:ok, credential} <- SessionConfig.resolve_credential(config, model_client),
           {:ok, state} <-
             Agent.start_link(fn ->
               %{previous_response_id: SessionConfig.config_value(config, "previous_response_id")}
             end) do
        {:ok, SessionConfig.build_session(config, workspace, credential, model_client, state)}
      end
    end
  end

  @impl true
  def run_turn(session, due_tasks_payload, %WorkItem{} = work_item)
      when is_map(session) and is_binary(due_tasks_payload) do
    run_id = work_item_run_id(work_item)

    session =
      session
      |> Map.put(:previous_response_id, previous_response_id(session))
      |> Map.put(:history, fetch_chat_history(session, run_id))
      |> Map.put(
        :current_speaker_label,
        MessageHistory.current_speaker_label(Map.get(session, :message_recorder_scope))
      )

    request =
      model_client_initial_request(
        session,
        MessageHistory.user_content(due_tasks_payload, Map.get(session, :current_speaker_label)),
        work_item
      )

    run_model_loop(session, request, 0, run_id)
  end

  defp fetch_chat_history(session, current_run_id) do
    MessageHistory.fetch(
      Map.get(session, :message_recorder_scope),
      limit: Map.get(session, :history_window, MessageHistory.default_limit()),
      exclude_run_id: current_run_id
    )
  end

  defp work_item_run_id(%WorkItem{metadata: metadata}) when is_map(metadata) do
    case Map.get(metadata, "run_id") || Map.get(metadata, :run_id) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp work_item_run_id(_work_item), do: nil

  @impl true
  def stop_session(%{state: state}) when is_pid(state) do
    Agent.stop(state, :normal)
  catch
    :exit, _reason -> :ok
  end

  def stop_session(_session), do: :ok

  @impl true
  def ping(config) do
    case SessionConfig.resolve_credential(config, SessionConfig.model_client(config)) do
      {:ok, _credential} -> :ok
      {:error, :no_credential} -> {:error, :no_credential}
    end
  end

  @impl true
  def requires_workspace?, do: false

  defp run_model_loop(session, request, iteration, run_id) do
    attempt = iteration + 1

    with {:ok, response} <- model_client_create_response(session, request, attempt) do
      remember_response_id(session, response)
      emit_response_messages(session, response, run_id)

      case model_client_tool_calls(session, response) do
        [] ->
          emit_turn_completed(session, response, run_id)
          {:ok, response_result(session, response)}

        calls when iteration < session.max_tool_iterations ->
          outputs = execute_tool_calls(session, calls, run_id, relay_correlation_id(request))
          follow_up = model_client_follow_up_request(session, response, outputs)
          run_model_loop(session, follow_up, iteration + 1, run_id)

        _calls ->
          {:error, {:fatal, :tool_iteration_limit_exceeded}}
      end
    end
  end

  defp execute_tool_calls(session, calls, run_id, correlation_id) do
    Enum.map(calls, fn call ->
      started_at = System.monotonic_time(:millisecond)
      tool = Map.get(call, "name")
      tool_call_id = Map.get(call, "call_id")
      arguments = decode_arguments(Map.get(call, "arguments"))

      result =
        ToolExecutor.execute(tool, arguments, session, tool_call_id, correlation_id)
        |> Observability.classify_tool_result(
          %{tool_name: tool, tool_call_id: tool_call_id, attempt: 1},
          duration_since(started_at)
        )
        |> Observability.log_tool_result()

      event = if Map.get(result, "success"), do: :tool_call_completed, else: :tool_call_failed

      emit_message(session, event, %{
        run_id: run_id,
        payload: %{
          "tool_name" => tool,
          "tool_call_id" => tool_call_id,
          "arguments" => arguments,
          "params" =>
            %{"tool" => tool, "callId" => tool_call_id}
            |> maybe_put_payload_field("errorCode", Map.get(result, "error_code"))
            |> maybe_put_payload_field("retryable", Map.get(result, "retryable"))
        },
        details: result
      })

      %{
        "type" => "function_call_output",
        "call_id" => tool_call_id,
        "output" => Map.get(result, "output", Jason.encode!(result))
      }
    end)
  end

  # The relay session correlation for the current turn. Local-relay requests
  # carry it (RuntimeManaged sets the response id equal to it, so it is stable
  # across the model turn and the follow-up). Other model clients have none.
  defp relay_correlation_id(request) when is_map(request) do
    Map.get(request, "correlation_id") || Map.get(request, :correlation_id)
  end

  defp relay_correlation_id(_request), do: nil

  defp decode_arguments(arguments) when is_binary(arguments) do
    case Jason.decode(arguments) do
      {:ok, decoded} -> decoded
      {:error, _reason} -> arguments
    end
  end

  defp decode_arguments(arguments) when is_map(arguments), do: arguments
  defp decode_arguments(_arguments), do: %{}

  defp emit_response_messages(session, response, run_id) do
    response
    |> model_client_output_texts(session)
    |> Enum.each(fn text ->
      emit_message(session, :notification, %{
        run_id: run_id,
        payload: %{
          "method" => "codex/event/agent_message_delta",
          "params" => %{"textDelta" => text}
        }
      })
    end)
  end

  defp emit_turn_completed(session, response, run_id) do
    emit_message(session, :turn_completed, %{
      run_id: run_id,
      payload: %{
        "id" => response_id(session, response),
        "usage" => Map.get(response, "usage", %{})
      },
      usage: Map.get(response, "usage")
    })
  end

  defp response_result(session, response) do
    %{
      "status" => Map.get(response, "status", "completed"),
      "response_id" => response_id(session, response),
      "output_text" => Enum.join(model_client_output_texts(response, session), "")
    }
  end

  defp response_id(session, response) do
    client = session.model_client
    client.response_id(response)
  end

  defp previous_response_id(%{state: state}) when is_pid(state) do
    Agent.get(state, &Map.get(&1, :previous_response_id))
  catch
    :exit, _reason -> nil
  end

  defp previous_response_id(_session), do: nil

  defp remember_response_id(session, response) do
    case response_id(session, response) do
      id when is_binary(id) ->
        update_session_state(session, :previous_response_id, id)

      _ ->
        :ok
    end
  end

  defp update_session_state(%{state: state}, key, value) when is_pid(state) do
    Agent.update(state, &Map.put(&1, key, value))
  catch
    :exit, _reason -> :ok
  end

  defp update_session_state(_session, _key, _value), do: :ok

  defp emit_message(%{on_message: on_message}, event, details) when is_function(on_message, 1) do
    on_message.(details |> Map.put(:event, event) |> Map.put(:timestamp, DateTime.utc_now()))
  end

  defp emit_message(_session, _event, _details), do: :ok

  defp maybe_put_payload_field(map, _key, nil), do: map
  defp maybe_put_payload_field(map, key, value), do: Map.put(map, key, value)

  defp duration_since(started_at) do
    System.monotonic_time(:millisecond) - started_at
  end

  defp model_client_initial_request(session, due_tasks_payload, work_item) do
    client = session.model_client
    client.initial_request(session, due_tasks_payload, work_item)
  end

  defp model_client_create_response(session, request, attempt) do
    if SessionConfig.cutover_enabled?(session) do
      Cutover.create_response(session, request, attempt)
    else
      client = session.model_client
      client.create_response(session, request, attempt)
    end
  end

  defp model_client_follow_up_request(session, response, tool_outputs) do
    client = session.model_client
    client.follow_up_request(session, response, tool_outputs)
  end

  defp model_client_tool_calls(session, response) do
    client = session.model_client
    client.tool_calls(response)
  end

  defp model_client_output_texts(response, session) do
    client = session.model_client
    client.output_texts(response)
  end
end
