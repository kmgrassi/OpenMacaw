defmodule SymphonyElixir.Runner.CodingRunner do
  @moduledoc """
  Shared session I/O contract for coding-agent runners.

  The base `SymphonyElixir.Runner` behaviour owns the durable execution
  lifecycle. This behaviour narrows the live coding-agent surface to the
  operations the streaming I/O layer needs: send a user input into an existing
  session, optionally interrupt an active turn, and advertise stream/control
  capabilities without leaking backend protocol details.
  """

  alias SymphonyElixir.Runner.Contract
  alias SymphonyElixir.WorkItem

  @type session :: SymphonyElixir.Runner.session()
  @type config :: SymphonyElixir.Runner.config()
  @type result :: SymphonyElixir.Runner.result()
  @type input :: Contract.coding_input()
  @type capabilities :: Contract.coding_capabilities()

  @callback send_input(session(), input(), WorkItem.t(), keyword()) ::
              {:ok, result()} | {:error, term()}

  @callback interrupt(session(), keyword()) :: :ok | {:error, term()}

  @callback stream_capabilities() :: capabilities()

  @doc """
  Starts a coding session through a concrete adapter.
  """
  @spec start_session(module(), config(), String.t() | nil) :: {:ok, session()} | {:error, term()}
  def start_session(adapter, config, workspace) when is_atom(adapter) do
    adapter.start_session(config, workspace)
  end

  @doc """
  Sends user input into an existing coding session through a concrete adapter.
  """
  @spec send_input(module(), session(), input(), WorkItem.t(), keyword()) ::
          {:ok, result()} | {:error, term()}
  def send_input(adapter, session, input, work_item, opts \\ []) when is_atom(adapter) do
    adapter.send_input(session, input, work_item, opts)
  end

  @doc """
  Interrupts an active coding session when the adapter supports it.
  """
  @spec interrupt(module(), session(), keyword()) :: :ok | {:error, term()}
  def interrupt(adapter, session, opts \\ []) when is_atom(adapter) do
    adapter.interrupt(session, opts)
  end

  @doc """
  Stops a coding session through a concrete adapter.
  """
  @spec stop_session(module(), session()) :: :ok | {:error, term()}
  def stop_session(adapter, session) when is_atom(adapter) do
    adapter.stop_session(session)
  end

  @doc """
  Returns the backend-neutral streaming/control capabilities for an adapter.
  """
  @spec stream_capabilities(module()) :: capabilities()
  def stream_capabilities(adapter) when is_atom(adapter) do
    adapter.stream_capabilities()
  end
end
