defmodule SymphonyElixir.Planner.Tools.SkillCreate do
  use SymphonyElixir.Planner.Tools.DatabaseTool, tool_name: "skill.create"

  @impl true
  def bundle, do: [:planner, :manager, :coding, :router]
end
