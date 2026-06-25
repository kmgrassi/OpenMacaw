defmodule SymphonyElixir.Launcher.Supervisor do
  @moduledoc """
  Supervision tree for the Launcher process.

  Supervises:
  - `Task.Supervisor` — required by orchestrators for async dispatch
  - `Phoenix.PubSub` — required by manager workspace lifecycle subscriptions
  - `Launcher.ConfigRegistry` — per-instance config isolation
  - `Manager.Supervisor` — per-workspace manager schedulers and bootstrap wiring
  - `DynamicSupervisor` — supervises individual orchestrator processes
  - `WorkerBridge.Server` — spawns credential-backed worker subprocesses for external callers
  - `Launcher.Server` — GenServer managing orchestrator lifecycle
  - `Bandit` — HTTP server for the Launcher API (Router)

  The TaskSupervisor, ConfigRegistry, and DynamicSupervisor must start before
  the Server, because the Server may restore persisted orchestrators on init
  and needs all of them to be available. The worker bridge starts in the same
  supervisor tree so the launcher can expose `/worker-bridge/*` APIs on port
  `4100` as soon as the launcher boots.

  ## Network binding

  Bandit binds to `127.0.0.1` by default — the launcher control plane is
  never intended to be internet-reachable. The authoritative discussion is
  in `docs/auth-jwt-design.md`; the short version is that we rely on network
  isolation so the runtime can trust `user_id` supplied by the platform
  proxy without verifying a JWT on its end. A loopback default keeps that
  assumption intact even in single-host or sidecar deployment topologies.

  Override via `LAUNCHER_BIND_HOST` when deliberately exposing the launcher
  on a non-loopback interface (for example, `0.0.0.0` inside an ECS task
  whose ENI is only reachable from an internal ALB).
  """

  use Supervisor

  @spec start_link(keyword()) :: Supervisor.on_start()
  def start_link(opts \\ []) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(opts) do
    port = Keyword.get(opts, :port, launcher_port())
    ip = Keyword.get(opts, :ip, launcher_bind_ip())

    children =
      [
        {Phoenix.PubSub, name: SymphonyElixir.PubSub},
        {Task.Supervisor, name: SymphonyElixir.TaskSupervisor},
        {Registry, keys: :unique, name: SymphonyElixir.AgentIO.SessionRegistry},
        {DynamicSupervisor, name: SymphonyElixir.AgentIO.SessionSupervisor, strategy: :one_for_one},
        SymphonyElixir.Launcher.ConfigRegistry,
        SymphonyElixir.WorkflowStore,
        SymphonyElixir.Orchestrator.WorkerSlotReservations,
        SymphonyElixir.RuntimeLease.Registry,
        SymphonyElixir.Gateway.SessionStore,
        # The relay lives in the launcher — the always-on control plane — so the
        # manager (which also runs here and dispatches via
        # LocalRelay.Registry.lookup) shares a node with the helper sockets.
        # It's an isolated subtree with its own restart budget so a crash-looping
        # relay endpoint can't exhaust this supervisor's budget and take down
        # orchestrator launching / Codex dispatch. Started before the manager so
        # the registry is available when the manager first dispatches.
        SymphonyElixir.LocalRelay.Supervisor,
        {Registry, keys: :unique, name: SymphonyElixir.Manager.Scheduler.Registry},
        SymphonyElixir.Manager.Supervisor,
        SymphonyElixir.Manager.Bootstrapper,
        SymphonyElixir.ScheduledTask.Supervisor,
        {DynamicSupervisor, name: SymphonyElixir.Launcher.DynamicSupervisor, strategy: :one_for_one},
        SymphonyElixir.WorkerBridge.Server,
        {SymphonyElixir.Launcher.Server, opts},
        {Bandit, plug: SymphonyElixir.Launcher.Router, port: port, ip: ip, scheme: :http}
      ]

    Supervisor.init(children, strategy: :one_for_one)
  end

  defp launcher_port do
    with raw when not is_nil(raw) <- System.get_env("LAUNCHER_PORT"),
         {port, ""} <- Integer.parse(raw) do
      port
    else
      _ -> Application.get_env(:symphony_elixir, :launcher_port, 4100)
    end
  end

  @doc """
  Resolve the Bandit bind IP. Precedence:

    1. `LAUNCHER_BIND_HOST` environment variable (IPv4 or IPv6 literal).
    2. `config :symphony_elixir, :launcher_bind_host` — used by tests.
    3. `127.0.0.1` (loopback) as the safe default.

  Returns a 4- or 8-tuple suitable for Bandit's `:ip` option. An unparseable
  override falls back to loopback rather than crashing the supervisor.
  """
  @spec launcher_bind_ip() :: :inet.ip_address()
  def launcher_bind_ip do
    raw =
      System.get_env("LAUNCHER_BIND_HOST") ||
        Application.get_env(:symphony_elixir, :launcher_bind_host) ||
        "127.0.0.1"

    case parse_bind_host(raw) do
      {:ok, ip} -> ip
      :error -> {127, 0, 0, 1}
    end
  end

  # Validate tuple element types and ranges so a malformed Application-config
  # value (e.g. {999, 0, 0, 1} or {"127", 0, 0, 1}) falls back to loopback
  # rather than being forwarded to Bandit and crashing the listener.
  defp parse_bind_host({a, b, c, d} = ip)
       when is_integer(a) and a in 0..255 and
              is_integer(b) and b in 0..255 and
              is_integer(c) and c in 0..255 and
              is_integer(d) and d in 0..255,
       do: {:ok, ip}

  defp parse_bind_host({a, b, c, d, e, f, g, h} = ip)
       when is_integer(a) and a in 0..65_535 and
              is_integer(b) and b in 0..65_535 and
              is_integer(c) and c in 0..65_535 and
              is_integer(d) and d in 0..65_535 and
              is_integer(e) and e in 0..65_535 and
              is_integer(f) and f in 0..65_535 and
              is_integer(g) and g in 0..65_535 and
              is_integer(h) and h in 0..65_535,
       do: {:ok, ip}

  defp parse_bind_host(host) when is_binary(host) and host != "" do
    case :inet.parse_address(String.to_charlist(host)) do
      {:ok, ip} -> {:ok, ip}
      {:error, _} -> :error
    end
  end

  defp parse_bind_host(_), do: :error
end
