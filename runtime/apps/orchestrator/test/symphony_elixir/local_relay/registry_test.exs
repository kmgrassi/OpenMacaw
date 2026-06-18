defmodule SymphonyElixir.LocalRelay.RegistryTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.LocalRelay.Registry

  setup do
    Registry.reset!()
    on_exit(fn -> Registry.reset!() end)
    :ok
  end

  test "registers helpers by workspace and runner kind" do
    assert {:ok, helper} =
             Registry.register(%{
               workspace_id: "workspace-1",
               machine_id: "machine-1",
               runners: [%{runner_kind: "openai_compatible", provider: "ollama", model: "qwen"}]
             })

    assert helper.workspace_id == "workspace-1"
    assert {:ok, found} = Registry.lookup("workspace-1", "openai_compatible")
    assert found.machine_id == "machine-1"
    assert [%{provider: "ollama", model: "qwen"}] = found.runners
  end

  test "normalizes non-map metadata instead of crashing on heartbeat" do
    assert {:ok, helper} =
             Registry.register(%{
               workspace_id: "workspace-1",
               machine_id: "machine-1",
               runners: [%{runner_kind: "openai_compatible", metadata: "bad"}],
               metadata: "bad"
             })

    assert helper.metadata == %{}
    assert [%{metadata: %{}}] = helper.runners

    assert :ok = Registry.heartbeat("workspace-1", "machine-1", %{"metadata" => "bad heartbeat"})
    assert {:ok, found} = Registry.lookup("workspace-1", "openai_compatible")
    assert found.metadata == %{}

    assert :ok = Registry.heartbeat("workspace-1", "machine-1", %{"metadata" => %{"healthy" => true}})
    assert {:ok, found} = Registry.lookup("workspace-1", "openai_compatible")
    assert found.metadata == %{"healthy" => true}
  end

  test "dispatches correlation-scoped frames and relays progress and completion" do
    assert {:ok, _helper} =
             Registry.register(%{
               workspace_id: "workspace-1",
               machine_id: "machine-1",
               runners: ["openai_compatible"]
             })

    frame = %{"type" => "dispatch", "correlation_id" => "corr-1", "prompt" => "hello"}
    assert {:ok, "corr-1", _helper} = Registry.dispatch("workspace-1", "openai_compatible", frame)
    assert_receive {:local_relay_dispatch, ^frame}

    assert :ok = Registry.progress("corr-1", %{"event" => "message.delta", "text" => "hi"})
    assert_receive {:local_relay_progress, "corr-1", %{"text" => "hi"}}

    assert :ok = Registry.complete("corr-1", %{"output_text" => "hi"})
    assert_receive {:local_relay_complete, "corr-1", %{"output_text" => "hi"}}
  end

  test "returns typed offline, busy, and protocol errors" do
    assert {:error, :local_runtime_offline} =
             Registry.dispatch("workspace-1", "openai_compatible", %{"correlation_id" => "corr-offline"})

    assert {:error, :local_runner_protocol_error} =
             Registry.register(%{workspace_id: "workspace-1", machine_id: "machine-1", runners: []})

    assert {:ok, _helper} =
             Registry.register(%{
               workspace_id: "workspace-1",
               machine_id: "machine-1",
               runners: ["openai_compatible"],
               max_dispatches: 1
             })

    assert {:ok, "corr-1", _helper} =
             Registry.dispatch("workspace-1", "openai_compatible", %{"correlation_id" => "corr-1"})

    assert {:error, :local_runner_busy} =
             Registry.dispatch("workspace-1", "openai_compatible", %{"correlation_id" => "corr-2"})

    assert :ok = Registry.complete("corr-1", %{})
  end

  test "cancel sends a cancel frame to the registered helper" do
    assert {:ok, _helper} =
             Registry.register(%{
               workspace_id: "workspace-1",
               machine_id: "machine-1",
               runners: ["openai_compatible"]
             })

    assert {:ok, "corr-1", _helper} =
             Registry.dispatch("workspace-1", "openai_compatible", %{"correlation_id" => "corr-1"})

    assert :ok = Registry.cancel("corr-1")
    assert_receive {:local_relay_cancel, %{"type" => "cancel", "correlation_id" => "corr-1"}}
  end

  test "drain_all evicts helpers and marks pending dispatches offline" do
    test_pid = self()
    helper_pid = spawn_link(fn -> forward_messages(test_pid) end)

    assert {:ok, _helper} =
             Registry.register(%{
               workspace_id: "workspace-1",
               machine_id: "machine-1",
               pid: helper_pid,
               runners: ["openai_compatible"]
             })

    assert {:ok, "corr-1", _helper} =
             Registry.dispatch("workspace-1", "openai_compatible", %{"correlation_id" => "corr-1"}, caller: self())

    assert_receive {:local_relay_dispatch, %{"correlation_id" => "corr-1"}}

    assert :ok = Registry.drain_all(:server_draining)

    assert_receive {:local_relay_evicted, :server_draining}

    assert_receive {:local_relay_error, "corr-1", %{"error_code" => "local_runtime_offline", "reason" => ":server_draining"}}

    assert {:error, :local_runtime_offline} = Registry.lookup("workspace-1", "openai_compatible")
  end

  test "application prep_stop drains local relay helpers before shutdown" do
    test_pid = self()
    helper_pid = spawn_link(fn -> forward_messages(test_pid) end)

    assert {:ok, _helper} =
             Registry.register(%{
               workspace_id: "workspace-1",
               machine_id: "machine-1",
               pid: helper_pid,
               runners: ["openai_compatible"]
             })

    assert :test_state = SymphonyElixir.Application.prep_stop(:test_state)

    assert_receive {:local_relay_evicted, :server_draining}
    assert {:error, :local_runtime_offline} = Registry.lookup("workspace-1", "openai_compatible")
  end

  test "pid-guarded unregister leaves a newer registration in place" do
    old_pid = spawn_link(fn -> Process.sleep(:infinity) end)
    new_pid = spawn_link(fn -> Process.sleep(:infinity) end)

    assert {:ok, _helper} =
             Registry.register(%{
               workspace_id: "workspace-1",
               machine_id: "machine-1",
               pid: old_pid,
               runners: ["openai_compatible"]
             })

    assert {:ok, _helper} =
             Registry.register(%{
               workspace_id: "workspace-1",
               machine_id: "machine-1",
               pid: new_pid,
               runners: ["openai_compatible"]
             })

    assert :ok = Registry.unregister("workspace-1", "machine-1", old_pid)

    assert {:ok, helper} = Registry.lookup("workspace-1", "openai_compatible")
    assert helper.machine_id == "machine-1"

    assert :ok = Registry.unregister("workspace-1", "machine-1", new_pid)
    assert {:error, :local_runtime_offline} = Registry.lookup("workspace-1", "openai_compatible")
  end

  test "helper re-registration removes stale monitors" do
    old_helper = spawn_link(fn -> Process.sleep(:infinity) end)
    new_helper = spawn_link(fn -> Process.sleep(:infinity) end)

    assert {:ok, _helper} =
             Registry.register(%{
               workspace_id: "workspace-1",
               machine_id: "machine-1",
               pid: old_helper,
               runners: ["openai_compatible"]
             })

    assert {:ok, _helper} =
             Registry.register(%{
               workspace_id: "workspace-1",
               machine_id: "machine-1",
               pid: new_helper,
               runners: ["openai_compatible"]
             })

    Process.exit(old_helper, :normal)
    Process.sleep(10)

    assert {:ok, helper} = Registry.lookup("workspace-1", "openai_compatible")
    assert helper.machine_id == "machine-1"
  end

  defp forward_messages(test_pid) do
    receive do
      message ->
        send(test_pid, message)
        forward_messages(test_pid)
    end
  end
end
