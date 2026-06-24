defmodule SymphonyElixir.Runner.SkillMaterializerTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Runner.SkillMaterializer

  setup do
    workspace =
      Path.join(
        System.tmp_dir!(),
        "skill-materializer-#{System.unique_integer([:positive])}"
      )

    File.mkdir_p!(workspace)
    on_exit(fn -> File.rm_rf(workspace) end)

    %{workspace: workspace}
  end

  test "writes approved skill snapshot to the Codex skill directory", %{workspace: workspace} do
    assert :ok =
             SkillMaterializer.materialize("codex", config([skill("api-debugging", "Inspect API logs.")]), workspace)

    skill_path = Path.join([workspace, ".codex", "skills", "api-debugging", "SKILL.md"])
    assert File.read!(skill_path) =~ ~s(name: "api-debugging")
    assert File.read!(skill_path) =~ ~s(description: "Debug API failures")
    assert File.read!(skill_path) =~ "Inspect API logs."

    manifest_path = Path.join([workspace, ".openmacaw", "materialized-skills", "codex.json"])
    assert File.read!(manifest_path) =~ "api-debugging"
  end

  test "removes stale managed skills while preserving repo-owned skills", %{workspace: workspace} do
    assert :ok =
             SkillMaterializer.materialize("codex", config([skill("api-debugging", "Inspect API logs.")]), workspace)

    repo_skill = Path.join([workspace, ".codex", "skills", "repo-owned"])
    File.mkdir_p!(repo_skill)
    File.write!(Path.join(repo_skill, "SKILL.md"), "repo skill")

    assert :ok =
             SkillMaterializer.materialize("codex", config([skill("new-skill", "Use the new process.")]), workspace)

    refute File.exists?(Path.join([workspace, ".codex", "skills", "api-debugging"]))
    assert File.exists?(Path.join([workspace, ".codex", "skills", "new-skill", "SKILL.md"]))
    assert File.read!(Path.join(repo_skill, "SKILL.md")) == "repo skill"
  end

  test "rejects stale manifest paths outside the managed runner skill directory", %{workspace: workspace} do
    protected_file = Path.join(workspace, "protected.txt")
    File.write!(protected_file, "keep me")

    manifest_path = Path.join([workspace, ".openmacaw", "materialized-skills", "codex.json"])
    File.mkdir_p!(Path.dirname(manifest_path))

    File.write!(
      manifest_path,
      Jason.encode!(%{
        "version" => 1,
        "target" => ".codex/skills",
        "skills" => [
          %{"name" => "old-skill", "path" => "protected.txt"}
        ]
      })
    )

    assert {:error, {:invalid_skill_manifest_path, "protected.txt"}} =
             SkillMaterializer.materialize("codex", config([]), workspace)

    assert File.read!(protected_file) == "keep me"
  end

  test "writes Claude Code skills to .claude/skills", %{workspace: workspace} do
    assert :ok =
             SkillMaterializer.materialize(
               "claude_code",
               config([skill("review-flow", "Review the diff first.")]),
               workspace
             )

    assert File.exists?(Path.join([workspace, ".claude", "skills", "review-flow", "SKILL.md"]))
  end

  defp config(skills) do
    %{
      "skills_snapshot" => %{
        "version" => 1,
        "agentId" => "agent-1",
        "workspaceId" => "workspace-1",
        "skills" => skills
      }
    }
  end

  defp skill(name, body) do
    %{
      "id" => "skill-#{name}",
      "name" => name,
      "description" => "Debug API failures",
      "body" => body,
      "updatedAt" => "2026-06-20T00:00:00.000Z"
    }
  end
end
