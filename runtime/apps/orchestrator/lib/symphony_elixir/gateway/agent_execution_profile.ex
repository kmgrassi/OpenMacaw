defmodule SymphonyElixir.Gateway.AgentExecutionProfile do
  @moduledoc """
  Resolves the runner kind / provider / model for an agent at chat-time
  by reading the platform's `routing_rule` + `routing_rule_match` tables
  via PostgREST.

  The platform owns the canonical routing logic, but the gateway WS chat
  path executes inside the orchestrator and needs the resolved runner kind
  to dispatch to the correct runner module. This module is the
  orchestrator-side replica of that resolution: it is *not* meant to
  replicate every match dimension (e.g. `local_workspace_root`); it picks
  the highest-priority enabled rule that names the agent in a
  `routing_rule_match` of kind `agent_id` and is scoped to the agent's
  workspace.

  Returns `{:ok, %{runner_kind, provider, model}}` when a rule resolves,
  `{:error, :not_found}` when no rule matches, or `{:error, reason}` on
  PostgREST errors.
  """

  alias SymphonyElixir.AgentInventory
  alias SymphonyElixir.AgentInventory.{Agent, StoredCredential}
  alias SymphonyElixir.PostgRESTClient
  alias SymphonyElixir.Schema.ExecutionProfile, as: ExecutionProfileSchema
  alias SymphonyElixir.Supabase
  alias SymphonyElixir.WorkerBridge.SecretResolver

  @rule_table "routing_rule"
  @match_table "routing_rule_match"

  @credential_optional_providers ["openai_compatible"]
  @local_relay_providers ["local"]

  @type resolution :: %{
          required(:runner_kind) => String.t(),
          required(:provider) => String.t() | nil,
          required(:model) => String.t() | nil,
          optional(:agent_id) => String.t(),
          optional(:workspace_id) => String.t(),
          optional(:credential_id) => String.t() | nil,
          optional(:credential_alias) => String.t() | nil,
          optional(:credential_scope) => String.t() | nil,
          optional(:api_key) => String.t() | nil,
          optional(:user_id) => String.t() | nil,
          optional(:context) => String.t()
        }

  @spec resolve(String.t(), String.t()) :: {:ok, resolution()} | {:error, term()}
  def resolve(agent_id, workspace_id, opts \\ [])

  def resolve(agent_id, workspace_id, opts)
      when is_binary(agent_id) and agent_id != "" and is_binary(workspace_id) and
             workspace_id != "" do
    agent_inventory = Keyword.get(opts, :agent_inventory, AgentInventory)
    secret_resolver = Keyword.get(opts, :secret_resolver, SecretResolver)

    with {:ok, config} <- resolve_config(),
         {:ok, agent} <- validate_agent_workspace(agent_id, workspace_id, agent_inventory),
         {:ok, rule_ids} <- match_rule_ids(config, agent_id, workspace_id),
         {:ok, rule} <- pick_rule(config, rule_ids, workspace_id, agent),
         {:ok, profile} <- profile_from_rule(rule, agent_id, workspace_id, agent),
         :ok <- validate_profile_policy(profile),
         {:ok, profile} <-
           attach_credential(profile, rule, workspace_id, agent_inventory, secret_resolver),
         {:ok, profile} <- attach_agent_user(profile, agent_id, workspace_id, agent_inventory),
         {:ok, profile} <- attach_agent_context(profile, agent) do
      {:ok, profile}
    end
  end

  def resolve(_agent_id, _workspace_id, _opts), do: {:error, :invalid_agent_profile_scope}

  defp match_rule_ids(config, agent_id, workspace_id) do
    query = %{
      "select" => "rule_id",
      "kind" => "eq.agent_id",
      "value" => "eq.#{agent_id}",
      "workspace_id" => "eq.#{workspace_id}"
    }

    case PostgRESTClient.get(client(config), @match_table, query,
           log_metadata:
             log_metadata("agent_execution_profile.match_rule_ids", @match_table,
               agent_id: agent_id,
               workspace_id: workspace_id
             )
         ) do
      {:ok, rows} when is_list(rows) ->
        ids = rows |> Enum.map(&Map.get(&1, "rule_id")) |> Enum.filter(&is_binary/1)
        {:ok, ids}

      {:ok, body} ->
        {:error, {:invalid_response, body}}

      {:error, _reason} = error ->
        error
    end
  end

  defp pick_rule(_config, [], _workspace_id, _agent), do: {:error, :not_found}

  defp pick_rule(config, rule_ids, workspace_id, agent) do
    query = %{
      "select" =>
        "id,priority,runner_kind,provider,model,credential_id,credential_alias,enabled,workspace_id",
      "id" => "in.(#{Enum.join(rule_ids, ",")})",
      "workspace_id" => "eq.#{workspace_id}",
      "enabled" => "eq.true",
      "order" => "priority.desc.nullslast"
    }

    with {:ok, rule_matches} <- rule_matches(config, rule_ids, workspace_id),
         {:ok, rows} <-
           PostgRESTClient.get(client(config), @rule_table, query,
             log_metadata:
               log_metadata("agent_execution_profile.pick_rule", @rule_table,
                 workspace_id: workspace_id,
                 rule_ids: rule_ids
               )
           ) do
      case rows do
        rows when is_list(rows) ->
          matches_by_rule = Enum.group_by(rule_matches, &Map.get(&1, "rule_id"))

          rules =
            rows
            |> Enum.with_index()
            |> Enum.filter(fn {rule, _index} ->
              is_binary(Map.get(rule, "runner_kind")) and
                rule_matches?(Map.get(matches_by_rule, Map.get(rule, "id"), []), agent)
            end)

          case rules do
            [] -> {:error, :not_found}
            rules -> {:ok, select_rule(rules, matches_by_rule)}
          end

        body ->
          {:error, {:invalid_response, body}}
      end
    else
      {:error, _reason} = error -> error
    end
  end

  defp rule_matches(config, rule_ids, workspace_id) do
    query = %{
      "select" => "rule_id,kind,key,value",
      "rule_id" => "in.(#{Enum.join(rule_ids, ",")})",
      "workspace_id" => "eq.#{workspace_id}"
    }

    case PostgRESTClient.get(client(config), @match_table, query,
           log_metadata:
             log_metadata("agent_execution_profile.rule_matches", @match_table,
               workspace_id: workspace_id,
               rule_ids: rule_ids
             )
         ) do
      {:ok, rows} when is_list(rows) ->
        {:ok, rows}

      {:ok, body} ->
        {:error, {:invalid_response, body}}

      {:error, _reason} = error ->
        error
    end
  end

  # Mirror the platform's canonical resolver (`selectRoutingRule` in
  # platform/apps/api/src/services/execution-profile-resolver/routing-rules.ts):
  # filter to rules whose predicates all match, then sort by priority,
  # predicate specificity, local_model_coding tie-break, and returned order.
  defp select_rule(rules, matches_by_rule) do
    rules
    |> Enum.sort_by(fn {rule, index} ->
      predicate_count =
        matches_by_rule
        |> Map.get(Map.get(rule, "id"), [])
        |> Enum.reject(&routing_metadata_match?/1)
        |> length()

      {-numeric_priority(Map.get(rule, "priority")), -predicate_count,
       -local_model_coding_score(rule), index}
    end)
    |> List.first()
    |> then(fn {rule, _index} ->
      Map.put(rule, "_routing_matches", Map.get(matches_by_rule, Map.get(rule, "id"), []))
    end)
  end

  defp rule_matches?(matches, agent) when is_list(matches) do
    Enum.all?(matches, &match_value?(&1, agent))
  end

  defp match_value?(match, agent) do
    kind = match |> Map.get("kind") |> normalized_key_string()
    key = match |> Map.get("key") |> normalized_optional_key_string()
    value = match |> Map.get("value") |> trimmed_string()

    cond do
      routing_metadata_match?(match) ->
        true

      kind == "agent_id" ->
        key in [nil, "id", "agent_id"] and value == agent.id

      kind in ["agent_type", "role"] ->
        key in [nil, "type"] and value == Agent.kind(agent)

      kind == "intent" ->
        false

      true ->
        false
    end
  end

  defp routing_metadata_match?(match) do
    match
    |> Map.get("kind")
    |> normalized_key_string()
    |> then(
      &(&1 in [
          "local_endpoint",
          "local_workspace_root",
          "local_machine",
          "local_model_capability"
        ])
    )
  end

  defp numeric_priority(priority) when is_number(priority), do: priority
  defp numeric_priority(_priority), do: -1.0e308

  defp local_model_coding_score(rule),
    do: if(Map.get(rule, "runner_kind") == "local_model_coding", do: 1, else: 0)

  defp normalized_optional_key_string(value) do
    case normalized_key_string(value) do
      "" -> nil
      value -> value
    end
  end

  defp normalized_key_string(value) when is_binary(value),
    do: value |> String.trim() |> String.downcase()

  defp normalized_key_string(_value), do: ""

  defp trimmed_string(value) when is_binary(value), do: String.trim(value)
  defp trimmed_string(_value), do: ""

  defp profile_from_rule(rule, agent_id, workspace_id, agent) do
    profile =
      %{
        "agent_id" => agent_id,
        "workspace_id" => workspace_id,
        "runner_kind" => normalize_runner_kind(Map.get(rule, "runner_kind"), agent),
        "provider" => Map.get(rule, "provider"),
        "model" => Map.get(rule, "model"),
        "credential_ref" => credential_ref(rule),
        "source_metadata" =>
          %{
            "source" => "routing_rule",
            "routing_rule_id" => Map.get(rule, "id"),
            "local_workspace_root" => local_workspace_root(rule)
          }
          |> reject_nil_values()
      }
      |> reject_nil_values()

    case ExecutionProfileSchema.validate(profile) do
      {:ok, schema_profile} ->
        schema_profile
        |> ExecutionProfileSchema.to_map()
        |> atomize_profile()
        |> then(&{:ok, &1})

      {:error, changeset} ->
        {:error, profile_error(changeset)}
    end
  end

  defp local_workspace_root(rule) do
    rule
    |> Map.get("_routing_matches", [])
    |> Enum.find_value(fn match ->
      kind = match |> Map.get("kind") |> normalized_key_string()
      key = match |> Map.get("key") |> normalized_optional_key_string()
      value = match |> Map.get("value") |> trimmed_string()

      if kind == "local_workspace_root" and key in [nil, "path"] and value != "" do
        value
      end
    end)
  end

  defp credential_ref(%{"credential_id" => credential_id})
       when is_binary(credential_id) and credential_id != "" do
    %{"type" => "credential_id", "credential_id" => credential_id}
  end

  defp credential_ref(%{"credential_alias" => credential_alias})
       when is_binary(credential_alias) and credential_alias != "" do
    %{"type" => "credential_alias", "credential_alias" => credential_alias}
  end

  defp credential_ref(_rule), do: nil

  defp profile_error(changeset) do
    cond do
      has_inclusion_error?(changeset, :provider) ->
        {:provider_unsupported, Ecto.Changeset.get_field(changeset, :provider)}

      has_inclusion_error?(changeset, :runner_kind) ->
        {:runner_unsupported, Ecto.Changeset.get_field(changeset, :runner_kind)}

      true ->
        {:invalid_execution_profile, changeset}
    end
  end

  # `openai_codex` represents ChatGPT OAuth credentials for Codex workers,
  # not an OpenAI API key for the Responses API transport used by manager
  # tool runners. Keep this rejection in the generic profile path so manager
  # agents fail before starting a session that would 401 on the first call.
  defp validate_profile_policy(%{runner_kind: "manager", provider: "openai_codex"}),
    do: {:error, {:provider_unsupported, "openai_codex"}}

  defp validate_profile_policy(_profile), do: :ok

  defp has_inclusion_error?(changeset, field) do
    Enum.any?(Keyword.get_values(changeset.errors, field), fn {_message, opts} ->
      Keyword.get(opts, :validation) == :inclusion
    end)
  end

  defp attach_credential(profile, rule, workspace_id, agent_inventory, secret_resolver) do
    cond do
      local_relay_provider?(profile) ->
        {:ok, Map.put(profile, :api_key, "local-runtime")}

      credential_optional_provider?(profile) and blank?(Map.get(rule, "credential_id")) and
          blank?(Map.get(rule, "credential_alias")) ->
        {:ok, profile}

      credential_id = string_value(rule, "credential_id") ->
        resolve_stored_credential(
          profile,
          workspace_id,
          credential_id,
          :id,
          agent_inventory,
          secret_resolver
        )

      credential_alias = string_value(rule, "credential_alias") ->
        resolve_stored_credential(
          profile,
          workspace_id,
          credential_alias,
          :alias,
          agent_inventory,
          secret_resolver
        )

      true ->
        {:error, :credential_missing}
    end
  end

  defp resolve_stored_credential(
         profile,
         workspace_id,
         credential_ref,
         credential_ref_type,
         agent_inventory,
         secret_resolver
       ) do
    with {:ok, credentials} <- agent_inventory.list_credentials(profile.agent_id),
         {:ok, %StoredCredential{} = credential} <-
           find_credential(credentials, credential_ref, credential_ref_type, workspace_id),
         {:ok, resolved_env} <- secret_resolver.resolve(credential),
         {:ok, api_key} <- api_key_from_env(resolved_env, profile.provider) do
      {:ok,
       profile
       |> Map.put(:credential_id, credential.id)
       |> Map.put(:credential_alias, if(credential_ref_type == :alias, do: credential_ref))
       |> Map.put(:credential_scope, credential.provider)
       |> Map.put(:api_key, api_key)}
    else
      {:error, :credential_not_found} -> {:error, :credential_missing}
      {:error, reason} -> {:error, {:credential_unresolved, reason}}
    end
  end

  defp find_credential(credentials, credential_ref, credential_ref_type, workspace_id)
       when is_list(credentials) do
    credentials
    |> Enum.find(fn %StoredCredential{
                      id: id,
                      aliases: aliases,
                      workspace_id: candidate_workspace_id
                    } ->
      candidate_workspace_id == workspace_id and
        credential_matches?(credential_ref_type, credential_ref, id, aliases)
    end)
    |> case do
      %StoredCredential{} = credential -> {:ok, credential}
      nil -> {:error, :credential_not_found}
    end
  end

  defp credential_matches?(:id, credential_id, id, _aliases) do
    id == credential_id || credential_row_id(id) == credential_id
  end

  defp credential_matches?(:alias, credential_alias, _id, aliases) when is_list(aliases),
    do: credential_alias in aliases

  defp credential_matches?(_type, _ref, _id, _aliases), do: false

  defp credential_row_id(id) when is_binary(id) do
    id |> String.split(":", parts: 2) |> List.first()
  end

  defp credential_row_id(_id), do: nil

  defp api_key_from_env(env, provider) when is_map(env) do
    candidates =
      if provider in (@credential_optional_providers ++ @local_relay_providers) do
        ["LOCAL_MODEL_API_KEY", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"]
      else
        ["OPENAI_API_KEY"]
      end

    candidates
    |> Enum.map(&Map.get(env, &1))
    |> Enum.find(&(is_binary(&1) and &1 != ""))
    |> case do
      value when is_binary(value) -> {:ok, value}
      _ -> {:error, :credential_secret_missing}
    end
  end

  defp validate_agent_workspace(agent_id, workspace_id, agent_inventory) do
    case agent_inventory.get_agent(agent_id) do
      {:ok, %Agent{workspace_id: ^workspace_id} = agent} ->
        {:ok, agent}

      {:ok, %Agent{workspace_id: nil} = agent} ->
        {:ok, agent}

      {:ok, %Agent{workspace_id: ""} = agent} ->
        {:ok, agent}

      {:ok, %Agent{workspace_id: agent_workspace_id}} ->
        {:error, {:workspace_mismatch, agent_workspace_id, workspace_id}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp normalize_runner_kind("llm_tool_runner", agent) do
    case Agent.kind(agent) do
      "planning" -> "planner"
      "planner" -> "planner"
      "manager" -> "manager"
      "learning" -> "manager"
      _ -> "llm_tool_runner"
    end
  end

  defp normalize_runner_kind(runner_kind, _agent), do: runner_kind

  defp attach_agent_user(profile, agent_id, workspace_id, agent_inventory) do
    case agent_inventory.get_agent(agent_id) do
      {:ok, %Agent{workspace_id: agent_workspace_id, created_by_user_id: user_id}}
      when agent_workspace_id in [workspace_id, nil, ""] and is_binary(user_id) and user_id != "" ->
        {:ok, Map.put(profile, :user_id, user_id)}

      {:ok, %Agent{workspace_id: agent_workspace_id}}
      when agent_workspace_id in [workspace_id, nil, ""] ->
        {:ok, profile}

      {:ok, %Agent{workspace_id: agent_workspace_id}} ->
        {:error, {:workspace_mismatch, agent_workspace_id, workspace_id}}

      {:error, _reason} ->
        {:ok, profile}
    end
  end

  defp attach_agent_context(profile, %Agent{context: context}) when is_binary(context) do
    case String.trim(context) do
      "" -> {:ok, profile}
      trimmed -> {:ok, Map.put(profile, :context, trimmed)}
    end
  end

  defp attach_agent_context(profile, _agent), do: {:ok, profile}

  defp atomize_profile(profile) do
    profile
    |> Map.take([
      "agent_id",
      "workspace_id",
      "runner_kind",
      "provider",
      "model",
      "credential_ref",
      "source_metadata"
    ])
    |> Map.new(fn {key, value} -> {String.to_atom(key), value} end)
  end

  defp credential_optional_provider?(profile),
    do: Map.get(profile, :provider) in @credential_optional_providers

  defp local_relay_provider?(profile), do: Map.get(profile, :provider) in @local_relay_providers

  defp string_value(map, key) when is_map(map) do
    case Map.get(map, key) || Map.get(map, String.to_atom(key)) do
      value when is_binary(value) and value != "" -> value
      _ -> nil
    end
  rescue
    ArgumentError -> nil
  end

  defp blank?(value), do: value in [nil, ""]

  defp reject_nil_values(map) do
    map
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
  end

  defp resolve_config do
    endpoint =
      System.get_env("LAUNCHER_SUPABASE_URL") ||
        System.get_env("SUPABASE_URL")

    api_key =
      System.get_env("LAUNCHER_SUPABASE_SERVICE_KEY") ||
        System.get_env("SUPABASE_SERVICE_ROLE_KEY")

    cond do
      not is_binary(endpoint) or endpoint == "" ->
        {:error, :supabase_unconfigured}

      not is_binary(api_key) or api_key == "" ->
        {:error, :supabase_unconfigured}

      true ->
        {:ok, %{endpoint: Supabase.rest_endpoint!(endpoint: endpoint), api_key: api_key}}
    end
  end

  defp client(config), do: PostgRESTClient.new(config, req_options())

  defp req_options, do: Application.get_env(:symphony_elixir, :gateway_runtime_req_options, [])

  defp log_metadata(operation, table, fields) do
    Map.merge(%{operation: operation, table: table}, Map.new(fields))
  end
end
