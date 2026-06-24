defmodule SymphonyElixir.Codex.DynamicTool do
  @moduledoc """
  Compatibility shim for callers that still reference the old dynamic tool API.
  """

  alias SymphonyElixir.ToolRegistry

  @spec execute(String.t() | nil, term(), keyword()) :: map()
  def execute(tool, arguments, opts \\ []) do
    if use_tool_registry?() do
      ToolRegistry.execute_dynamic_response(tool, arguments, opts)
    else
      SymphonyElixir.Codex.LegacyDynamicTool.execute(tool, arguments, opts)
    end
  end

  @spec tool_specs() :: [map()]
  def tool_specs, do: coding_tool_specs()

  @spec coding_tool_specs() :: [map()]
  def coding_tool_specs, do: ToolRegistry.coding_tool_specs()

  @spec universal_tool_specs() :: [map()]
  def universal_tool_specs, do: ToolRegistry.provider_specs(ToolRegistry.bundle(:universal), :openai_compatible)

  @spec planner_tool_specs() :: [map()]
  def planner_tool_specs, do: ToolRegistry.planner_tool_specs()

  @spec agent_communication_tool_specs() :: [map()]
  def agent_communication_tool_specs, do: ToolRegistry.agent_communication_tool_specs()

  defp use_tool_registry?, do: System.get_env("USE_TOOL_REGISTRY", "1") != "0"
end
