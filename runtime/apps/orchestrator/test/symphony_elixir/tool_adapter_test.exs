defmodule SymphonyElixir.ToolAdapterTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.ToolAdapter
  alias SymphonyElixir.ToolAdapter.{Anthropic, OpenAI, OpenAICompatible, PromptBased}

  @canonical_cases [
    %{id: "call-empty", name: "shell.exec", arguments: %{}},
    %{id: "call-dotted", name: "scheduled_task.list", arguments: %{"due_only" => true, "limit" => 3}},
    %{
      id: "call-parallel-a",
      name: "plan.create",
      arguments: %{"name" => "Adapter Round Trip", "metadata" => %{"source" => "test"}}
    },
    %{id: "call-parallel-b", name: "task.schedule", arguments: %{"task_id" => "task-1", "priority" => "normal"}}
  ]

  test "canonical to OpenAI-compatible to canonical round-trips across edge cases" do
    provider_response = %{
      "choices" => [
        %{
          "message" => %{
            "tool_calls" => Enum.map(@canonical_cases, &openai_call/1)
          }
        }
      ]
    }

    assert canonical_projection(OpenAICompatible.parse_tool_calls(provider_response)) == @canonical_cases
  end

  test "canonical to Anthropic to canonical round-trips across edge cases" do
    provider_response = %{
      "type" => "message",
      "content" => Enum.map(@canonical_cases, &anthropic_call/1)
    }

    assert canonical_projection(Anthropic.parse_tool_calls(provider_response)) == @canonical_cases
  end

  test "malformed JSON arguments are canonicalized with failure metadata" do
    assert [
             %{
               id: "call-bad",
               name: "scheduled_task.list",
               arguments: %{},
               raw_arguments: "{\"query\"",
               malformed_arguments?: true
             }
           ] =
             OpenAI.parse_tool_calls(%{
               "tool_calls" => [
                 %{
                   "id" => "call-bad",
                   "type" => "function",
                   "function" => %{"name" => "scheduled_task.list", "arguments" => "{\"query\""}
                 }
               ]
             })
  end

  test "prompt-based adapter parses fenced JSON and dotted tool names" do
    text = """
    ```json
    {"tool_call":{"name":"shell.exec","arguments":{"command":"pwd"}}}
    ```
    """

    assert [
             %{id: "call_1", name: "shell.exec", arguments: %{"command" => "pwd"}}
           ] = PromptBased.parse_tool_calls(%{"output_text" => text})
  end

  test "prompt-based adapter parses tagged local model tool calls" do
    text = """
    I'll check.

    <function=scheduled_task.list>
    <parameter=due_only>
    True
    </parameter>
    </function>
    </tool_call>
    """

    assert [
             %{id: "call_1", name: "scheduled_task.list", arguments: %{"due_only" => true}}
           ] = PromptBased.parse_tool_calls(%{"output_text" => text})
  end

  test "tool specs and tool results dispatch through provider adapters" do
    tool = %{"name" => "shell.exec", "description" => "Run command", "inputSchema" => %{"type" => "object"}}

    assert [%{"function" => %{"name" => "shell.exec"}}] = ToolAdapter.to_tool_specs([tool], :openai_compatible)
    assert [%{"name" => "shell.exec", "input_schema" => %{"type" => "object"}}] = ToolAdapter.to_tool_specs([tool], :anthropic)

    assert %{"role" => "tool", "tool_call_id" => "call-1", "content" => "ok"} =
             ToolAdapter.format_tool_result("call-1", %{"output" => "ok"}, :openai_compatible)

    assert %{"type" => "tool_result", "tool_use_id" => "call-1", "content" => "failed", "is_error" => true} =
             ToolAdapter.format_tool_result("call-1", %{"success" => false, "output" => "failed"}, :anthropic)
  end

  defp openai_call(%{id: id, name: name, arguments: arguments}) do
    %{
      "id" => id,
      "type" => "function",
      "function" => %{"name" => name, "arguments" => Jason.encode!(arguments)}
    }
  end

  defp anthropic_call(%{id: id, name: name, arguments: arguments}) do
    %{"type" => "tool_use", "id" => id, "name" => name, "input" => arguments}
  end

  defp canonical_projection(calls) do
    Enum.map(calls, &Map.take(&1, [:id, :name, :arguments]))
  end
end
