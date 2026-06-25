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

  defp unique_key do
    "agent-io-test-#{System.unique_integer([:positive])}"
  end
end
