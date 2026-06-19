defmodule SymphonyElixir.Manager.SchedulerTestSupport do
  alias SymphonyElixir.Launcher.GatewayConfig.Resolved

  defmodule TestWorkItemSource do
    alias SymphonyElixir.Manager.WorkItemRow

    def due_work_items(workspace_id, agent_id, now, opts) do
      test_pid = Application.fetch_env!(:symphony_elixir, :manager_scheduler_test_pid)
      send(test_pid, {:due_query, {workspace_id, agent_id, now, opts}})
      rows = Application.get_env(:symphony_elixir, :manager_scheduler_rows, [])
      {:ok, Enum.map(rows, &normalize_row/1)}
    end

    defp normalize_row(%SymphonyElixir.WorkItem{} = item), do: item
    defp normalize_row(%WorkItemRow{} = row), do: WorkItemRow.to_work_item(row)
    defp normalize_row(row) when is_map(row), do: row
  end

  defmodule ErrorWorkItemSource do
    def due_work_items(_workspace_id, _agent_id, _now, _opts), do: raise("database unavailable")
  end

  defmodule ReturningErrorWorkItemSource do
    def due_work_items(_workspace_id, _agent_id, _now, _opts),
      do: {:error, {:postgrest_failed, :timeout}}
  end

  defmodule TestChatGateway do
    def post_message(scope, body, opts) do
      test_pid = Application.fetch_env!(:symphony_elixir, :manager_scheduler_test_pid)
      send(test_pid, {:post_message, scope, body, opts})
      {:ok, Keyword.fetch!(opts, :run_id)}
    end
  end

  defmodule ErrorChatGateway do
    def post_message(_scope, _body, _opts) do
      {:error, {:retryable, :provider_timeout}}
    end
  end

  defmodule RaisingChatGateway do
    def post_message(_scope, _body, _opts), do: raise("manager turn exploded")
  end

  defmodule TestRunner do
    def start_session(config, nil) do
      test_pid = Application.fetch_env!(:symphony_elixir, :manager_scheduler_test_pid)
      send(test_pid, {:manager_session_started, config})

      {:ok,
       %{
         workspace_id: config["workspace_id"],
         model: config["model"],
         credential_id: config["credential_id"]
       }}
    end

    def stop_session(_session), do: :ok
  end

  defmodule TestGatewayConfig do
    @behaviour SymphonyElixir.Launcher.GatewayConfig

    def fetch("workspace", workspace_id) do
      case Application.get_env(:symphony_elixir, :manager_scheduler_gateway_config) do
        nil ->
          {:error, :not_found}

        config_json ->
          {:ok,
           %Resolved{
             scope_type: "workspace",
             scope_id: workspace_id,
             config_json: config_json,
             config_hash: "hash",
             version: 1
           }}
      end
    end

    def fetch(_scope_type, _scope_id), do: {:error, :not_found}
    def record_apply_state(_scope_type, _scope_id, _status, _opts), do: :ok
  end

  defmodule TestAgentInventory do
    alias SymphonyElixir.AgentInventory.{Agent, StoredCredential}

    def get_agent("manager-agent-1") do
      {:ok, %Agent{id: "manager-agent-1", workspace_id: "workspace-1", type: "manager"}}
    end

    def list_credentials("manager-agent-1") do
      {:ok,
       [
         %StoredCredential{
           id: "credential-1:OPENAI_API_KEY",
           agent_id: "manager-agent-1",
           workspace_id: "workspace-1",
           provider: "openai",
           env_var: "OPENAI_API_KEY",
           secret_value: "sk-stored",
           aliases: ["OPENAI_API_KEY", "api_key"]
         }
       ]}
    end
  end

  defmodule TestSecretResolver do
    def resolve(%{env_var: env_var, secret_value: secret_value}) do
      {:ok, %{env_var => secret_value}}
    end
  end

  defmodule TestToolDefinitionResolver do
    def resolve_for_agent("manager-agent-1") do
      {:ok,
       %{
         tool_definitions: [
           %{
             "name" => "git.run",
             "description" => "Run a git command",
             "parameters_schema" => %{
               "type" => "object",
               "properties" => %{"command" => %{"type" => "string"}},
               "required" => ["command"]
             },
             "execution_kind" => "shell"
           }
         ]
       }}
    end

    def resolve_for_agent(_agent_id), do: {:ok, %{tool_definitions: []}}
  end

  defmodule TestExecutionProfile do
    def resolve(agent_id, workspace_id, opts \\ []) do
      config =
        :symphony_elixir
        |> Application.get_env(:manager_scheduler_gateway_config, %{})
        |> get_in(["runners", "manager"])

      case config do
        nil ->
          {:error, :not_found}

        %{} = config ->
          profile = %{
            agent_id: agent_id,
            workspace_id: workspace_id,
            runner_kind: "manager",
            provider: Map.get(config, "provider"),
            model: Map.get(config, "model"),
            api_key: Map.get(config, "api_key") || local_api_key(config),
            credential_id: Map.get(config, "credential_id")
          }

          resolve_credential(profile, config, opts)
      end
    end

    defp local_api_key(%{"provider" => "local"}), do: "local-runtime"
    defp local_api_key(_config), do: nil

    defp resolve_credential(%{api_key: api_key} = profile, _config, _opts)
         when is_binary(api_key) and api_key != "",
         do: {:ok, profile}

    defp resolve_credential(%{provider: "openai", credential_id: credential_id} = profile, _config, opts)
         when is_binary(credential_id) and credential_id != "" do
      agent_inventory = Keyword.fetch!(opts, :agent_inventory)
      secret_resolver = Keyword.fetch!(opts, :secret_resolver)

      with {:ok, credentials} <- agent_inventory.list_credentials(profile.agent_id),
           credential when not is_nil(credential) <-
             Enum.find(credentials, &(String.starts_with?(&1.id, credential_id) or &1.id == credential_id)),
           {:ok, env} <- secret_resolver.resolve(credential),
           api_key when is_binary(api_key) <- Map.get(env, credential.env_var) do
        {:ok, %{profile | credential_id: credential.id, api_key: api_key}}
      else
        _ -> {:error, :credential_missing}
      end
    end

    defp resolve_credential(%{provider: "openai"}, _config, _opts), do: {:error, :credential_missing}
    defp resolve_credential(profile, _config, _opts), do: {:ok, profile}
  end

  defmodule ErrorSessionResolver do
    def identity(_workspace_id, _opts),
      do: {:error, {:adapter_failed, :timeout}, %{status: :error}}

    def resolve(_workspace_id, _opts),
      do: {:error, {:adapter_failed, :timeout}, %{status: :error}}
  end
end
