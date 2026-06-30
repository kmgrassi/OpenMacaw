defmodule SymphonyElixir.PolicyGate do
  @moduledoc """
  Shared pre-execution policy gate for runtime tool calls.
  """

  alias SymphonyElixir.Policy.Engine

  @type verdict :: :allow | {:deny, String.t()} | {:ask, String.t()}

  @spec evaluate(map()) :: verdict()
  def evaluate(event), do: evaluate(event, [])

  @spec evaluate(map(), keyword()) :: verdict()
  def evaluate(%{type: :tool_call} = event, opts) when is_map(event) and is_list(opts) do
    Engine.evaluate(event, opts)
  end

  def evaluate(_event, _opts), do: :allow
end
