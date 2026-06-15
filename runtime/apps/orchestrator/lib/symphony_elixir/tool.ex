defmodule SymphonyElixir.Tool do
  @moduledoc """
  Behaviour for runtime-dispatched tools.

  Tool modules expose provider-facing metadata and an execution callback. The
  registry uses this behaviour as the common boundary across runtime-managed,
  helper-managed, and external tools.
  """

  @typedoc "Tool bundle names used to grant related tools together."
  @type bundle :: atom()

  @typedoc "Where a tool is executed."
  @type execution_kind :: :runtime | :helper | :external

  @typedoc "Decoded JSON object supplied by the model."
  @type arguments :: map()

  @typedoc "Canonical runtime context supplied by the caller dispatching a tool."
  @type context :: SymphonyElixir.ToolExecutionContext.t()

  @doc "Stable tool name used in model tool calls and allowlists."
  @callback name() :: String.t()

  @doc "Human-readable description sent to providers."
  @callback description() :: String.t()

  @doc "JSON Schema object describing accepted tool arguments."
  @callback parameters_schema() :: map()

  @doc "Bundle or bundles this tool belongs to."
  @callback bundle() :: bundle() | [bundle()]

  @doc "Execution location for routing and policy decisions."
  @callback execution_kind() :: execution_kind()

  @doc "Execute the tool with decoded arguments and runtime context."
  @callback execute(arguments(), context()) :: {:ok, map()} | {:error, term()} | map()
end
