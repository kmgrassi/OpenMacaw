defmodule SymphonyElixir.ExecutionProfileTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.ExecutionProfile
  alias SymphonyElixir.Schema.ExecutionProfile, as: ExecutionProfileSchema

  describe "resolve_coding/3" do
    test "uses a supplied coding execution profile from work item metadata" do
      work_item =
        build_work_item(%{
          "execution_profile" => %{
            "role" => "coding",
            "runner_kind" => "codex",
            "provider" => "anthropic",
            "model" => "claude-sonnet-test",
            "credential_ref" => "credential-alias:anthropic",
            "adapter_config" => %{"command" => "codex app-server"}
          }
        })

      assert {:ok, profile} = ExecutionProfile.resolve_coding(work_item, %{})
      assert profile["runner_kind"] == "codex"
      assert profile["provider"] == "anthropic"
      assert profile["model"] == "claude-sonnet-test"

      assert ExecutionProfile.runner_config(profile, %{}) == %{
               "command" => "codex app-server",
               "credential_ref" => "credential-alias:anthropic",
               "model" => "claude-sonnet-test",
               "model_provider" => "anthropic",
               "provider" => "anthropic"
             }
    end

    test "falls back to the legacy Codex runner as a coding execution profile" do
      work_item = build_work_item(%{})

      assert {:ok, profile} = ExecutionProfile.resolve_coding(work_item, %{"default" => "codex"})
      assert profile["role"] == "coding"
      assert profile["runner_kind"] == "codex"
      assert profile["provider"] == "openai_codex"
      assert get_in(profile, ["source_metadata", "fallback_used"]) == true
    end

    test "rejects unsupported runner kinds with a typed error" do
      work_item =
        build_work_item(%{
          "execution_profile" => %{
            "role" => "coding",
            "runner_kind" => "not-a-runner",
            "provider" => "local"
          }
        })

      assert {:error, {:unsupported_runner_kind, "not-a-runner"}} =
               ExecutionProfile.resolve_coding(work_item, %{})
    end

    test "accepts local_relay execution profiles" do
      work_item =
        build_work_item(%{
          "execution_profile" => %{
            "role" => "coding",
            "runner_kind" => "local_relay",
            "provider" => "local",
            "model" => "qwen2.5-coder:latest",
            "adapter_config" => %{
              "workspace_id" => "workspace-1",
              "target_runner_kind" => "openai_compatible"
            }
          }
        })

      assert {:ok, profile} = ExecutionProfile.resolve_coding(work_item, %{})
      assert {:ok, SymphonyElixir.Runner.LocalRelay} = ExecutionProfile.runner_module(profile)

      assert ExecutionProfile.runner_config(profile, %{})["target_runner_kind"] ==
               "openai_compatible"
    end

    # `local_relay_socket.ex` already accepts `openclaw` in
    # `RegisterFrame.runner_kinds`; these tests pin the reader side of the
    # routing-rule `provider` → `Runner.LocalRelay.target_runner_kind` thread
    # described in `docs/local-openclaw-helper-scope.md` (PR 4).
    test "threads routing-rule provider 'openclaw' into target_runner_kind for local_relay" do
      work_item =
        build_work_item(%{
          "execution_profile" => %{
            "role" => "coding",
            "runner_kind" => "local_relay",
            "provider" => "openclaw"
          }
        })

      assert {:ok, profile} = ExecutionProfile.resolve_coding(work_item, %{})
      assert {:ok, SymphonyElixir.Runner.LocalRelay} = ExecutionProfile.runner_module(profile)
      assert ExecutionProfile.runner_config(profile, %{})["target_runner_kind"] == "openclaw"
    end

    test "threads runtime-family providers (codex, computer_use) into target_runner_kind" do
      for provider <- ~w(codex computer_use) do
        work_item =
          build_work_item(%{
            "execution_profile" => %{
              "role" => "coding",
              "runner_kind" => "local_relay",
              "provider" => provider
            }
          })

        assert {:ok, profile} = ExecutionProfile.resolve_coding(work_item, %{})

        assert ExecutionProfile.runner_config(profile, %{})["target_runner_kind"] == provider,
               "expected provider=#{provider} to thread into target_runner_kind"
      end
    end

    test "falls back to LocalRelay's default target_runner_kind when provider is 'local' or unset" do
      local_provider =
        build_work_item(%{
          "execution_profile" => %{
            "role" => "coding",
            "runner_kind" => "local_relay",
            "provider" => "local"
          }
        })

      assert {:ok, profile} = ExecutionProfile.resolve_coding(local_provider, %{})
      refute Map.has_key?(ExecutionProfile.runner_config(profile, %{}), "target_runner_kind")

      # When the config-level key is missing, `Runner.LocalRelay.start_session`
      # falls back to `@default_target_runner_kind = "openai_compatible"`
      # (`runner/local_relay.ex:18,254-260`).
      {:ok, session} =
        SymphonyElixir.Runner.LocalRelay.start_session(
          Map.put(ExecutionProfile.runner_config(profile, %{}), "workspace_id", "ws-1"),
          nil
        )

      assert session.target_runner_kind == "openai_compatible"
    end

    test "does not set target_runner_kind for non-local_relay runners even when provider matches" do
      work_item =
        build_work_item(%{
          "execution_profile" => %{
            "role" => "coding",
            "runner_kind" => "openclaw",
            "provider" => "openclaw"
          }
        })

      assert {:ok, profile} = ExecutionProfile.resolve_coding(work_item, %{})
      refute Map.has_key?(ExecutionProfile.runner_config(profile, %{}), "target_runner_kind")
    end

    test "accepts local_model_coding execution profiles" do
      work_item =
        build_work_item(%{
          "execution_profile" => %{
            "role" => "coding",
            "runner_kind" => "local_model_coding",
            "provider" => "openai_compatible",
            "model" => "qwen2.5-coder"
          }
        })

      assert {:ok, profile} = ExecutionProfile.resolve_coding(work_item, %{})
      assert profile["runner_kind"] == "local_model_coding"

      assert {:ok, SymphonyElixir.Runner.LocalModelCoding} =
               ExecutionProfile.runner_module(profile)
    end

    test "rejects llm_tool_runner as a concrete coding runner" do
      work_item =
        build_work_item(%{
          "execution_profile" => %{
            "role" => "coding",
            "runner_kind" => "llm_tool_runner",
            "provider" => "openai"
          }
        })

      assert {:error, {:unsupported_runner_kind, "llm_tool_runner"}} =
               ExecutionProfile.resolve_coding(work_item, %{})
    end

    test "accepts claude_code execution profiles" do
      work_item =
        build_work_item(%{
          "execution_profile" => %{
            "role" => "coding",
            "runner_kind" => "claude_code",
            "provider" => "anthropic",
            "model" => "sonnet",
            "credential_ref" => "credential_alias:anthropic/default",
            "adapter_config" => %{"permission_mode" => "acceptEdits"}
          }
        })

      assert {:ok, profile} = ExecutionProfile.resolve_coding(work_item, %{})
      assert profile["runner_kind"] == "claude_code"
      assert profile["provider"] == "anthropic"
      assert {:ok, SymphonyElixir.Runner.ClaudeCode} = ExecutionProfile.runner_module(profile)
      assert ExecutionProfile.runner_config(profile, %{})["permission_mode"] == "acceptEdits"
    end

    test "respects per-issue runner labels in the legacy fallback path" do
      # Without an explicit profile, label-based routing must still win so
      # mixed-runner workflows like `runner:openclaw` keep working.
      work_item =
        %WorkItem{
          id: "wi-label",
          identifier: "TEST-LABEL",
          title: "Labeled work item",
          description: "Test",
          state: "Todo",
          source: "test",
          labels: ["runner:openclaw"],
          metadata: %{}
        }

      assert {:ok, profile} = ExecutionProfile.resolve_coding(work_item, %{"default" => "codex"})
      assert profile["runner_kind"] == "openclaw"
      assert get_in(profile, ["source_metadata", "fallback_used"]) == true
    end

    test "routes local_relay labels and explicit profiles to the local relay runner" do
      work_item =
        %WorkItem{
          id: "wi-local",
          identifier: "TEST-LOCAL",
          title: "Labeled local work item",
          description: "Test",
          state: "Todo",
          source: "test",
          labels: ["runner:local_relay"],
          metadata: %{}
        }

      assert {:ok, profile} = ExecutionProfile.resolve_coding(work_item, %{"default" => "codex"})
      assert profile["runner_kind"] == "local_relay"
      assert profile["provider"] == "local"
      assert {:ok, SymphonyElixir.Runner.LocalRelay} = ExecutionProfile.runner_module(profile)

      explicit =
        build_work_item(%{
          "execution_profile" => %{
            "role" => "coding",
            "runner_kind" => "local_relay",
            "provider" => "local"
          }
        })

      assert {:ok, profile} = ExecutionProfile.resolve_coding(explicit, %{})
      assert {:ok, SymphonyElixir.Runner.LocalRelay} = ExecutionProfile.runner_module(profile)
    end
  end

  describe "normalize_from_config/1" do
    test "normalizes explicit resolved execution profile metadata" do
      assert {:ok, profile} =
               ExecutionProfile.normalize_from_config(%{
                 "resolved_execution_profile" => %{
                   "runner" => "codex",
                   "provider" => "openai_codex",
                   "model" => "gpt-5.2",
                   "api_key" => "sk-test",
                   "source_metadata" => %{"routing_rule_id" => "route-1"}
                 }
               })

      assert profile["runner_kind"] == "codex"
      assert profile["provider"] == "openai_codex"
      assert profile["model"] == "gpt-5.2"
      assert profile["api_key"] == "[REDACTED]"

      assert ExecutionProfile.log_fields(profile) == %{
               runner: "codex",
               provider: "openai_codex",
               model: "gpt-5.2",
               profile_source: "route-1"
             }
    end

    test "returns typed errors for missing or unsupported explicit profile fields" do
      assert {:error, {:missing_execution_profile_field, "runner_kind"}} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{"provider" => "openai"}
               })

      assert {:error, {:missing_execution_profile_field, "provider"}} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{"runner_kind" => "codex"}
               })

      assert {:error, {:unsupported_execution_profile_runner, "bogus"}} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{"runner_kind" => "bogus", "provider" => "openai"}
               })

      assert {:error, {:unsupported_execution_profile_provider, "bogus"}} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{"runner_kind" => "codex", "provider" => "bogus"}
               })
    end

    test "returns a typed error for malformed agent ids" do
      assert {:error, {:invalid_execution_profile_field, "agent_id"}} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{
                   "agent_id" => %{"id" => "agent-1"},
                   "runner_kind" => "codex",
                   "provider" => "openai"
                 }
               })
    end

    test "normalizes explicit local_relay profiles from config" do
      assert {:ok, profile} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{"runner_kind" => "local_relay", "provider" => "local"}
               })

      assert profile["runner_kind"] == "local_relay"
      assert profile["provider"] == "local"
    end

    test "preserves string credential refs from explicit profiles" do
      assert {:ok, profile} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{
                   "runner_kind" => "codex",
                   "provider" => "openai",
                   "credential_ref" => "credential_alias:default-openai"
                 }
               })

      assert profile["credential_ref"] == "credential_alias:default-openai"
    end

    test "maps generic llm_tool_runner profiles to concrete runtime adapters by role" do
      assert {:ok, manager} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{
                   "role" => "manager",
                   "runner_kind" => "llm_tool_runner",
                   "provider" => "openai"
                 }
               })

      assert manager["runner_kind"] == "manager"
      assert {:ok, SymphonyElixir.Runner.LlmToolRunner} = ExecutionProfile.runner_module(manager)

      assert {:ok, planner} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{
                   "role" => "planning",
                   "runner_kind" => "llm_tool_runner",
                   "provider" => "openai"
                 }
               })

      assert planner["runner_kind"] == "planner"
      assert {:ok, SymphonyElixir.Runner.Planner} = ExecutionProfile.runner_module(planner)
    end

    test "normalizes explicit claude_code profiles from config" do
      assert {:ok, profile} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{
                   "runner_kind" => "claude_code",
                   "provider" => "anthropic",
                   "model" => "sonnet"
                 }
               })

      assert profile["runner_kind"] == "claude_code"
      assert profile["provider"] == "anthropic"
      assert profile["model"] == "sonnet"
    end

    test "derives a safe legacy fallback profile without requiring platform metadata" do
      assert {:ok, profile} =
               ExecutionProfile.normalize_from_config(%{
                 "stored_agent" => %{
                   "type" => "coding",
                   "model_settings" => %{"primary" => "openai/gpt-5.2"}
                 }
               })

      assert profile["runner_kind"] == "codex"
      assert profile["provider"] == "openai"
      assert profile["model"] == "gpt-5.2"
      assert profile["source_metadata"]["fallback_used"] == true
    end

    test "fallback profile accepts legacy providers outside the explicit allowlist" do
      # Legacy configs may set codex.model_provider to providers not in
      # @supported_providers. The fallback path must not reject them.
      assert {:ok, profile} =
               ExecutionProfile.normalize_from_config(%{
                 "codex" => %{
                   "model_provider" => "legacy-internal-provider",
                   "model" => "internal/legacy-model"
                 }
               })

      assert profile["provider"] == "legacy-internal-provider"
      assert profile["model"] == "legacy-model"
      assert profile["source_metadata"]["fallback_used"] == true
    end

    # Round-trip coverage for the platform → runtime runner_kind mapping.
    # The platform's RUNNER_KINDS (contracts/runner-kinds.ts) is wider than
    # the runtime's Schema.ExecutionProfile @supported_runner_kinds because
    # the runtime keeps an internal vocabulary (manager / planner) and
    # `normalize_family_runner_kind/2` translates the platform's
    # `llm_tool_runner` to those names based on role. Pin every
    # platform-written value here so a future platform addition that
    # doesn't get a normalizer mapping fails fast.

    test "normalizes llm_tool_runner with manager role to manager" do
      assert {:ok, profile} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{
                   "runner_kind" => "llm_tool_runner",
                   "role" => "manager",
                   "provider" => "openai"
                 }
               })

      assert profile["runner_kind"] == "manager"
    end

    test "normalizes llm_tool_runner with learning role to manager" do
      assert {:ok, profile} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{
                   "runner_kind" => "llm_tool_runner",
                   "role" => "learning",
                   "provider" => "openai"
                 }
               })

      assert profile["runner_kind"] == "manager"
    end

    test "normalizes llm_tool_runner with planning role to planner" do
      assert {:ok, profile} =
               ExecutionProfile.normalize_from_config(%{
                 "execution_profile" => %{
                   "runner_kind" => "llm_tool_runner",
                   "role" => "planning",
                   "provider" => "openai"
                 }
               })

      assert profile["runner_kind"] == "planner"
    end

    test "passes through runner_kinds that already match the runtime vocabulary" do
      for runner_kind <- ExecutionProfileSchema.supported_runner_kinds() do
        assert {:ok, profile} =
                 ExecutionProfile.normalize_from_config(%{
                   "execution_profile" => %{
                     "runner_kind" => runner_kind,
                     "provider" => "openai",
                     "role" => "coding"
                   }
                 }),
               "expected #{runner_kind} to be accepted by normalize_from_config"

        assert profile["runner_kind"] == runner_kind
      end
    end

    test "rejects platform-only runner_kinds that don't have a normalizer mapping" do
      # These platform values (openclaw_http_sse, local_runtime, and
      # llm_tool_runner without a manager/planning role)
      # have no entry in normalize_family_runner_kind/2 today and the
      # schema's allowlist doesn't include them. If they reach the
      # explicit-profile path, they correctly surface
      # :unsupported_execution_profile_runner.
      for runner_kind <- ~w(openclaw_http_sse local_runtime) do
        assert {:error, {:unsupported_execution_profile_runner, ^runner_kind}} =
                 ExecutionProfile.normalize_from_config(%{
                   "execution_profile" => %{
                     "runner_kind" => runner_kind,
                     "provider" => "openai",
                     "role" => "coding"
                   }
                 }),
               "expected #{runner_kind} to be rejected"
      end
    end
  end

  describe "sanitize/1" do
    test "redacts secret-shaped keys at every nesting level" do
      sanitized =
        ExecutionProfile.sanitize(%{
          "provider" => "openai",
          "api_key" => "sk-secret",
          "adapter_config" => %{
            "headers" => %{"authorization_token" => "Bearer abc"},
            "private_key" => "pk"
          }
        })

      assert sanitized["api_key"] == "[REDACTED]"
      assert sanitized["adapter_config"]["headers"]["authorization_token"] == "[REDACTED]"
      assert sanitized["adapter_config"]["private_key"] == "[REDACTED]"
      assert sanitized["provider"] == "openai"
    end
  end

  defp build_work_item(metadata) do
    %WorkItem{
      id: "wi-1",
      identifier: "TEST-1",
      title: "Test item",
      description: "Test",
      state: "Todo",
      source: "test",
      labels: [],
      metadata: metadata
    }
  end
end
