defmodule SymphonyElixir.Runner.CodingRunnerTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.CodingRunner
  alias SymphonyElixir.Runner.Contract
  alias SymphonyElixir.WorkItem

  test "delegates session I/O to a concrete coding adapter" do
    session = %{session_id: "session-1"}
    work_item = work_item()

    assert {:ok, %{session_id: "session-1"}} =
             CodingRunner.start_session(SymphonyElixir.Runner.CodingRunnerTest.Adapter, %{"model" => "test"}, "/tmp/work")

    assert {:ok, %{prompt: "follow up"}} =
             CodingRunner.send_input(SymphonyElixir.Runner.CodingRunnerTest.Adapter, session, %{"message" => "follow up"}, work_item)

    assert :ok = CodingRunner.interrupt(SymphonyElixir.Runner.CodingRunnerTest.Adapter, session)
    assert :ok = CodingRunner.stop_session(SymphonyElixir.Runner.CodingRunnerTest.Adapter, session)

    assert %{input: :turn, output_stream: :runner_events, interrupt: :supported, tool_activity: true} =
             CodingRunner.stream_capabilities(SymphonyElixir.Runner.CodingRunnerTest.Adapter)
  end

  test "normalizes coding input from strings and message maps" do
    assert {:ok, "hello"} = Contract.normalize_coding_input(" hello ")
    assert {:ok, "hello"} = Contract.normalize_coding_input(%{"message" => "hello"})
    assert {:ok, "hello"} = Contract.normalize_coding_input(%{prompt: "hello"})
    assert {:error, :invalid_coding_input} = Contract.normalize_coding_input(" ")
    assert {:error, :invalid_coding_input} = Contract.normalize_coding_input(%{})
  end

  defp work_item do
    %WorkItem{
      id: "wi-1",
      identifier: "TEST-1",
      title: "Test item",
      description: "Test",
      state: "Todo",
      source: "test",
      labels: [],
      metadata: %{}
    }
  end
end

defmodule SymphonyElixir.Runner.CodingRunnerTest.Adapter do
  @behaviour SymphonyElixir.Runner.CodingRunner

  alias SymphonyElixir.Runner.Contract

  def start_session(_config, _workspace), do: {:ok, %{session_id: "session-1"}}

  @impl true
  def send_input(session, input, _work_item, _opts) do
    with {:ok, prompt} <- Contract.normalize_coding_input(input) do
      {:ok, Map.put(session, :prompt, prompt)}
    end
  end

  @impl true
  def interrupt(_session, _opts), do: :ok

  def stop_session(_session), do: :ok

  @impl true
  def stream_capabilities do
    Contract.coding_capabilities(interrupt: :supported)
  end
end
