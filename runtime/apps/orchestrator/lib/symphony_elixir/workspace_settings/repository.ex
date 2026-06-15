defmodule SymphonyElixir.WorkspaceSettings.Repository do
  @moduledoc """
  Reads from the `workspace_settings` table that the platform's
  per-workspace settings UI writes to (harper-server migration
  `20260518160000_create_workspace_settings_table.sql`).

  Service-role PostgREST client — bypasses RLS, which is intentional:
  the runtime needs to read these settings even when no user is in the
  request context (the reflection-enqueue path runs after every agent
  run completes, not on behalf of an authenticated user).

  ## Default-off, opt-in

  The platform service treats an absent row as "use column defaults"
  (`learning_enabled = false`). This module mirrors that behavior:
  `learning_enabled?/2` returns `{:ok, false}` when no row exists.

  ## Fail-open on transient errors

  When the read fails (Supabase unreachable, schema not ready, etc.),
  `learning_enabled?/2` returns `{:error, reason}`. Callers should
  decide whether to fall open or closed; the `ReflectionDispatcher`
  still fails open with a warning log so a transient Supabase blip does
  not silently disable memory for already-enabled workspaces.
  """

  alias SymphonyElixir.{PostgRESTClient, Supabase, SupabaseSchema, Time}

  @table "workspace_settings"
  @default_max_concurrent_agents 10
  @max_concurrent_agents_hard_limit 50
  @settings_columns ~w(learning_enabled tracker_kind tracker_credential_id max_concurrent_agents)
  @supported_tracker_kinds ~w(linear memory database github api)
  @credential_tracker_kinds ~w(linear github)
  @required_columns ~w(workspace_id learning_enabled tracker_kind tracker_credential_id max_concurrent_agents updated_at updated_by_user_id)

  @type row :: %{
          optional(String.t()) => term()
        }

  @spec learning_enabled?(String.t(), keyword()) :: {:ok, boolean()} | {:error, term()}
  def learning_enabled?(workspace_id, opts \\ [])

  def learning_enabled?(workspace_id, opts) when is_binary(workspace_id) and workspace_id != "" do
    query = %{
      "workspace_id" => "eq.#{workspace_id}",
      "select" => "learning_enabled",
      "limit" => "1"
    }

    with {:ok, client} <- client(opts) do
      case get(client, table(opts), query, "workspace_settings.learning_enabled") do
        {:ok, [%{"learning_enabled" => value}]} when is_boolean(value) ->
          {:ok, value}

        {:ok, []} ->
          {:ok, false}

        {:ok, _rows} ->
          {:error, :invalid_workspace_settings_response}

        {:error, _reason} = error ->
          error
      end
    end
  end

  def learning_enabled?(_workspace_id, _opts), do: {:error, :missing_workspace_id}

  @spec max_concurrent_agents(String.t(), keyword()) :: {:ok, pos_integer()} | {:error, term()}
  def max_concurrent_agents(workspace_id, opts \\ [])

  def max_concurrent_agents(workspace_id, opts)
      when is_binary(workspace_id) and workspace_id != "" do
    query = %{
      "workspace_id" => "eq.#{workspace_id}",
      "select" => "max_concurrent_agents",
      "limit" => "1"
    }

    with {:ok, client} <- client(opts) do
      case get(client, table(opts), query, "workspace_settings.max_concurrent_agents") do
        {:ok, [%{"max_concurrent_agents" => value}]} ->
          validate_max_concurrent_agents(value)

        {:ok, []} ->
          {:ok, @default_max_concurrent_agents}

        {:ok, _rows} ->
          {:error, :invalid_workspace_settings_response}

        {:error, _reason} = error ->
          error
      end
    end
  end

  def max_concurrent_agents(_workspace_id, _opts), do: {:error, :missing_workspace_id}

  @spec read(String.t(), keyword()) :: {:ok, row()} | {:error, term()}
  def read(workspace_id, opts \\ [])

  def read(workspace_id, opts) when is_binary(workspace_id) and workspace_id != "" do
    query = %{
      "workspace_id" => "eq.#{workspace_id}",
      "select" =>
        "workspace_id,learning_enabled,tracker_kind,tracker_credential_id,max_concurrent_agents,updated_at,updated_by_user_id",
      "limit" => "1"
    }

    with {:ok, client} <- client(opts) do
      case get(client, table(opts), query, "workspace_settings.read") do
        {:ok, [row]} when is_map(row) -> normalize_read_row(row)
        {:ok, []} -> {:ok, default_row(workspace_id)}
        {:ok, _rows} -> {:error, :invalid_workspace_settings_response}
        {:error, _reason} = error -> error
      end
    end
  end

  def read(_workspace_id, _opts), do: {:error, :missing_workspace_id}

  @spec tracker_settings(String.t(), keyword()) :: {:ok, row()} | {:error, term()}
  def tracker_settings(workspace_id, opts \\ [])

  def tracker_settings(workspace_id, opts) when is_binary(workspace_id) and workspace_id != "" do
    query = %{
      "workspace_id" => "eq.#{workspace_id}",
      "select" => "workspace_id,tracker_kind,tracker_credential_id",
      "limit" => "1"
    }

    with {:ok, client} <- client(opts) do
      case get(client, table(opts), query, "workspace_settings.tracker_settings") do
        {:ok, [row]} when is_map(row) -> {:ok, Map.put(row, "exists", true)}
        {:ok, []} -> {:ok, default_row(workspace_id)}
        {:ok, _rows} -> {:error, :invalid_workspace_settings_response}
        {:error, _reason} = error -> error
      end
    end
  end

  def tracker_settings(_workspace_id, _opts), do: {:error, :missing_workspace_id}

  @spec create(String.t(), map(), keyword()) :: {:ok, row()} | {:error, term()}
  def create(workspace_id, settings, opts \\ [])

  def create(workspace_id, settings, opts)
      when is_binary(workspace_id) and workspace_id != "" and is_map(settings) do
    with {:ok, payload} <- write_payload(workspace_id, settings, opts),
         {:ok, client} <- client(opts) do
      case PostgRESTClient.post(client, table(opts), payload,
             prefer: "return=representation",
             log_metadata: log_metadata("workspace_settings.create")
           ) do
        {:ok, [row]} when is_map(row) -> {:ok, Map.put(row, "exists", true)}
        {:ok, _body} -> {:error, :invalid_workspace_settings_response}
        {:error, _reason} = error -> error
      end
    end
  end

  def create(_workspace_id, _settings, _opts), do: {:error, :invalid_workspace_settings_create}

  @spec update(String.t(), map(), keyword()) :: {:ok, row()} | {:error, term()}
  def update(workspace_id, settings, opts \\ [])

  def update(workspace_id, settings, opts)
      when is_binary(workspace_id) and workspace_id != "" and is_map(settings) do
    with {:ok, payload} <- write_payload(nil, settings, opts),
         {:ok, client} <- client(opts) do
      query = %{"workspace_id" => "eq.#{workspace_id}", "limit" => "1"}

      case PostgRESTClient.patch(client, table(opts), query, payload,
             prefer: "return=representation",
             log_metadata: log_metadata("workspace_settings.update")
           ) do
        {:ok, [row]} when is_map(row) -> {:ok, Map.put(row, "exists", true)}
        {:ok, []} -> {:error, :workspace_settings_not_found}
        {:ok, _body} -> {:error, :invalid_workspace_settings_response}
        {:error, _reason} = error -> error
      end
    end
  end

  def update(_workspace_id, _settings, _opts), do: {:error, :invalid_workspace_settings_update}

  @spec upsert(String.t(), map(), keyword()) :: {:ok, row()} | {:error, term()}
  def upsert(workspace_id, settings, opts \\ [])

  def upsert(workspace_id, settings, opts)
      when is_binary(workspace_id) and workspace_id != "" and is_map(settings) do
    with {:ok, payload} <- write_payload(workspace_id, settings, opts),
         {:ok, client} <- client(opts) do
      case PostgRESTClient.upsert(client, table(opts), payload, "workspace_id",
             prefer: "resolution=merge-duplicates,return=representation",
             log_metadata: log_metadata("workspace_settings.upsert")
           ) do
        {:ok, [row]} when is_map(row) -> {:ok, Map.put(row, "exists", true)}
        {:ok, _body} -> {:error, :invalid_workspace_settings_response}
        {:error, _reason} = error -> error
      end
    end
  end

  def upsert(_workspace_id, _settings, _opts), do: {:error, :invalid_workspace_settings_upsert}

  @spec delete(String.t(), keyword()) :: {:ok, map()} | {:error, term()}
  def delete(workspace_id, opts \\ [])

  def delete(workspace_id, opts) when is_binary(workspace_id) and workspace_id != "" do
    query = %{"workspace_id" => "eq.#{workspace_id}", "limit" => "1"}

    with {:ok, client} <- client(opts) do
      case PostgRESTClient.delete(client, table(opts), query,
             prefer: "return=representation",
             log_metadata: log_metadata("workspace_settings.delete")
           ) do
        {:ok, [row]} when is_map(row) -> {:ok, %{"deleted" => true, "settings" => row}}
        {:ok, []} -> {:ok, %{"deleted" => false, "settings" => default_row(workspace_id)}}
        {:ok, _body} -> {:error, :invalid_workspace_settings_response}
        {:error, _reason} = error -> error
      end
    end
  end

  def delete(_workspace_id, _opts), do: {:error, :missing_workspace_id}

  @spec update_tracker_kind(String.t(), String.t(), String.t() | nil, keyword()) ::
          {:ok, row()} | {:error, term()}
  def update_tracker_kind(workspace_id, tracker_kind, credential_id, opts \\ [])

  def update_tracker_kind(workspace_id, tracker_kind, credential_id, opts)
      when is_binary(workspace_id) and workspace_id != "" do
    with {:ok, settings} <- tracker_settings_payload(tracker_kind, credential_id) do
      upsert(workspace_id, settings, opts)
    end
  end

  def update_tracker_kind(_workspace_id, _tracker_kind, _credential_id, _opts),
    do: {:error, :missing_workspace_id}

  @doc false
  def req_options,
    do: Application.get_env(:symphony_elixir, :workspace_settings_repository_req_options, [])

  @doc false
  def default_max_concurrent_agents, do: @default_max_concurrent_agents

  @doc false
  def configured? do
    match?({:ok, _}, Supabase.rest_endpoint()) and match?({:ok, _}, Supabase.service_role_key())
  end

  @doc false
  @spec schema_ready?() :: boolean()
  def schema_ready? do
    Enum.all?(@required_columns, &SupabaseSchema.column?(@table, &1))
  end

  defp get(client, table, query, caller) do
    case PostgRESTClient.get(client, table, query, log_metadata: log_metadata(caller)) do
      {:ok, rows} when is_list(rows) -> {:ok, rows}
      {:ok, _body} -> {:error, :invalid_response}
      {:error, _reason} = error -> error
    end
  end

  defp write_payload(workspace_id, settings, opts) do
    allowed_settings = Map.take(stringify_keys(settings), @settings_columns)

    cond do
      map_size(allowed_settings) == 0 ->
        {:error, {:missing_workspace_settings_fields, @settings_columns}}

      invalid_fields = invalid_settings_fields(allowed_settings) ->
        {:error, {:invalid_workspace_settings_fields, invalid_fields}}

      true ->
        payload =
          allowed_settings
          |> maybe_put("workspace_id", workspace_id)
          |> maybe_put("updated_by_user_id", updated_by_user_id(settings, opts))
          |> Map.put("updated_at", Time.now_iso8601(truncate: :second))

        {:ok, payload}
    end
  end

  defp updated_by_user_id(settings, opts) do
    Map.get(settings, "updated_by_user_id") ||
      Map.get(settings, :updated_by_user_id) ||
      Keyword.get(opts, :updated_by_user_id) ||
      Keyword.get(opts, :actor_user_id)
  end

  defp default_row(workspace_id) do
    %{
      "workspace_id" => workspace_id,
      "learning_enabled" => false,
      "tracker_kind" => "database",
      "tracker_credential_id" => nil,
      "max_concurrent_agents" => @default_max_concurrent_agents,
      "updated_at" => nil,
      "updated_by_user_id" => nil,
      "exists" => false
    }
  end

  defp normalize_read_row(row) do
    with {:ok, max_concurrent_agents} <-
           validate_max_concurrent_agents(Map.get(row, "max_concurrent_agents")) do
      {:ok,
       row
       |> Map.put("max_concurrent_agents", max_concurrent_agents)
       |> Map.put("exists", true)}
    end
  end

  defp stringify_keys(map) do
    Enum.reduce(map, %{}, fn
      {key, value}, acc when is_atom(key) -> Map.put(acc, Atom.to_string(key), value)
      {key, value}, acc -> Map.put(acc, key, value)
    end)
  end

  defp tracker_settings_payload(tracker_kind, credential_id) do
    tracker_kind = normalize_blank(tracker_kind)
    credential_id = normalize_blank(credential_id)

    cond do
      tracker_kind not in @supported_tracker_kinds ->
        {:error, {:unsupported_tracker_kind, tracker_kind, @supported_tracker_kinds}}

      tracker_kind in @credential_tracker_kinds and is_nil(credential_id) ->
        {:error, {:missing_tracker_credential_id, tracker_kind}}

      not is_nil(credential_id) and not uuid?(credential_id) ->
        {:error, {:invalid_tracker_credential_id, credential_id}}

      tracker_kind not in @credential_tracker_kinds and not is_nil(credential_id) ->
        {:error, {:tracker_credential_not_supported, tracker_kind}}

      true ->
        {:ok,
         %{
           "tracker_kind" => tracker_kind,
           "tracker_credential_id" => credential_id
         }}
    end
  end

  defp invalid_settings_fields(settings) do
    settings
    |> Enum.reduce(%{}, fn
      {"learning_enabled", value}, errors when not is_boolean(value) ->
        Map.put(errors, "learning_enabled", "must be a boolean")

      {"tracker_kind", value}, errors when value not in @supported_tracker_kinds ->
        Map.put(
          errors,
          "tracker_kind",
          "must be one of #{Enum.join(@supported_tracker_kinds, ", ")}"
        )

      {"tracker_credential_id", value}, errors ->
        if is_nil(value) or uuid?(value) do
          errors
        else
          Map.put(errors, "tracker_credential_id", "must be a UUID or null")
        end

      {"max_concurrent_agents", value}, errors ->
        case validate_max_concurrent_agents(value) do
          {:ok, _value} ->
            errors

          {:error, reason} ->
            Map.put(errors, "max_concurrent_agents", format_max_concurrent_agents_error(reason))
        end

      _field, errors ->
        errors
    end)
    |> case do
      errors when map_size(errors) == 0 -> nil
      errors -> errors
    end
  end

  defp normalize_blank(value) when is_binary(value) do
    case String.trim(value) do
      "" -> nil
      trimmed -> trimmed
    end
  end

  defp normalize_blank(value), do: value

  defp uuid?(value) when is_binary(value) do
    Regex.match?(
      ~r/\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}\z/,
      value
    )
  end

  defp uuid?(_value), do: false

  defp validate_max_concurrent_agents(value)
       when is_integer(value) and value >= 1 and value <= @max_concurrent_agents_hard_limit,
       do: {:ok, value}

  defp validate_max_concurrent_agents(value) when is_integer(value) and value < 1 do
    {:error, {:invalid_max_concurrent_agents, value, :below_minimum, 1}}
  end

  defp validate_max_concurrent_agents(value)
       when is_integer(value) and value > @max_concurrent_agents_hard_limit do
    {:error,
     {:invalid_max_concurrent_agents, value, :above_maximum, @max_concurrent_agents_hard_limit}}
  end

  defp validate_max_concurrent_agents(value) do
    {:error, {:invalid_max_concurrent_agents, value, :not_integer}}
  end

  defp format_max_concurrent_agents_error(
         {:invalid_max_concurrent_agents, _value, :below_minimum, minimum}
       ) do
    "must be greater than or equal to #{minimum}"
  end

  defp format_max_concurrent_agents_error(
         {:invalid_max_concurrent_agents, _value, :above_maximum, maximum}
       ) do
    "must be less than or equal to #{maximum}"
  end

  defp format_max_concurrent_agents_error({:invalid_max_concurrent_agents, _value, :not_integer}) do
    "must be an integer"
  end

  defp client(opts) do
    config =
      Application.get_env(:symphony_elixir, :workspace_settings_repository, [])
      |> normalize_config()
      |> Map.merge(normalize_config(Keyword.get(opts, :config, [])))

    {:ok, PostgRESTClient.new(config, Keyword.get(opts, :req_options, req_options()))}
  rescue
    error in ArgumentError -> {:error, {:missing_supabase_config, Exception.message(error)}}
  end

  defp table(opts) do
    opts_config = normalize_config(Keyword.get(opts, :config, []))

    app_config =
      normalize_config(Application.get_env(:symphony_elixir, :workspace_settings_repository, []))

    Map.get(opts_config, :table) || Map.get(app_config, :table) || @table
  end

  defp normalize_config(nil), do: %{}
  defp normalize_config(config) when is_list(config), do: Map.new(config)
  defp normalize_config(config) when is_map(config), do: config

  defp log_metadata(caller) do
    %{caller: caller, table: @table}
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)
end
