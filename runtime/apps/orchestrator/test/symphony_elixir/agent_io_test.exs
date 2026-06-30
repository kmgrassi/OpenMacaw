defmodule SymphonyElixir.AgentIOTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.AgentIO

  defmodule FakeRunner do
    def start_session(config, workspace) do
      send(config.owner, {:fake_start_session, workspace})
      {:ok, %{runner: "fake", session_id: "runner-session-1", model: "fake-model", owner: config.owner}}
    end

    def run_turn(session, prompt, work_item) do
      send(session.owner, {:fake_run_turn, prompt, work_item.id})
      session.on_message.(%{event: :notification, payload: %{"params" => %{"textDelta" => "hello"}}})
      {:ok, %{"output_text" => "hello", "usage" => %{"input_tokens" => 1, "output_tokens" => 1}}}
    end

    def send_input(session, input, work_item, opts) do
      session
      |> Map.put(:on_message, Keyword.fetch!(opts, :on_message))
      |> run_turn(input, work_item)
    end

    def interrupt(_session, _opts), do: {:error, :interrupt_not_supported}

    def stop_session(session) do
      send(session.owner, {:fake_stop_session, session.session_id})
      :ok
    end
  end

  defmodule SlowRunner do
    def start_session(config, _workspace) do
      {:ok, %{runner: "slow", session_id: "slow-session-1", owner: config.owner}}
    end

    def run_turn(session, prompt, _work_item) do
      send(session.owner, {:slow_run_turn, prompt})

      receive do
        :release -> {:ok, %{"output_text" => "released"}}
      after
        30_000 -> {:ok, %{"output_text" => "late"}}
      end
    end

    def send_input(session, input, work_item, _opts), do: run_turn(session, input, work_item)

    def interrupt(_session, _opts), do: {:error, :interrupt_not_supported}

    def stop_session(session) do
      send(session.owner, {:slow_stop_session, session.session_id})
      :ok
    end
  end

  test "send_message starts a live session and streams normalized events" do
    key = unique_key()

    assert {:ok, snapshot} =
             AgentIO.subscribe(key, self(),
               runner: FakeRunner,
               config: %{owner: self()},
               workspace: "/tmp/workspace",
               idle_timeout_ms: 0
             )

    assert snapshot.session_key == key
    assert snapshot.runner == "fake_runner"
    assert snapshot.session_id == "runner-session-1"

    assert {:ok, %{session_key: ^key, turn_id: turn_id}} = AgentIO.send_message(key, "hello")

    assert_receive {:fake_start_session, "/tmp/workspace"}
    assert_receive {:fake_run_turn, "hello", ^key}
    assert_receive {:agent_io_event, ^key, %{event: :turn_started, turn_id: ^turn_id}}
    assert_receive {:agent_io_event, ^key, %{event: :notification, turn_id: ^turn_id, payload: %{"params" => %{"textDelta" => "hello"}}}}
    assert_receive {:agent_io_event, ^key, %{event: :turn_completed, turn_id: ^turn_id, payload: %{output_text: "hello"}}}
  end

  test "send_message rejects concurrent turns for the same live session" do
    key = unique_key()

    assert {:ok, _snapshot} =
             AgentIO.subscribe(key, self(),
               runner: SlowRunner,
               config: %{owner: self()},
               idle_timeout_ms: 0
             )

    assert {:ok, _turn} = AgentIO.send_message(key, "first")
    assert_receive {:slow_run_turn, "first"}

    assert {:error, :turn_already_active} = AgentIO.send_message(key, "second")
  end

  test "interrupt kills the active turn and tears down the runner session" do
    key = unique_key()

    assert {:ok, _snapshot} =
             AgentIO.subscribe(key, self(),
               runner: SlowRunner,
               config: %{owner: self()},
               idle_timeout_ms: 0
             )

    assert {:ok, %{turn_id: turn_id}} = AgentIO.send_message(key, "stop me")
    assert_receive {:slow_run_turn, "stop me"}

    assert :ok = AgentIO.interrupt(key)

    assert_receive {:slow_stop_session, "slow-session-1"}
    assert_receive {:agent_io_event, ^key, %{event: :turn_ended_with_error, turn_id: ^turn_id, payload: %{"reason" => "interrupted"}}}
  end

  test "enforces the configured live session cap" do
    first_key = unique_key()
    second_key = unique_key()
    max_sessions = AgentIO.stats().active_sessions + 1

    assert {:ok, pid} =
             AgentIO.ensure_session(first_key,
               runner: FakeRunner,
               config: %{owner: self()},
               idle_timeout_ms: 0,
               max_sessions: max_sessions
             )

    assert {:error, :session_limit_exceeded} =
             AgentIO.ensure_session(second_key,
               runner: FakeRunner,
               config: %{owner: self()},
               idle_timeout_ms: 0,
               max_sessions: max_sessions
             )

    Process.exit(pid, :normal)
  end

  test "emits lifecycle telemetry for sessions and turns" do
    key = unique_key()
    parent = self()
    handler_id = "agent-io-lifecycle-test-#{System.unique_integer([:positive])}"

    events = [
      [:symphony_elixir, :agent_io, :session, :started],
      [:symphony_elixir, :agent_io, :runner_session, :started],
      [:symphony_elixir, :agent_io, :turn, :started],
      [:symphony_elixir, :agent_io, :turn, :completed]
    ]

    :telemetry.attach_many(
      handler_id,
      events,
      fn event, measurements, metadata, _config ->
        send(parent, {:agent_io_telemetry, event, measurements, metadata})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    assert {:ok, _snapshot} =
             AgentIO.subscribe(key, self(),
               runner: FakeRunner,
               config: %{owner: self()},
               idle_timeout_ms: 0
             )

    assert {:ok, %{turn_id: turn_id}} = AgentIO.send_message(key, "hello")

    assert_receive {:agent_io_telemetry, [:symphony_elixir, :agent_io, :session, :started], %{count: 1}, %{session_key: ^key}}
    assert_receive {:agent_io_telemetry, [:symphony_elixir, :agent_io, :runner_session, :started], %{count: 1}, %{session_key: ^key}}
    assert_receive {:agent_io_telemetry, [:symphony_elixir, :agent_io, :turn, :started], %{count: 1}, %{session_key: ^key, turn_id: ^turn_id}}
    assert_receive {:agent_io_telemetry, [:symphony_elixir, :agent_io, :turn, :completed], %{count: 1}, %{session_key: ^key, turn_id: ^turn_id}}
  end

  test "stale idle timeout messages do not stop an active runner session" do
    key = unique_key()

    assert {:ok, pid} =
             AgentIO.ensure_session(key,
               runner: SlowRunner,
               config: %{owner: self()},
               idle_timeout_ms: 60_000
             )

    assert {:ok, _snapshot} = AgentIO.subscribe(key, self())
    assert {:error, :no_active_turn} = AgentIO.interrupt(key)

    %{idle_timer_ref: stale_ref} = :sys.get_state(pid)
    assert is_reference(stale_ref)

    assert {:ok, _turn} = AgentIO.send_message(key, "active")
    assert_receive {:slow_run_turn, "active"}

    send(pid, {:timeout, stale_ref, :idle_timeout})

    refute_receive {:slow_stop_session, "slow-session-1"}, 100
    assert {:error, :turn_already_active} = AgentIO.send_message(key, "still active")

    assert :ok = AgentIO.interrupt(key)
    assert_receive {:slow_stop_session, "slow-session-1"}
  end

  test "idle timeout stops the session process so caps reclaim idle keys" do
    key = unique_key()

    assert {:ok, pid} =
             AgentIO.ensure_session(key,
               runner: FakeRunner,
               config: %{owner: self()},
               idle_timeout_ms: 60_000
             )

    monitor_ref = Process.monitor(pid)

    assert {:ok, _snapshot} = AgentIO.subscribe(key, self())
    assert_receive {:fake_start_session, nil}

    %{idle_timer_ref: nil} = :sys.get_state(pid)
    assert {:error, :no_active_turn} = AgentIO.interrupt(key)

    %{idle_timer_ref: idle_ref} = :sys.get_state(pid)
    assert is_reference(idle_ref)

    send(pid, {:timeout, idle_ref, :idle_timeout})

    assert_receive {:fake_stop_session, "runner-session-1"}
    assert_receive {:DOWN, ^monitor_ref, :process, ^pid, :normal}

    assert AgentIO.interrupt(key) == :error
  end

  defp unique_key do
    "agent-io-test-#{System.unique_integer([:positive])}"
  end
end
