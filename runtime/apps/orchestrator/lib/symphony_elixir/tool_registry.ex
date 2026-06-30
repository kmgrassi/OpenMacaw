defmodule SymphonyElixir.ToolRegistry do
  @moduledoc """
  Runtime registry for known tool modules.

  The registry keeps the runtime's known tool definitions separate from the
  policy that decides which tools an agent may use. Built-in tools are static;
  `register/1` adds a VM-local overlay for tests and future additive tools.
  """

  alias SymphonyElixir.{AgentInventory.Agent, PostgRESTClient, Supabase, ToolCall, ToolExecutionContext, ToolSpec}

  @registered_modules_key {__MODULE__, :registered_modules}
  @register_lock {__MODULE__, :register}

  @manager_tools [
    SymphonyElixir.Manager.Tools.ListPlans,
    SymphonyElixir.Manager.Tools.ListWorkItems,
    SymphonyElixir.Manager.Tools.DispatchRunner,
    SymphonyElixir.Manager.Tools.EscalateToHuman,
    SymphonyElixir.Manager.Tools.Snooze,
    SymphonyElixir.Manager.Tools.MarkDone
  ]

  @scheduled_task_tools [
    SymphonyElixir.ScheduledTask.Tools.Create,
    SymphonyElixir.ScheduledTask.Tools.Read,
    SymphonyElixir.ScheduledTask.Tools.Update,
    SymphonyElixir.ScheduledTask.Tools.List,
    SymphonyElixir.ScheduledTask.Tools.Delete
  ]

  @router_tools [
    SymphonyElixir.Router.Tools.RoutingRuleList,
    SymphonyElixir.Router.Tools.RoutingRuleRead,
    SymphonyElixir.Router.Tools.RoutingRuleUpdate,
    SymphonyElixir.Router.Tools.ProviderFailureList,
    SymphonyElixir.Router.Tools.LocalModelList,
    SymphonyElixir.Router.Tools.ProviderCutoverList,
    SymphonyElixir.ScheduledTask.Tools.Read
  ]

  @learning_tools [
    SymphonyElixir.Learning.Tools.AgentRunRead
  ]

  @planner_tools [
    SymphonyElixir.Planner.Tools.PlanCreate,
    SymphonyElixir.Planner.Tools.PlanUpdate,
    SymphonyElixir.Planner.Tools.PlanDelete,
    SymphonyElixir.Planner.Tools.Delegate,
    SymphonyElixir.Planner.Tools.PlanRead,
    SymphonyElixir.Planner.Tools.TaskCreate,
    SymphonyElixir.Planner.Tools.TaskUpdate,
    SymphonyElixir.Planner.Tools.TaskSchedule,
    SymphonyElixir.Planner.Tools.AgentToolGrantCreate,
    SymphonyElixir.Planner.Tools.AgentToolGrantUpdate,
    SymphonyElixir.Planner.Tools.SkillCreate,
    SymphonyElixir.Planner.Tools.TaskRead,
    SymphonyElixir.Planner.Tools.TaskStatus,
    SymphonyElixir.Planner.Tools.UpdateTrackerKind,
    SymphonyElixir.ScheduledTask.Tools.Create,
    SymphonyElixir.ScheduledTask.Tools.Read,
    SymphonyElixir.ScheduledTask.Tools.Update,
    SymphonyElixir.ScheduledTask.Tools.List,
    SymphonyElixir.ScheduledTask.Tools.Delete,
    SymphonyElixir.Planner.Tools.SnoozeWorkItem
  ]

  @codex_tools [
    SymphonyElixir.Tools.Codex.LinearGraphQL,
    SymphonyElixir.Tools.Codex.PlanningProfileCreateUpdate,
    SymphonyElixir.Tools.Codex.PlanningProfileDelete,
    SymphonyElixir.Tools.Codex.AgentMessage,
    SymphonyElixir.Tools.Codex.AgentRemediate
  ]

  @default_modules [
    SymphonyElixir.Tools.ShellExec,
    SymphonyElixir.Tools.ApplyPatch,
    SymphonyElixir.Tools.GitRun,
    SymphonyElixir.Tools.Echo
  ]

  @universal_tools [
    SymphonyElixir.Tools.WorkspaceSettings
  ]

  @tools @manager_tools ++
           @planner_tools ++
           @scheduled_task_tools ++
           @router_tools ++ @learning_tools ++ @codex_tools ++ @default_modules ++ @universal_tools
  @planning "planning"
  @read_only_turn_sandbox %{"type" => "readOnly", "networkAccess" => false}
  @planner_database_tools [
    "scheduled_task.read",
    "scheduled_task.list",
    "shell.exec",
    "task.status",
    "plan.create",
    "plan.update",
    "plan.delete",
    "delegate",
    "task.create",
    "task.update",
    "task.schedule",
    "agent_tool_grant.create",
    "agent_tool_grant.update",
    "skill.create",
    "scheduled_task.create",
    "scheduled_task.read",
    "scheduled_task.update",
    "scheduled_task.list",
    "scheduled_task.delete",
    "plan.read",
    "task.read",
    "task.status"
  ]

  @type tool_name :: String.t()
  @type allowed :: [tool_name()] | MapSet.t(tool_name()) | :all

  @doc "Register a tool module for lookup in this VM."
  @spec register(module()) :: :ok | {:error, term()}
  def register(module) when is_atom(module) do
    with :ok <- validate_tool_module(module) do
      :global.trans(@register_lock, fn ->
        modules = registered_modules()
        :persistent_term.put(@registered_modules_key, Map.put(modules, module.name(), module))
      end)
    end
  end

  @doc "Return every known tool module."
  @spec all() :: [module()]
  def all do
    registered_modules()
    |> Map.values()
    |> Kernel.++(@tools)
    |> Enum.uniq()
  end

  @doc "Resolve a registered tool module by name."
  @spec get(tool_name()) :: {:ok, module()} | :error
  def get(name) when is_binary(name) do
    registered_module(name) || static_module(name)
  end

  def get(_name), do: :error

  @doc "Return tool names in a named bundle."
  @spec bundle(atom()) :: [tool_name()]
  def bundle(bundle) when is_atom(bundle) do
    all()
    |> Enum.filter(&(bundle in List.wrap(&1.bundle())))
    |> Enum.map(& &1.name())
  end

  @doc """
  Execute a tool after enforcing the supplied allowlist.

  `allowed` may be `:all`, a list of tool names, or a `MapSet` of tool names.
  """
  @spec execute(tool_name(), map(), map(), allowed()) ::
          {:ok, ToolCall.result()} | {:error, :not_allowed | :unknown_tool | term()}
  def execute(name, arguments, context, allowed)
      when is_binary(name) and is_map(context) do
    cond do
      not allowed?(name, allowed) ->
        {:error, :not_allowed}

      true ->
        case get(name) do
          {:ok, module} -> dispatch(module, arguments, ToolExecutionContext.normalize(context))
          :error -> {:error, :unknown_tool}
        end
    end
  end

  def execute(_name, _arguments, _context, _allowed), do: {:error, :unknown_tool}

  @doc "Translate registered tools into provider-specific tool specs."
  @spec provider_specs([tool_name() | module()], ToolSpec.provider() | String.t()) :: [map()]
  def provider_specs(tools, provider) when is_list(tools) do
    tools
    |> Enum.flat_map(&tool_definition/1)
    |> ToolSpec.to_provider_format(provider)
  end

  def provider_specs(_tools, _provider), do: []

  @doc "Return model-agnostic specs for the requested tool names."
  @spec specs([tool_name()]) :: [map()]
  def specs(names) when is_list(names) do
    Enum.flat_map(names, fn name ->
      case get(name) do
        {:ok, module} -> [tool_spec(module)]
        :error -> []
      end
    end)
  end

  @doc "Return dynamic-tool shaped execution output for Codex compatibility."
  @spec execute_dynamic_response(tool_name(), term(), keyword() | map()) :: map()
  def execute_dynamic_response(name, arguments, opts_or_context \\ %{}) do
    {context, allowed_tools} = execution_context(opts_or_context)

    case get(name) do
      :error ->
        failure_response(%{
          "error" => %{
            "message" => "Unsupported dynamic tool: #{inspect(name)}.",
            "supportedTools" => supported_tool_names(allowed_tools)
          }
        })

      {:ok, _module} ->
        case execute(name, normalize_arguments(arguments), context, allowed_tools || :all) do
          {:ok, %{output: output}} ->
            dynamic_tool_response(output_success(name, output), encode_payload(output))

          {:error, :not_allowed} ->
            failure_response(%{
              "error" => %{
                "message" => "Dynamic tool #{inspect(name)} is not allowed by this agent's tool policy.",
                "supportedTools" => allowed_tools
              }
            })

          {:error, reason} ->
            failure_response(tool_error_payload(name, reason))
        end
    end
  end

  @doc "Resolve Codex dynamic tool exposure for an agent kind and policy."
  @spec resolve_for_agent(term(), map(), map()) :: map()
  def resolve_for_agent(agent_kind, tool_policy, runtime_settings)
      when is_map(tool_policy) and is_map(runtime_settings) do
    kind = Agent.kind(agent_kind)

    dynamic_tool_names =
      kind
      |> tool_names_for_agent()
      |> maybe_add_agent_control_tools(kind, tool_policy)

    runtime_settings
    |> Map.take([:thread_sandbox, :turn_sandbox_policy])
    |> Map.merge(%{
      agent_kind: kind,
      dynamic_tool_specs: specs(dynamic_tool_names),
      dynamic_tool_names: dynamic_tool_names
    })
    |> enforce_planner_mutation_boundary(kind, tool_policy)
  end

  def resolve_for_agent(agent_kind, _tool_policy, runtime_settings)
      when is_map(runtime_settings) do
    resolve_for_agent(agent_kind, %{}, runtime_settings)
  end

  @doc """
  Resolve effective runtime tools for an agent from persisted grant rows.

  This direct DB resolver is intentionally grant-only: `agent_tool_grant` is the
  runtime source of truth, and `tool_policy_template` is not read.
  """
  @spec resolve_for_agent(String.t()) :: {:ok, map()} | {:error, term()}
  def resolve_for_agent(agent_id) when is_binary(agent_id) and agent_id != "" do
    # Two queries instead of a PostgREST embedded join (`tool!inner(...)`): the
    # embed requires the agent_tool_grant -> tool foreign key to be present in
    # PostgREST's schema cache, which it is not in production. Fetch the granted
    # tool ids, then resolve their slugs from the `tool` catalog, mirroring the
    # platform's resolver.
    with {:ok, config} <- tool_grant_config(),
         {:ok, tool_ids} <- granted_tool_ids(config, agent_id),
         {:ok, slug_by_id} <- enabled_tool_slugs(config, tool_ids) do
      tool_names =
        tool_ids
        |> Enum.flat_map(fn id -> List.wrap(Map.get(slug_by_id, id)) end)
        |> Enum.filter(&match?({:ok, _module}, get(&1)))
        |> Enum.uniq()

      {:ok,
       %{
         agent_id: agent_id,
         dynamic_tool_names: tool_names,
         dynamic_tool_specs: specs(tool_names),
         tool_definitions: definitions(tool_names),
         source: "agent_tool_grant"
       }}
    end
  end

  def resolve_for_agent(_agent_id), do: {:error, :invalid_agent_id}

  defp granted_tool_ids(config, agent_id) do
    query = %{
      "agent_id" => "eq.#{agent_id}",
      "mode" => "eq.include",
      "select" => "tool_id",
      "order" => "created_at.asc.nullslast"
    }

    case PostgRESTClient.get(tool_grant_client(config), config.grant_table, query,
           log_metadata: tool_grant_log_metadata("tool_registry.resolve_for_agent.grants", config.grant_table, agent_id: agent_id)
         ) do
      {:ok, rows} when is_list(rows) ->
        {:ok, rows |> Enum.flat_map(&List.wrap(&1["tool_id"])) |> Enum.uniq()}

      {:ok, _body} ->
        {:error, :invalid_response}

      {:error, _reason} = error ->
        error
    end
  end

  defp enabled_tool_slugs(_config, []), do: {:ok, %{}}

  defp enabled_tool_slugs(config, tool_ids) do
    query = %{
      "id" => "in.(#{Enum.join(tool_ids, ",")})",
      "enabled" => "eq.true",
      "select" => "id,slug"
    }

    case PostgRESTClient.get(tool_grant_client(config), tool_table(config), query,
           log_metadata: tool_grant_log_metadata("tool_registry.resolve_for_agent.tools", tool_table(config), tool_count: length(tool_ids))
         ) do
      {:ok, rows} when is_list(rows) ->
        {:ok, Map.new(rows, fn row -> {row["id"], row["slug"]} end)}

      {:ok, _body} ->
        {:error, :invalid_response}

      {:error, _reason} = error ->
        error
    end
  end

  defp tool_table(config), do: Map.get(config, :tool_table, "tool")

  @doc "Codex coding dynamic tool specs."
  @spec coding_tool_specs() :: [map()]
  def coding_tool_specs, do: specs(coding_tool_names())

  @doc "Codex planner dynamic tool specs."
  @spec planner_tool_specs() :: [map()]
  def planner_tool_specs, do: specs(planner_tool_names())

  @doc "Codex agent communication dynamic tool specs."
  @spec agent_communication_tool_specs() :: [map()]
  def agent_communication_tool_specs, do: specs(agent_communication_tool_names())

  @doc "Return model-agnostic specs for the requested tool names."
  @spec definitions([tool_name()]) :: [map()]
  def definitions(names) when is_list(names), do: specs(names)

  @doc """
  Return the effective model-facing tool definitions for a runner config.

  Platform-owned `tool_definitions` are the runtime contract for the current
  turn's effective grants. The fallback names only preserve current local/test
  behavior until runtime reads `agent_tool_grant` directly.
  """
  @spec effective_definitions(map(), [tool_name()]) :: [map()]
  def effective_definitions(config, fallback_names)
      when is_map(config) and is_list(fallback_names) do
    case map_value(config, :tool_definitions) || map_value(config, :toolDefinitions) do
      tools when is_list(tools) -> normalize_definitions(tools)
      _other -> specs(Enum.uniq(fallback_names))
    end
  end

  def effective_definitions(_config, fallback_names) when is_list(fallback_names),
    do: specs(Enum.uniq(fallback_names))

  @doc "Extract runtime tool names from model-agnostic tool definitions."
  @spec definition_names([map()]) :: [tool_name()]
  def definition_names(definitions) when is_list(definitions) do
    definitions
    |> Enum.map(&(map_value(&1, :name) || map_value(&1, :slug)))
    |> Enum.filter(&is_binary/1)
  end

  @doc "Return the model-agnostic spec for a tool module."
  @spec tool_spec(module()) :: map()
  def tool_spec(module) when is_atom(module) do
    parameters_schema = module.parameters_schema()

    %{
      "name" => module.name(),
      "description" => module.description(),
      "inputSchema" => parameters_schema,
      "parameters" => parameters_schema,
      "parameters_schema" => parameters_schema,
      "execution_kind" => Atom.to_string(module.execution_kind())
    }
  end

  defp dispatch(module, arguments, context) do
    case module.execute(arguments, context) do
      {:ok, output} -> {:ok, ToolCall.result(output)}
      {:error, reason} -> {:error, reason}
      %{"success" => false} = result -> {:error, result}
      other -> {:ok, ToolCall.result(other)}
    end
  end

  defp tool_definition(module) when is_atom(module) do
    case validate_tool_module(module) do
      :ok -> [definition(module)]
      {:error, _reason} -> []
    end
  end

  defp tool_definition(name) when is_binary(name) do
    case get(name) do
      {:ok, module} -> [definition(module)]
      :error -> []
    end
  end

  defp tool_definition(_tool), do: []

  defp definition(module) do
    %{
      name: module.name(),
      description: module.description(),
      parameters_schema: module.parameters_schema()
    }
  end

  defp allowed?(_name, :all), do: true
  defp allowed?(name, %MapSet{} = allowed), do: MapSet.member?(allowed, name)
  defp allowed?(name, allowed) when is_list(allowed), do: name in allowed
  defp allowed?(_name, _allowed), do: false

  defp tool_names_for_agent(@planning), do: planner_tool_names()
  defp tool_names_for_agent("learning"), do: bundle(:learning)
  defp tool_names_for_agent(_kind), do: coding_tool_names()

  defp coding_tool_names, do: ["linear_graphql", "snooze_work_item"]

  defp planner_tool_names do
    @planner_database_tools ++
      [
        "planning_profile.create_update",
        "planning_profile.delete",
        "workspace_settings.manage",
        "workspace_settings.update_tracker_kind",
        "snooze_work_item"
      ]
  end

  defp agent_communication_tool_names, do: ["agent.message", "agent.remediate"]

  defp maybe_add_agent_control_tools(dynamic_tool_names, @planning, tool_policy) do
    if agent_control_tools_enabled?(tool_policy) do
      dynamic_tool_names ++ agent_communication_tool_names()
    else
      dynamic_tool_names
    end
  end

  defp maybe_add_agent_control_tools(dynamic_tool_names, _kind, _tool_policy),
    do: dynamic_tool_names

  defp enforce_planner_mutation_boundary(resolved, @planning, tool_policy) do
    if workspace_mutation_tools_enabled?(tool_policy) do
      resolved
    else
      resolved
      |> Map.put(:thread_sandbox, "read-only")
      |> Map.put(:turn_sandbox_policy, @read_only_turn_sandbox)
    end
  end

  defp enforce_planner_mutation_boundary(resolved, _kind, _tool_policy), do: resolved

  defp workspace_mutation_tools_enabled?(tool_policy) do
    case planning_policy_value(tool_policy, "allow_workspace_mutation_tools") do
      {:ok, value} ->
        truthy?(value)

      :error ->
        truthy?(
          Map.get(tool_policy, "allow_workspace_mutation_tools") ||
            Map.get(tool_policy, :allow_workspace_mutation_tools)
        )
    end
  end

  defp agent_control_tools_enabled?(tool_policy) do
    case planning_policy_value(tool_policy, "allow_agent_control_tools") do
      {:ok, value} ->
        truthy?(value)

      :error ->
        truthy?(
          Map.get(tool_policy, "allow_agent_control_tools") ||
            Map.get(tool_policy, :allow_agent_control_tools)
        )
    end
  end

  defp planning_policy_value(tool_policy, key) do
    Enum.find_value(
      [
        get_in(tool_policy, ["planning", key]),
        get_in(tool_policy, [:planning, String.to_atom(key)])
      ],
      :error,
      fn
        nil -> nil
        value -> {:ok, value}
      end
    )
  end

  defp truthy?(value), do: value in [true, "true", "enabled", "allow"]

  @doc false
  @spec req_options() :: keyword()
  def req_options, do: Application.get_env(:symphony_elixir, :tool_registry_req_options, [])

  defp tool_grant_client(config), do: PostgRESTClient.new(config, req_options())

  defp tool_grant_config do
    config =
      Application.get_env(:symphony_elixir, :tool_registry_db, [])
      |> Enum.into(%{})
      |> Map.put_new(:grant_table, "agent_tool_grant")

    config
    |> Supabase.merge_connection!()
    |> validate_tool_grant_table()
  rescue
    error in [ArgumentError] ->
      {:error, {:missing_supabase_config, Exception.message(error)}}
  end

  defp validate_tool_grant_table({:error, _reason} = error), do: error
  defp validate_tool_grant_table({:ok, config}), do: validate_tool_grant_table(config)

  defp validate_tool_grant_table(config) do
    case Map.fetch!(config, :grant_table) do
      table when is_binary(table) and table != "" ->
        {:ok, config}

      table ->
        {:error, {:invalid_tool_registry_config, "tool_registry_db grant_table must be a non-empty string, got: #{inspect(table)}"}}
    end
  end

  defp tool_grant_log_metadata(caller, table, extra) do
    extra
    |> Map.new()
    |> Map.merge(%{caller: caller, action: caller, table: table})
    |> Map.reject(fn {_key, value} -> value in [nil, ""] end)
  end

  defp execution_context(opts) when is_list(opts) do
    {opts |> Keyword.drop([:allowed_tools]) |> Map.new() |> ToolExecutionContext.normalize(), Keyword.get(opts, :allowed_tools)}
  end

  defp execution_context(context) when is_map(context) do
    {
      context |> Map.drop([:allowed_tools, "allowed_tools"]) |> ToolExecutionContext.normalize(),
      Map.get(context, :allowed_tools) || Map.get(context, "allowed_tools")
    }
  end

  defp normalize_arguments(arguments) when is_map(arguments), do: arguments
  defp normalize_arguments(arguments), do: arguments

  defp dynamic_tool_response(success, output) when is_boolean(success) and is_binary(output) do
    %{
      "success" => success,
      "output" => output,
      "contentItems" => [%{"type" => "inputText", "text" => output}]
    }
  end

  defp output_success("linear_graphql", %{"errors" => errors})
       when is_list(errors) and errors != [], do: false

  defp output_success("linear_graphql", %{errors: errors}) when is_list(errors) and errors != [],
    do: false

  defp output_success(_name, _output), do: true

  defp failure_response(payload), do: dynamic_tool_response(false, encode_payload(payload))

  defp encode_payload(payload) when is_map(payload) or is_list(payload),
    do: Jason.encode!(payload, pretty: true)

  defp encode_payload(payload), do: inspect(payload)

  defp supported_tool_names(allowed_tools) when is_list(allowed_tools), do: allowed_tools
  defp supported_tool_names(_allowed_tools), do: coding_tool_names()

  defp tool_error_payload("linear_graphql", :missing_query) do
    %{"error" => %{"message" => "`linear_graphql` requires a non-empty `query` string."}}
  end

  defp tool_error_payload("linear_graphql", :invalid_arguments) do
    %{
      "error" => %{
        "message" => "`linear_graphql` expects either a GraphQL query string or an object with `query` and optional `variables`."
      }
    }
  end

  defp tool_error_payload("linear_graphql", :invalid_variables) do
    %{
      "error" => %{"message" => "`linear_graphql.variables` must be a JSON object when provided."}
    }
  end

  defp tool_error_payload("linear_graphql", :missing_linear_api_token) do
    %{
      "error" => %{
        "message" => "Symphony is missing Linear auth. Set `linear.api_key` in `WORKFLOW.md` or export `LINEAR_API_KEY`."
      }
    }
  end

  defp tool_error_payload("linear_graphql", {:linear_api_status, status}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed with HTTP #{status}.",
        "status" => status
      }
    }
  end

  defp tool_error_payload("linear_graphql", {:linear_api_request, reason}) do
    %{
      "error" => %{
        "message" => "Linear GraphQL request failed before receiving a successful response.",
        "reason" => inspect(reason)
      }
    }
  end

  defp tool_error_payload("linear_graphql", reason) do
    %{
      "error" => %{
        "message" => "Linear GraphQL tool execution failed.",
        "reason" => inspect(reason)
      }
    }
  end

  defp tool_error_payload("snooze_work_item", reason),
    do: named_error_payload("snooze_work_item failed.", reason)

  defp tool_error_payload("planning_profile." <> _rest = tool, reason),
    do: named_error_payload("Planning profile tool execution failed.", reason, tool)

  defp tool_error_payload("repo." <> _rest = tool, reason),
    do: named_error_payload("#{tool} failed.", reason)

  defp tool_error_payload("agent." <> _rest = tool, reason),
    do: named_error_payload("#{tool} failed.", reason)

  defp tool_error_payload("plan." <> _rest = tool, reason),
    do: named_error_payload("#{tool} failed.", reason)

  defp tool_error_payload("task." <> _rest = tool, {:validation_failed, validation_feedback}),
    do: validation_error_payload("#{tool} failed validation.", validation_feedback)

  defp tool_error_payload("task." <> _rest = tool, reason),
    do: named_error_payload("#{tool} failed.", reason)

  defp tool_error_payload(_tool, reason),
    do: named_error_payload("Tool execution failed.", reason)

  defp validation_error_payload(message, validation_feedback) do
    %{
      "error" => %{
        "message" => message,
        "validation_feedback" => List.wrap(validation_feedback)
      }
    }
  end

  defp named_error_payload(message, reason, tool \\ nil) do
    error =
      %{"message" => message, "reason" => inspect(reason)}
      |> maybe_put("tool", tool)

    %{"error" => error}
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp static_module(name) do
    Enum.find_value(@tools, :error, fn module ->
      if safe_name(module) == name, do: {:ok, module}, else: nil
    end)
  end

  defp normalize_definitions(tools) do
    tools
    |> Enum.filter(&is_map/1)
    |> Enum.map(&normalize_definition/1)
    |> Enum.filter(&(map_value(&1, :name) || map_value(&1, :slug)))
  end

  defp normalize_definition(tool) do
    parameters_schema =
      map_value(tool, :inputSchema) ||
        map_value(tool, :parameters_schema) ||
        map_value(tool, :parameters) ||
        %{"type" => "object", "properties" => %{}}

    tool
    |> stringify_atom_keys()
    |> Map.merge(%{
      "name" => map_value(tool, :name) || map_value(tool, :slug),
      "description" => map_value(tool, :description) || "",
      "inputSchema" => parameters_schema,
      "parameters" => parameters_schema,
      "parameters_schema" => parameters_schema
    })
    |> maybe_put("execution_kind", map_value(tool, :execution_kind))
  end

  defp stringify_atom_keys(map) do
    Enum.reduce(map, %{}, fn
      {key, value}, acc when is_atom(key) -> Map.put_new(acc, Atom.to_string(key), value)
      {key, value}, acc -> Map.put(acc, key, value)
    end)
  end

  defp map_value(map, key) when is_map(map),
    do: Map.get(map, key) || Map.get(map, Atom.to_string(key))

  defp map_value(_map, _key), do: nil

  defp registered_module(name) do
    case Map.fetch(registered_modules(), name) do
      {:ok, module} -> {:ok, module}
      :error -> nil
    end
  end

  defp registered_modules do
    :persistent_term.get(@registered_modules_key, %{})
  end

  defp validate_tool_module(module) do
    cond do
      not Code.ensure_loaded?(module) ->
        {:error, :module_not_loaded}

      not function_exported?(module, :name, 0) ->
        {:error, :missing_name}

      not function_exported?(module, :description, 0) ->
        {:error, :missing_description}

      not function_exported?(module, :parameters_schema, 0) ->
        {:error, :missing_parameters_schema}

      not function_exported?(module, :bundle, 0) ->
        {:error, :missing_bundle}

      not function_exported?(module, :execution_kind, 0) ->
        {:error, :missing_execution_kind}

      not function_exported?(module, :execute, 2) ->
        {:error, :missing_execute}

      true ->
        :ok
    end
  end

  defp safe_name(module) do
    case Code.ensure_loaded(module) do
      {:module, ^module} ->
        if function_exported?(module, :name, 0), do: module.name(), else: nil

      {:error, _reason} ->
        nil
    end
  end
end
