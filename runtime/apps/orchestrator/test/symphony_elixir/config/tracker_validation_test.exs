defmodule SymphonyElixir.Config.TrackerValidationTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.Config.Schema

  describe "validate!/0 with tracker kind: linear" do
    test "succeeds with valid linear config" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "linear",
        tracker_api_token: "lin_api_test",
        tracker_project_slug: "my-project"
      )

      assert :ok = Config.validate!()
    end

    test "fails when api_key is missing" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "linear",
        tracker_api_token: nil,
        tracker_project_slug: "my-project"
      )

      prev = System.get_env("LINEAR_API_KEY")
      System.delete_env("LINEAR_API_KEY")

      try do
        assert {:error, :missing_linear_api_token} = Config.validate!()
      after
        restore_env("LINEAR_API_KEY", prev)
      end
    end

    test "fails when project_slug is missing" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "linear",
        tracker_api_token: "lin_api_test",
        tracker_project_slug: nil
      )

      assert {:error, :missing_linear_project_slug} = Config.validate!()
    end
  end

  describe "validate!/0 with tracker kind: database" do
    test "succeeds with valid database config" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "database",
        tracker_endpoint: "https://mydb.supabase.co",
        tracker_api_token: "sb_key_test",
        tracker_table: "work_items"
      )

      assert :ok = Config.validate!()
    end

    test "fails when endpoint is missing" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "database",
        tracker_endpoint: nil,
        tracker_api_token: "sb_key_test",
        tracker_table: "work_items"
      )

      prev_url = System.get_env("SUPABASE_URL")
      System.delete_env("SUPABASE_URL")

      try do
        assert {:error, :missing_database_endpoint} = Config.validate!()
      after
        restore_env("SUPABASE_URL", prev_url)
      end
    end

    test "fails when api_key is missing" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "database",
        tracker_endpoint: "https://mydb.supabase.co",
        tracker_api_token: nil,
        tracker_table: "work_items"
      )

      prev_key = System.get_env("SUPABASE_SERVICE_ROLE_KEY")
      System.delete_env("SUPABASE_SERVICE_ROLE_KEY")

      try do
        assert {:error, :missing_database_api_key} = Config.validate!()
      after
        restore_env("SUPABASE_SERVICE_ROLE_KEY", prev_key)
      end
    end

    test "fails when table is missing" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "database",
        tracker_endpoint: "https://mydb.supabase.co",
        tracker_api_token: "sb_key_test",
        tracker_table: nil
      )

      assert {:error, :missing_database_table} = Config.validate!()
    end
  end

  describe "validate!/0 with tracker kind: github" do
    test "succeeds with valid github config" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "github",
        tracker_api_token: "ghp_test_token",
        tracker_repository: "owner/repo"
      )

      assert :ok = Config.validate!()
    end

    test "fails when repository is missing" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "github",
        tracker_api_token: "ghp_test_token",
        tracker_repository: nil
      )

      assert {:error, :missing_github_repository} = Config.validate!()
    end

    test "fails when api_key is missing" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "github",
        tracker_api_token: nil,
        tracker_repository: "owner/repo"
      )

      prev_linear = System.get_env("LINEAR_API_KEY")
      prev_github = System.get_env("GITHUB_TOKEN")
      System.delete_env("LINEAR_API_KEY")
      System.delete_env("GITHUB_TOKEN")

      try do
        assert {:error, :missing_github_api_key} = Config.validate!()
      after
        restore_env("LINEAR_API_KEY", prev_linear)
        restore_env("GITHUB_TOKEN", prev_github)
      end
    end
  end

  describe "validate!/0 with tracker kind: api" do
    test "succeeds with no additional fields" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "api",
        tracker_api_token: nil,
        tracker_project_slug: nil
      )

      assert :ok = Config.validate!()
    end
  end

  describe "validate!/0 with tracker kind: memory" do
    test "succeeds with no additional fields" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "memory",
        tracker_api_token: nil,
        tracker_project_slug: nil
      )

      assert :ok = Config.validate!()
    end
  end

  describe "validate!/0 with unsupported tracker kind" do
    test "fails with unsupported kind" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "jira"
      )

      assert {:error, {:unsupported_tracker_kind, "jira"}} = Config.validate!()
    end

    test "fails when tracker kind is missing" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: nil
      )

      assert {:error, :missing_tracker_kind} = Config.validate!()
    end
  end

  describe "schema parses new tracker fields" do
    test "database fields are parsed" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "database",
        tracker_endpoint: "https://mydb.supabase.co",
        tracker_api_token: "sb_key",
        tracker_table: "work_items",
        tracker_workspace_id: "00000000-0000-0000-0000-000000000111",
        tracker_plan_id: "00000000-0000-0000-0000-000000000222",
        tracker_runner_type: "codex",
        tracker_comments_table: "comments"
      )

      {:ok, settings} = Config.settings()
      assert settings.tracker.kind == "database"
      assert settings.tracker.endpoint == "https://mydb.supabase.co/rest/v1"
      assert settings.tracker.table == "work_items"
      assert settings.tracker.workspace_id == "00000000-0000-0000-0000-000000000111"
      assert settings.tracker.plan_id == "00000000-0000-0000-0000-000000000222"
      assert settings.tracker.runner_type == "codex"
      assert settings.tracker.comments_table == "comments"
    end

    test "github fields are parsed" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "github",
        tracker_api_token: "ghp_test",
        tracker_repository: "owner/repo",
        tracker_webhook_secret: "whsec_test"
      )

      {:ok, settings} = Config.settings()
      assert settings.tracker.kind == "github"
      assert settings.tracker.repository == "owner/repo"
    end

    test "linear kind gets default endpoint" do
      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "linear",
        tracker_endpoint: nil,
        tracker_api_token: "token",
        tracker_project_slug: "proj"
      )

      {:ok, settings} = Config.settings()
      assert settings.tracker.endpoint == "https://api.linear.app/graphql"
    end

    test "database kind gets Supabase endpoint and key from env" do
      prev_url = System.get_env("SUPABASE_URL")
      prev_key = System.get_env("SUPABASE_SERVICE_ROLE_KEY")
      System.put_env("SUPABASE_URL", "https://env-project.supabase.co")
      System.put_env("SUPABASE_SERVICE_ROLE_KEY", "env-service-key")

      write_workflow_file!(Workflow.workflow_file_path(),
        tracker_kind: "database",
        tracker_endpoint: nil,
        tracker_api_token: nil,
        tracker_table: "items"
      )

      try do
        {:ok, settings} = Config.settings()
        assert settings.tracker.endpoint == "https://env-project.supabase.co/rest/v1"
        assert settings.tracker.api_key == "env-service-key"
      after
        restore_env("SUPABASE_URL", prev_url)
        restore_env("SUPABASE_SERVICE_ROLE_KEY", prev_key)
      end
    end
  end

  describe "env var fallbacks" do
    test "SYMPHONY_REPOSITORY overrides workspace.repository" do
      prev = System.get_env("SYMPHONY_REPOSITORY")
      System.put_env("SYMPHONY_REPOSITORY", "https://github.com/test/from-env")

      try do
        write_workflow_file!(Workflow.workflow_file_path())
        {:ok, settings} = Config.settings()
        assert settings.workspace.repository == "https://github.com/test/from-env"
      after
        restore_env("SYMPHONY_REPOSITORY", prev)
      end
    end

    test "CLI --repo flag takes precedence over SYMPHONY_REPOSITORY" do
      prev = System.get_env("SYMPHONY_REPOSITORY")
      System.put_env("SYMPHONY_REPOSITORY", "https://github.com/test/from-env")
      Application.put_env(:symphony_elixir, :repo_override, "https://github.com/test/from-cli")

      try do
        write_workflow_file!(Workflow.workflow_file_path())
        {:ok, settings} = Config.settings()
        assert settings.workspace.repository == "https://github.com/test/from-cli"
      after
        restore_env("SYMPHONY_REPOSITORY", prev)
        Application.delete_env(:symphony_elixir, :repo_override)
      end
    end

    test "LINEAR_PROJECT_SLUG env var is used when config field is nil" do
      prev = System.get_env("LINEAR_PROJECT_SLUG")
      System.put_env("LINEAR_PROJECT_SLUG", "env-project")

      try do
        write_workflow_file!(Workflow.workflow_file_path(),
          tracker_kind: "linear",
          tracker_api_token: "token",
          tracker_project_slug: nil
        )

        {:ok, settings} = Config.settings()
        assert settings.tracker.project_slug == "env-project"
      after
        restore_env("LINEAR_PROJECT_SLUG", prev)
      end
    end

    test "config project_slug takes precedence over LINEAR_PROJECT_SLUG env var" do
      prev = System.get_env("LINEAR_PROJECT_SLUG")
      System.put_env("LINEAR_PROJECT_SLUG", "env-project")

      try do
        write_workflow_file!(Workflow.workflow_file_path(),
          tracker_kind: "linear",
          tracker_api_token: "token",
          tracker_project_slug: "config-project"
        )

        {:ok, settings} = Config.settings()
        assert settings.tracker.project_slug == "config-project"
      after
        restore_env("LINEAR_PROJECT_SLUG", prev)
      end
    end
  end

  describe "runner config" do
    test "defaults to codex runner" do
      write_workflow_file!(Workflow.workflow_file_path())
      {:ok, settings} = Config.settings()
      assert settings.runners.default == "codex"
    end

    test "parses runner config from schema" do
      assert {:ok, settings} =
               Schema.parse(%{
                 runners: %{
                   default: "openclaw",
                   openclaw: %{base_url: "https://api.openclaw.dev", api_key: "test_key"}
                 }
               })

      assert settings.runners.default == "openclaw"
      assert settings.runners.openclaw["base_url"] == "https://api.openclaw.dev"
      assert settings.runners.openclaw["api_key"] == "test_key"
    end

    test "accepts local_model_coding as a runner default" do
      assert {:ok, settings} =
               Schema.parse(%{
                 runners: %{
                   default: "local_model_coding",
                   local_model_coding: %{model: "qwen2.5-coder"}
                 }
               })

      assert settings.runners.default == "local_model_coding"
      assert settings.runners.local_model_coding["model"] == "qwen2.5-coder"
    end

    test "accepts llm_tool_runner as a runner default without removing codex defaults" do
      assert {:ok, settings} =
               Schema.parse(%{
                 runners: %{
                   default: "llm_tool_runner",
                   codex: %{model: "gpt-5.1-codex"},
                   llm_tool_runner: %{model: "gpt-5.2"}
                 }
               })

      assert settings.runners.default == "llm_tool_runner"
      assert settings.runners.codex["model"] == "gpt-5.1-codex"
      assert settings.runners.llm_tool_runner["model"] == "gpt-5.2"
    end

    test "validates runner default value" do
      assert {:error, {:invalid_workflow_config, message}} =
               Schema.parse(%{
                 runners: %{default: "invalid_runner"}
               })

      assert message =~ "default"
    end

    test "resolves env vars in runner config" do
      env_name = "TEST_RUNNER_KEY_#{System.unique_integer([:positive])}"
      System.put_env(env_name, "resolved_secret")

      try do
        assert {:ok, settings} =
                 Schema.parse(%{
                   runners: %{
                     openclaw: %{api_key: "$#{env_name}", base_url: "https://api.openclaw.dev"}
                   }
                 })

        assert settings.runners.openclaw["api_key"] == "resolved_secret"
      after
        System.delete_env(env_name)
      end
    end

    test "Config.runner_config/0 returns string-keyed map for Runner.resolve compatibility" do
      write_workflow_file!(Workflow.workflow_file_path())
      config = Config.runner_config()
      assert config["default"] == "codex"
      assert is_map(config["codex"])
      assert is_map(config["openclaw"])
      assert is_map(config["computer_use"])
      assert is_map(config["local_relay"])
      assert is_map(config["local_model_coding"])
    end
  end
end
