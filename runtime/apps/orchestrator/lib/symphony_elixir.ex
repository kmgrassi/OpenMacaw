defmodule SymphonyElixir do
  @moduledoc """
  Entry point for the Symphony orchestrator.
  """

  @doc """
  Start the orchestrator in the current BEAM node.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    SymphonyElixir.Orchestrator.start_link(opts)
  end
end

defmodule SymphonyElixir.Application do
  @moduledoc """
  OTP application entrypoint that starts core supervisors and workers.
  """

  use Application

  @impl true
  def start(_type, _args) do
    :ok = SymphonyElixir.LogFile.configure()
    :ok = SymphonyElixir.Diagnostic.ContainerInventory.emit_startup_log()

    children =
      [
        {Phoenix.PubSub, name: SymphonyElixir.PubSub},
        {Task.Supervisor, name: SymphonyElixir.TaskSupervisor},
        {Registry, keys: :unique, name: SymphonyElixir.Manager.Scheduler.Registry},
        SymphonyElixir.WorkflowStore,
        SymphonyElixir.RepoCache.Registry,
        SymphonyElixir.Orchestrator.WorkerSlotReservations,
        SymphonyElixir.RuntimeLease.Registry,
        SymphonyElixir.LocalRuntime.Registry,
        SymphonyElixir.Cutover.Cooldown,
        SymphonyElixir.CloudExecution.Aws.TaskStore,
        SymphonyElixir.LocalRelay.Registry,
        SymphonyElixir.Gateway.SessionStore,
        SymphonyElixir.LocalRelay.Presence,
        SymphonyElixir.Manager.Supervisor,
        SymphonyElixir.Manager.Bootstrapper,
        SymphonyElixir.ScheduledTask.Supervisor
      ] ++
        maybe_api_tracker() ++
        [
          {SymphonyElixir.BrokerLog.Reconciler, []},
          SymphonyElixir.Orchestrator,
          SymphonyElixir.HttpServer,
          SymphonyElixir.StatusDashboard
        ]

    Supervisor.start_link(
      children,
      strategy: :one_for_one,
      name: SymphonyElixir.Supervisor
    )
  end

  @impl true
  def prep_stop(state) do
    _ = SymphonyElixir.LocalRelay.Registry.drain_all(:server_draining)
    state
  catch
    :exit, _reason -> state
  end

  defp maybe_api_tracker do
    case SymphonyElixir.Config.settings() do
      {:ok, %{tracker: %{kind: "api"}}} -> [SymphonyElixir.Tracker.API]
      _ -> []
    end
  end

  @impl true
  def stop(_state) do
    SymphonyElixir.StatusDashboard.render_offline_status()
    :ok
  end
end
