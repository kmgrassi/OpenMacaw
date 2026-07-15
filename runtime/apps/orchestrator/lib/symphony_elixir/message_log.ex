defmodule SymphonyElixir.MessageLog do
  @moduledoc """
  Best-effort Supabase persistence for runtime websocket chat transcripts.

  The runtime writes `session_thread` and `message` rows through PostgREST when
  Supabase credentials are configured. Without credentials, every function
  returns `:disabled` so local websocket development keeps the prior in-memory
  behavior.
  """

  require Logger

  alias SymphonyElixir.{MapUtils, Time}
  alias SymphonyElixir.MessageLog.ToolCalls
  alias SymphonyElixir.PostgRESTClient
  alias SymphonyElixir.Supabase

  @session_table "session_thread"
  @message_table "message"
  @user_table "user"

  @message_select_fields "id,role,content,created_at,metadata,run_id,session_id,user_id,agent_id,workspace_id,message_type,model,provider"
  @message_select_with_tool_calls @message_select_fields <>
                                    ",tool_call(id,message_id,tool_id,input,output)"

  @type scope :: %{
          agent_id: String.t(),
          workspace_id: String.t(),
          session_key: String.t(),
          user_id: String.t()
        }

  @type result :: :ok | :disabled | {:error, term()}

  @spec enabled?() :: boolean()
  def enabled? do
    match?({:ok, _config}, resolve_config())
  end

  @spec list_agent_messages(String.t(), keyword()) ::
          {:ok, list(map()), map()} | :disabled | {:error, term()}
  def list_agent_messages(agent_id, opts \\ []) when is_binary(agent_id) and is_list(opts) do
    with {:ok, config} <- resolve_config() do
      limit = normalize_limit(Keyword.get(opts, :limit))

      query =
        %{
          "select" => message_select(Keyword.get(opts, :include_tool_calls, false)),
          "agent_id" => "eq.#{agent_id}",
          "order" => "created_at.desc,id.desc",
          "limit" => Integer.to_string(limit)
        }
        |> maybe_put_filter("workspace_id", Keyword.get(opts, :workspace_id))
        |> maybe_put_filter("session_id", Keyword.get(opts, :session_id))
        |> maybe_put_cursor(Keyword.get(opts, :before), Keyword.get(opts, :before_id))

      case PostgRESTClient.get(client(config), @message_table, query,
             log_metadata:
               log_metadata("message_log.list_agent_messages", @message_table,
                 agent_id: agent_id,
                 workspace_id: Keyword.get(opts, :workspace_id),
                 session_thread_id: Keyword.get(opts, :session_id)
               )
           ) do
        {:ok, rows} when is_list(rows) ->
          display_names = display_names_for_rows(config, rows)
          messages = Enum.map(rows, &message_payload(&1, display_names))
          {:ok, messages, pagination_payload(messages, limit)}

        {:ok, body} ->
          {:error, {:invalid_response, body}}

        {:error, _reason} = error ->
          error
      end
    end
  end

  @spec list_workspace_messages(String.t(), keyword()) ::
          {:ok, list(map()), map()} | :disabled | {:error, term()}
  def list_workspace_messages(workspace_id, opts \\ [])
      when is_binary(workspace_id) and is_list(opts) do
    with {:ok, config} <- resolve_config() do
      limit = normalize_limit(Keyword.get(opts, :limit))

      query =
        %{
          "select" => message_select(Keyword.get(opts, :include_tool_calls, false)),
          "workspace_id" => "eq.#{workspace_id}",
          "order" => "created_at.desc,id.desc",
          "limit" => Integer.to_string(limit)
        }
        |> maybe_put_filter("agent_id", Keyword.get(opts, :agent_id))
        |> maybe_put_filter("session_id", Keyword.get(opts, :session_id))
        |> maybe_put_cursor(Keyword.get(opts, :before), Keyword.get(opts, :before_id))

      case PostgRESTClient.get(client(config), @message_table, query,
             log_metadata:
               log_metadata("message_log.list_workspace_messages", @message_table,
                 workspace_id: workspace_id,
                 agent_id: Keyword.get(opts, :agent_id),
                 session_thread_id: Keyword.get(opts, :session_id)
               )
           ) do
        {:ok, rows} when is_list(rows) ->
          display_names = display_names_for_rows(config, rows)
          messages = Enum.map(rows, &message_payload(&1, display_names))
          {:ok, messages, pagination_payload(messages, limit)}

        {:ok, body} ->
          {:error, {:invalid_response, body}}

        {:error, _reason} = error ->
          error
      end
    end
  end

  @spec resolve_user_display_names([String.t()]) ::
          {:ok, %{String.t() => String.t()}} | :disabled | {:error, term()}
  def resolve_user_display_names(user_ids) when is_list(user_ids) do
    with {:ok, config} <- resolve_config() do
      fetch_user_display_names(config, user_ids)
    end
  end

  @spec upsert_session_thread(scope(), keyword()) ::
          {:ok, String.t()} | :disabled | {:error, term()}
  def upsert_session_thread(scope, opts \\ []) when is_map(scope) and is_list(opts) do
    with {:ok, config} <- resolve_config(),
         {:ok, thread_id} <- fetch_session_thread(config, scope) do
      patch_session_thread(config, thread_id, scope, opts)
    end
  end

  @spec record_user_message(scope(), String.t(), String.t(), keyword()) :: result()
  def record_user_message(scope, session_thread_id, content, opts \\ [])
      when is_map(scope) and is_binary(session_thread_id) and is_binary(content) and is_list(opts) do
    insert_message(scope, session_thread_id, :user, content, opts)
  end

  @spec record_assistant_message(scope(), String.t(), String.t(), String.t() | nil, map()) ::
          result()
  def record_assistant_message(scope, session_thread_id, content, run_id, metadata \\ %{})
      when is_map(scope) and is_binary(session_thread_id) and is_binary(content) and
             is_map(metadata) do
    record_assistant_message(scope, session_thread_id, content, run_id, metadata, [])
  end

  @spec record_assistant_message(
          scope(),
          String.t(),
          String.t(),
          String.t() | nil,
          map(),
          keyword()
        ) ::
          result()
  def record_assistant_message(scope, session_thread_id, content, run_id, metadata, opts)
      when is_map(scope) and is_binary(session_thread_id) and is_binary(content) and
             is_map(metadata) and is_list(opts) do
    insert_message(scope, session_thread_id, :assistant, content,
      run_id: run_id,
      metadata: metadata,
      tool_calls: Keyword.get(opts, :tool_calls, [])
    )
  end

  @doc false
  def req_options, do: Application.get_env(:symphony_elixir, :message_log_req_options, [])

  defp fetch_session_thread(config, scope) do
    query =
      %{
        "select" => "id",
        "agent_id" => "eq.#{scope.agent_id}",
        "workspace_id" => "eq.#{scope.workspace_id}",
        "session_key" => "eq.#{scope.session_key}",
        "limit" => "1"
      }

    case PostgRESTClient.get(client(config), @session_table, query, log_metadata: scope_log_metadata(scope, "message_log.fetch_session_thread", @session_table)) do
      {:ok, [%{"id" => thread_id} | _]} when is_binary(thread_id) ->
        {:ok, thread_id}

      {:ok, []} ->
        create_session_thread(config, scope)

      {:ok, body} ->
        {:error, {:invalid_response, body}}

      {:error, _reason} = error ->
        error
    end
  end

  defp create_session_thread(config, scope) do
    payload =
      %{
        "agent_id" => scope.agent_id,
        "workspace_id" => scope.workspace_id,
        "user_id" => nil,
        "session_key" => scope.session_key,
        "status" => "active",
        "origin" => %{"source" => "runtime_gateway"},
        "metadata" => %{"runtime_session_key" => scope.session_key}
      }

    case PostgRESTClient.post(client(config), @session_table, payload,
           prefer: "return=representation",
           query: %{"select" => "id"},
           log_metadata: scope_log_metadata(scope, "message_log.create_session_thread", @session_table)
         ) do
      {:ok, [%{"id" => thread_id} | _]} when is_binary(thread_id) ->
        {:ok, thread_id}

      {:ok, body} ->
        {:error, {:invalid_response, body}}

      {:error, _reason} = error ->
        error
    end
  end

  defp patch_session_thread(config, thread_id, scope, opts) do
    payload =
      %{
        "label" => Keyword.get(opts, :label),
        "model" => Keyword.get(opts, :model),
        "updated_at" => Time.now_iso8601(truncate: :second)
      }
      |> MapUtils.drop_nil_values()

    if map_size(payload) == 0 do
      {:ok, thread_id}
    else
      case PostgRESTClient.patch(
             client(config),
             @session_table,
             %{"id" => "eq.#{thread_id}"},
             payload,
             prefer: "return=minimal",
             log_metadata: scope_log_metadata(scope, "message_log.patch_session_thread", @session_table, session_thread_id: thread_id)
           ) do
        {:ok, _body} -> {:ok, thread_id}
        {:error, _reason} = error -> error
      end
    end
  end

  defp insert_message(scope, session_thread_id, role, content, opts) do
    with {:ok, config} <- resolve_config() do
      metadata = Keyword.get(opts, :metadata, %{})

      payload =
        %{
          "session_id" => session_thread_id,
          "workspace_id" => scope.workspace_id,
          "agent_id" => scope.agent_id,
          "user_id" => scope.user_id,
          "run_id" => Keyword.get(opts, :run_id),
          "role" => Atom.to_string(role),
          "content" => content,
          "model" => extract_string(metadata, "model"),
          "provider" => extract_string(metadata, "provider"),
          "message_type" => "chat",
          "metadata" => Map.drop(metadata, ["model", :model, "provider", :provider])
        }
        |> MapUtils.drop_nil_values()

      tool_calls = Keyword.get(opts, :tool_calls, [])

      if role == :assistant and tool_calls != [] do
        insert_message_with_tool_calls(
          config,
          scope,
          session_thread_id,
          payload,
          opts,
          tool_calls
        )
      else
        case PostgRESTClient.post(client(config), @message_table, payload,
               prefer: "return=minimal",
               log_metadata:
                 scope_log_metadata(scope, "message_log.record_#{role}_message", @message_table,
                   session_thread_id: session_thread_id,
                   run_id: Keyword.get(opts, :run_id)
                 )
             ) do
          {:ok, _body} -> :ok
          {:error, _reason} = error -> error
        end
      end
    end
  end

  defp insert_message_with_tool_calls(config, scope, session_thread_id, payload, opts, tool_calls) do
    case PostgRESTClient.post(client(config), @message_table, payload,
           prefer: "return=representation",
           query: %{"select" => "id"},
           log_metadata:
             scope_log_metadata(scope, "message_log.record_assistant_message", @message_table,
               session_thread_id: session_thread_id,
               run_id: Keyword.get(opts, :run_id)
             )
         ) do
      {:ok, [%{"id" => message_id} | _]} when is_binary(message_id) ->
        ToolCalls.record(
          config,
          scope,
          session_thread_id,
          message_id,
          Keyword.get(opts, :run_id),
          tool_calls,
          req_options()
        )

        :ok

      {:ok, body} ->
        {:error, {:invalid_response, body}}

      {:error, _reason} = error ->
        error
    end
  end

  # Pulls a string value out of a metadata map regardless of whether
  # gateway_socket passed an atom-keyed or string-keyed entry.
  defp extract_string(metadata, key) do
    value = Map.get(metadata, key) || Map.get(metadata, String.to_atom(to_string(key)))

    case value do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  end

  defp message_payload(row, display_names) when is_map(row) and is_map(display_names) do
    user_id = row["user_id"]

    %{
      "id" => row["id"],
      "role" => row["role"],
      "content" => row["content"],
      "created_at" => row["created_at"],
      "createdAt" => unix_ms(row["created_at"]),
      "metadata" => row["metadata"] || %{},
      "model" => row["model"],
      "provider" => row["provider"],
      "run_id" => row["run_id"],
      "session_id" => row["session_id"],
      "user_id" => user_id,
      "speaker_display_name" => speaker_display_name(row["role"], user_id, display_names),
      "agent_id" => row["agent_id"],
      "workspace_id" => row["workspace_id"],
      "message_type" => row["message_type"],
      "tool_calls" => related_tool_calls(row)
    }
    |> MapUtils.drop_nil_values()
  end

  defp related_tool_calls(row) do
    case Map.get(row, "tool_call") || Map.get(row, "tool_calls") do
      calls when is_list(calls) -> calls
      _ -> nil
    end
  end

  defp speaker_display_name("user", user_id, display_names), do: Map.get(display_names, user_id)
  defp speaker_display_name(_role, _user_id, _display_names), do: nil

  defp display_names_for_rows(config, rows) do
    user_ids =
      rows
      |> Enum.filter(&(Map.get(&1, "role") == "user"))
      |> Enum.map(&Map.get(&1, "user_id"))
      |> normalize_user_ids()

    case fetch_user_display_names(config, user_ids) do
      {:ok, display_names} ->
        display_names

      {:error, reason} ->
        Logger.warning("message_log.resolve_user_display_names failed reason=#{inspect(reason)}")
        %{}
    end
  end

  defp fetch_user_display_names(_config, []), do: {:ok, %{}}

  defp fetch_user_display_names(config, user_ids) when is_list(user_ids) do
    ids = normalize_user_ids(user_ids)

    if ids == [] do
      {:ok, %{}}
    else
      query = %{
        "select" => "id,full_name,first_name,last_name,email",
        "id" => "in.(#{Enum.join(ids, ",")})"
      }

      case PostgRESTClient.get(client(config), @user_table, query, log_metadata: log_metadata("message_log.resolve_user_display_names", @user_table, user_count: length(ids))) do
        {:ok, rows} when is_list(rows) ->
          {:ok, display_name_map(rows)}

        {:ok, body} ->
          {:error, {:invalid_response, body}}

        {:error, _reason} = error ->
          error
      end
    end
  end

  defp normalize_user_ids(user_ids) do
    user_ids
    |> Enum.filter(&(is_binary(&1) and &1 != ""))
    |> Enum.uniq()
  end

  defp display_name_map(rows) do
    rows
    |> Enum.reduce(%{}, fn
      %{"id" => id} = row, acc when is_binary(id) ->
        case user_display_name(row) do
          nil -> acc
          display_name -> Map.put(acc, id, display_name)
        end

      _row, acc ->
        acc
    end)
  end

  defp user_display_name(row) do
    [
      Map.get(row, "full_name"),
      [Map.get(row, "first_name"), Map.get(row, "last_name")]
      |> Enum.filter(&(is_binary(&1) and String.trim(&1) != ""))
      |> Enum.join(" "),
      Map.get(row, "email")
    ]
    |> Enum.find_value(fn
      value when is_binary(value) ->
        case String.trim(value) do
          "" -> nil
          trimmed -> trimmed
        end

      _value ->
        nil
    end)
  end

  defp pagination_payload(messages, limit) do
    last_message = List.last(messages)
    next_before = last_message && Map.get(last_message, "created_at")
    next_before_id = last_message && Map.get(last_message, "id")

    %{
      limit: limit,
      count: length(messages),
      next_before: if(length(messages) == limit, do: next_before),
      next_before_id: if(length(messages) == limit, do: next_before_id)
    }
    |> MapUtils.drop_nil_values()
  end

  defp resolve_config do
    config =
      :symphony_elixir
      |> Application.get_env(:message_log, [])
      |> Enum.into(%{})

    endpoint =
      Map.get(config, :endpoint) ||
        system_env("LAUNCHER_SUPABASE_URL") ||
        system_env("SUPABASE_URL")

    api_key =
      Map.get(config, :api_key) ||
        system_env("LAUNCHER_SUPABASE_SERVICE_KEY") ||
        system_env("SUPABASE_SERVICE_ROLE_KEY")

    cond do
      not is_binary(endpoint) or endpoint == "" ->
        :disabled

      not is_binary(api_key) or api_key == "" ->
        :disabled

      true ->
        {:ok,
         config
         |> Map.put(:endpoint, Supabase.rest_endpoint!(endpoint: endpoint))
         |> Map.put(:api_key, api_key)}
    end
  rescue
    error in [ArgumentError] ->
      Logger.debug("MessageLog disabled: #{Exception.message(error)}")
      :disabled
  end

  defp maybe_put_filter(query, _key, value) when value in [nil, ""], do: query

  defp maybe_put_filter(query, key, value) when is_binary(value) do
    Map.put(query, key, "eq.#{value}")
  end

  defp maybe_put_cursor(query, before, _before_id) when before in [nil, ""], do: query

  defp maybe_put_cursor(query, before, before_id)
       when is_binary(before) and is_binary(before_id) and before_id != "" do
    Map.put(
      query,
      "or",
      "(created_at.lt.#{before},and(created_at.eq.#{before},id.lt.#{before_id}))"
    )
  end

  defp maybe_put_cursor(query, before, _before_id) when is_binary(before) do
    Map.put(query, "created_at", "lt.#{before}")
  end

  defp normalize_limit(limit) when is_integer(limit), do: limit |> max(1) |> min(200)

  defp normalize_limit(limit) when is_binary(limit) do
    case Integer.parse(limit) do
      {parsed, ""} -> normalize_limit(parsed)
      _ -> 50
    end
  end

  defp normalize_limit(_limit), do: 50

  defp message_select(true), do: @message_select_with_tool_calls
  defp message_select(_include_tool_calls), do: @message_select_fields

  defp unix_ms(value) when is_binary(value) do
    case Time.parse_iso8601(value) do
      %DateTime{} = datetime -> DateTime.to_unix(datetime, :millisecond)
      nil -> nil
    end
  end

  defp unix_ms(_value), do: nil

  defp system_env(name) do
    case System.get_env(name) do
      nil -> nil
      "" -> nil
      value -> value
    end
  end

  defp client(config), do: PostgRESTClient.new(config, req_options())

  defp scope_log_metadata(scope, caller, table, extra \\ []) do
    base =
      %{
        caller: caller,
        action: caller,
        table: table,
        agent_id: Map.get(scope, :agent_id) || Map.get(scope, "agent_id"),
        workspace_id: Map.get(scope, :workspace_id) || Map.get(scope, "workspace_id"),
        session_key: Map.get(scope, :session_key) || Map.get(scope, "session_key")
      }

    extra
    |> Map.new()
    |> Map.merge(base)
    |> MapUtils.drop_nil_values()
  end

  defp log_metadata(caller, table, extra) do
    extra
    |> Map.new()
    |> Map.merge(%{caller: caller, action: caller, table: table})
    |> MapUtils.drop_nil_values()
  end
end
