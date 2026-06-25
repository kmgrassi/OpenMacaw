defmodule SymphonyElixir.Runner.Contract do
  @moduledoc """
  Normalized data semantics for `SymphonyElixir.Runner` implementations.

  The runner behavior is the stable execution boundary. This module freezes the
  backend-neutral shapes that callers may depend on while allowing adapters to
  keep backend-specific fields in their session, result, and event maps.
  """

  @type runner_type :: String.t()

  @type coding_input :: String.t() | %{optional(:message) => String.t(), optional(:prompt) => String.t(), optional(String.t()) => term()}

  @type coding_capabilities :: %{
          required(:input) => :turn,
          required(:output_stream) => :runner_events,
          required(:interrupt) => :supported | :unsupported,
          required(:tool_activity) => boolean(),
          optional(:metadata) => map()
        }

  @type session :: %{
          required(:runner) => runner_type(),
          optional(:session_id) => String.t(),
          optional(:provider) => String.t(),
          optional(:model) => String.t(),
          optional(:workspace) => String.t() | nil,
          optional(:backend) => map(),
          optional(:metadata) => map()
        }

  @type result_status :: :completed | :retryable_error | :fatal_error

  @type result :: %{
          required(:status) => result_status(),
          optional(:output_text) => String.t(),
          optional(:usage) => map(),
          optional(:artifact_refs) => [map()],
          optional(:reason) => term(),
          optional(:backend) => map()
        }

  @type event_name ::
          :session_started
          | :turn_started
          | :notification
          | :tool_call_started
          | :tool_call_completed
          | :tool_call_failed
          | :command_started
          | :command_output_delta
          | :command_completed
          | :unsupported_tool_call
          | :patch_apply_begin
          | :patch_apply_end
          | :file_change_pending_approval
          | :approval_requested
          | :approval_resolved
          | :command_started
          | :command_output_delta
          | :command_completed
          | :turn_completed
          | :turn_ended_with_error
          | :startup_failed

  @type event :: %{
          required(:event) => event_name(),
          required(:timestamp) => DateTime.t(),
          optional(:payload) => map(),
          optional(:message) => String.t(),
          optional(:usage) => map(),
          optional(:metadata) => map()
        }

  @event_names [
    :session_started,
    :turn_started,
    :notification,
    :tool_call_started,
    :tool_call_completed,
    :tool_call_failed,
    :command_started,
    :command_output_delta,
    :command_completed,
    :unsupported_tool_call,
    :patch_apply_begin,
    :patch_apply_end,
    :file_change_pending_approval,
    :approval_requested,
    :approval_resolved,
    :command_started,
    :command_output_delta,
    :command_completed,
    :turn_completed,
    :turn_ended_with_error,
    :startup_failed
  ]

  @event_name_strings Map.new(@event_names, &{Atom.to_string(&1), &1})

  @legacy_event_aliases %{
    :turn_failed => :turn_ended_with_error,
    "turn_failed" => :turn_ended_with_error,
    :turn_cancelled => :turn_ended_with_error,
    "turn_cancelled" => :turn_ended_with_error,
    :approval_required => :approval_requested,
    "approval_required" => :approval_requested,
    :approval_auto_approved => :approval_resolved,
    "approval_auto_approved" => :approval_resolved
  }

  @runner_names %{
    SymphonyElixir.Runner.Codex => "codex",
    SymphonyElixir.Runner.Planner => "planner",
    SymphonyElixir.Runner.OpenClaw => "openclaw",
    SymphonyElixir.Runner.OpenClawWS => "openclaw_ws",
    SymphonyElixir.Runner.ComputerUse => "computer_use",
    SymphonyElixir.Runner.LocalRelay => "local_relay",
    SymphonyElixir.Runner.Mock => "mock"
  }

  @doc """
  Returns the stable event vocabulary accepted by runner consumers.
  """
  @spec event_names() :: [event_name()]
  def event_names, do: @event_names

  @doc """
  Builds a backend-neutral coding-runner capability map.
  """
  @spec coding_capabilities(keyword()) :: coding_capabilities()
  def coding_capabilities(opts \\ []) when is_list(opts) do
    %{
      input: Keyword.get(opts, :input, :turn),
      output_stream: Keyword.get(opts, :output_stream, :runner_events),
      interrupt: Keyword.get(opts, :interrupt, :unsupported),
      tool_activity: Keyword.get(opts, :tool_activity, true)
    }
    |> maybe_put(:metadata, Keyword.get(opts, :metadata))
  end

  @doc """
  Normalizes live coding input to a prompt string.
  """
  @spec normalize_coding_input(coding_input()) :: {:ok, String.t()} | {:error, :invalid_coding_input}
  def normalize_coding_input(input) when is_binary(input) do
    input
    |> String.trim()
    |> case do
      "" -> {:error, :invalid_coding_input}
      prompt -> {:ok, prompt}
    end
  end

  def normalize_coding_input(input) when is_map(input) do
    input
    |> first_present([:message, "message", :prompt, "prompt", :text, "text"])
    |> normalize_coding_input()
  end

  def normalize_coding_input(_input), do: {:error, :invalid_coding_input}

  @doc """
  Builds a normalized session view from an adapter session map.

  Adapter-owned fields remain available under `:backend`; callers should depend
  only on the top-level normalized keys.
  """
  @spec normalize_session(map(), runner_type() | atom()) :: session()
  def normalize_session(session, runner) when is_map(session) do
    runner = normalize_runner(runner)

    %{
      runner: runner,
      session_id: first_present(session, [:session_id, "session_id", :thread_id, "thread_id", :run_id, "run_id"]),
      provider: first_present(session, [:provider, "provider"]),
      model: first_present(session, [:model, "model"]),
      workspace: first_present(session, [:workspace, "workspace"]),
      backend: session,
      metadata: first_present(session, [:metadata, "metadata"]) || %{}
    }
    |> reject_nil_values()
  end

  @doc """
  Normalizes a runner callback return into the contract result vocabulary.
  """
  @spec normalize_result({:ok, map()} | {:error, term()}) :: {:ok, result()} | {:error, result()}
  def normalize_result({:ok, result}) when is_map(result) do
    {:ok,
     %{
       status: :completed,
       output_text: first_present(result, [:output_text, "output_text", :output, "output"]),
       usage: first_present(result, [:usage, "usage"]),
       artifact_refs: first_present(result, [:artifact_refs, "artifact_refs"]),
       backend: result
     }
     |> reject_nil_values()}
  end

  def normalize_result({:error, {:retryable, reason}}) do
    {:error, %{status: :retryable_error, reason: reason}}
  end

  def normalize_result({:error, {:fatal, reason}}) do
    {:error, %{status: :fatal_error, reason: reason}}
  end

  def normalize_result({:error, reason}) do
    {:error, %{status: :fatal_error, reason: reason}}
  end

  @doc """
  Normalizes a runner event map.

  Unknown event names are rejected so adapters cannot leak backend vocabulary
  into consumers without an explicit contract update.
  """
  @spec normalize_event(map()) :: {:ok, event()} | {:error, {:unknown_runner_event, term()}}
  def normalize_event(%{event: event} = message) do
    with {:ok, event} <- normalize_event_name(event) do
      normalized =
        message
        |> Map.put(:event, event)
        |> Map.put_new(:timestamp, DateTime.utc_now())
        |> Map.update(:payload, %{}, &normalize_map/1)
        |> Map.update(:metadata, %{}, &normalize_map/1)

      {:ok, normalized}
    end
  end

  def normalize_event(%{"event" => event} = message) do
    message
    |> Map.delete("event")
    |> atomize_known_event_keys()
    |> Map.put(:event, event)
    |> normalize_event()
  end

  def normalize_event(message) when is_map(message), do: {:error, {:unknown_runner_event, nil}}

  defp normalize_event_name(event) do
    cond do
      event in @event_names ->
        {:ok, event}

      Map.has_key?(@legacy_event_aliases, event) ->
        {:ok, Map.fetch!(@legacy_event_aliases, event)}

      is_binary(event) and Map.has_key?(@event_name_strings, event) ->
        {:ok, Map.fetch!(@event_name_strings, event)}

      true ->
        {:error, {:unknown_runner_event, event}}
    end
  end

  defp atomize_known_event_keys(message) do
    Enum.reduce([{"timestamp", :timestamp}, {"payload", :payload}, {"metadata", :metadata}, {"message", :message}, {"usage", :usage}], message, fn {string_key, atom_key}, acc ->
      case Map.fetch(acc, string_key) do
        {:ok, value} -> acc |> Map.delete(string_key) |> Map.put(atom_key, value)
        :error -> acc
      end
    end)
  end

  defp normalize_runner(runner) when is_map_key(@runner_names, runner), do: Map.fetch!(@runner_names, runner)

  defp normalize_runner(runner) when is_atom(runner) do
    runner
    |> Module.split()
    |> List.last()
    |> Macro.underscore()
  end

  defp normalize_runner(runner) when is_binary(runner), do: runner

  defp first_present(map, keys) do
    Enum.find_value(keys, fn key ->
      case Map.fetch(map, key) do
        {:ok, nil} -> nil
        {:ok, value} -> value
        :error -> nil
      end
    end)
  end

  defp normalize_map(value) when is_map(value), do: value
  defp normalize_map(_value), do: %{}

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
