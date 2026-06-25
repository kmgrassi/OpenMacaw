defmodule SymphonyElixir.Runner.Codex do
  @moduledoc """
  Runner adapter for OpenAI Codex app-server.

  Executes work items by spawning a Codex subprocess in a workspace directory
  and communicating via JSON-RPC over stdin/stdout.

  Delegates to `SymphonyElixir.Codex.AppServer` for the actual protocol handling.

  ## Configuration

      runner:
        type: codex
        command: "codex --config ... app-server"
        approval_policy: never
        thread_sandbox: workspace-write

  ## Workspace requirement

  Codex requires a workspace directory with the repository cloned into it.
  `requires_workspace?/0` returns `true`.
  """

  @behaviour SymphonyElixir.Runner
  @behaviour SymphonyElixir.Runner.CodingRunner

  alias SymphonyElixir.Cutover
  alias SymphonyElixir.Codex.AppServer
  alias SymphonyElixir.Runner.Contract
  alias SymphonyElixir.Runner.Observability
  alias SymphonyElixir.Runner.SkillMaterializer
  alias SymphonyElixir.Runner.WorkerBridgeRouting

  @impl true
  def start_session(config, workspace) do
    cond do
      probe_only?(config) ->
        with :ok <- ping(config) do
          {:ok, %{probe_only: true, runner: "codex"}}
        end

      WorkerBridgeRouting.container_target?(config) ->
        WorkerBridgeRouting.start_session("codex", config, workspace)

      true ->
        opts = session_opts(config)

        with :ok <- SkillMaterializer.materialize("codex", config, workspace),
             {:ok, session} <- AppServer.start_session(workspace, opts) do
          {:ok,
           session
           |> Map.put(:runner_config, config)
           |> Map.put(:fallbacks, Map.get(config, "fallbacks") || Map.get(config, :fallbacks) || [])}
        end
    end
  end

  @impl true
  def run_turn(session, prompt, work_item) do
    if Map.get(session, :worker_bridge) do
      WorkerBridgeRouting.run_turn(session, "codex")
    else
      Cutover.walk_session(session, :codex, fn link_session, attempt ->
        run_turn_link(link_session, prompt, work_item, attempt)
      end)
    end
  end

  @impl SymphonyElixir.Runner.CodingRunner
  def send_input(session, input, work_item, opts) when is_map(session) and is_list(opts) do
    with {:ok, prompt} <- Contract.normalize_coding_input(input) do
      session
      |> maybe_put_on_message(Keyword.get(opts, :on_message))
      |> run_turn(prompt, work_item)
    end
  end

  @impl SymphonyElixir.Runner.CodingRunner
  def interrupt(_session, _opts), do: {:error, :interrupt_not_supported}

  @impl SymphonyElixir.Runner.CodingRunner
  def stream_capabilities do
    Contract.coding_capabilities(
      input: :turn,
      output_stream: :runner_events,
      interrupt: :unsupported,
      tool_activity: true,
      metadata: %{backend: "codex_app_server"}
    )
  end

  @impl true
  def stop_session(%{probe_only: true}), do: :ok
  def stop_session(%{worker_bridge: true} = session), do: WorkerBridgeRouting.stop_session(session)

  def stop_session(session) do
    AppServer.stop_session(session)
  end

  @impl true
  def ping(_config) do
    case System.find_executable("codex") do
      nil -> {:error, :codex_not_found}
      _path -> :ok
    end
  end

  @impl true
  def requires_workspace?, do: true

  @spec classify_error(term()) :: map()
  def classify_error({:rpc_error, %{"code" => code} = payload}) when is_integer(code) do
    classify_error(Map.put(payload, "status", code))
  end

  def classify_error(%{"status" => status} = payload) when is_integer(status) do
    error_code =
      cond do
        status == 429 -> "provider_rate_limited"
        status in [500, 502, 503, 504] -> "provider_overloaded"
        true -> "provider_unknown"
      end

    %{
      error_code: error_code,
      retryable: error_code in ["provider_rate_limited", "provider_overloaded"],
      status_code: status,
      reason: Map.get(payload, "message") || Map.get(payload, "error") || inspect(payload)
    }
  end

  def classify_error(reason) do
    text = reason |> inspect() |> String.downcase()

    cond do
      String.contains?(text, "429") or String.contains?(text, "rate") ->
        %{error_code: "provider_rate_limited", retryable: true, reason: inspect(reason)}

      String.contains?(text, "500") or String.contains?(text, "502") or String.contains?(text, "503") or
          String.contains?(text, "504") ->
        %{error_code: "provider_overloaded", retryable: true, reason: inspect(reason)}

      true ->
        %{error_code: "provider_unknown", retryable: true, reason: inspect(reason)}
    end
  end

  defp run_turn_link(session, prompt, work_item, attempt) do
    opts = turn_opts(session)

    case app_server_module(session).run_turn(session, prompt, work_item, opts) do
      {:ok, _result} = success ->
        success

      {:error, reason} ->
        failure =
          reason
          |> classify_error()
          |> Map.merge(provider_context(session, work_item, attempt))
          |> Map.put(:event, "model_call_failed")

        Observability.log_provider_failure(failure)
        Cutover.classified_failure(failure, reason)
    end
  end

  defp session_opts(config) do
    opts = []
    opts = if config[:worker_host], do: Keyword.put(opts, :worker_host, config[:worker_host]), else: opts
    opts = if config[:trace_id], do: Keyword.put(opts, :trace_id, config[:trace_id]), else: opts
    Keyword.put(opts, :runner_config, config)
  end

  defp turn_opts(session) do
    opts = []
    opts = if session[:on_message], do: Keyword.put(opts, :on_message, session[:on_message]), else: opts
    opts = if session[:trace_id], do: Keyword.put(opts, :trace_id, session[:trace_id]), else: opts
    opts = if session[:runner_config], do: Keyword.put(opts, :runner_config, session[:runner_config]), else: opts
    opts
  end

  defp app_server_module(session), do: Map.get(session, :app_server_module, AppServer)

  defp maybe_put_on_message(session, nil), do: session
  defp maybe_put_on_message(session, on_message) when is_function(on_message, 1), do: Map.put(session, :on_message, on_message)
  defp maybe_put_on_message(session, _on_message), do: session

  defp provider_context(session, work_item, attempt) do
    %{
      provider: Map.get(session, :model_provider) || Map.get(session, :provider) || "openai_codex",
      model: Map.get(session, :model),
      runner_kind: "codex",
      workspace_id: Map.get(session, :workspace_id),
      agent_id: Map.get(session, :agent_id),
      trace_id: Map.get(session, :trace_id),
      run_id: Map.get(work_item, :id),
      turn_id: Map.get(session, :turn_id),
      attempt: attempt
    }
  end

  defp probe_only?(config) when is_map(config), do: config[:probe_only] == true or config["probe_only"] == true
  defp probe_only?(_config), do: false
end
