defmodule SymphonyElixir.ToolSpecTest do
  use SymphonyElixir.TestSupport

  alias SymphonyElixir.ToolSpec

  @schema %{
    "type" => "object",
    "additionalProperties" => false,
    "required" => ["path"],
    "properties" => %{
      "path" => %{"type" => "string"},
      "options" => %{
        "type" => "object",
        "properties" => %{
          "encoding" => %{"type" => "string", "enum" => ["utf8", "base64"]}
        }
      }
    }
  }

  @tool %{
    name: "read_file",
    description: "Run a shell command.",
    parameters_schema: @schema,
    execution_kind: "filesystem_read",
    runner_kind: "local_relay"
  }

  test "translates tools to OpenAI function calling format" do
    assert ToolSpec.to_provider_format([@tool], :openai) == [
             %{
               "type" => "function",
               "function" => %{
                 "name" => "read_file",
                 "description" => "Run a shell command.",
                 "parameters" => @schema
               }
             }
           ]
  end

  test "translates tools to OpenAI-compatible function calling format" do
    assert ToolSpec.translate_tool(@tool, :openai_compatible) == %{
             "type" => "function",
             "function" => %{
               "name" => "read_file",
               "description" => "Run a shell command.",
               "parameters" => @schema
             }
           }
  end

  test "includes examples in provider tool descriptions" do
    tool = Map.put(@tool, :examples, [%{"input" => %{"path" => "README.md"}, "note" => "Use repository-relative paths."}])

    assert %{"function" => %{"description" => openai_description}} =
             ToolSpec.translate_tool(tool, :openai_compatible)

    assert openai_description =~ "Examples / usage guidance:"
    assert openai_description =~ "README.md"

    assert %{"description" => anthropic_description} = ToolSpec.translate_tool(tool, :anthropic)
    assert anthropic_description =~ "README.md"
  end

  test "translates tools to Anthropic tool use format" do
    assert ToolSpec.to_provider_format([@tool], :anthropic) == [
             %{
               "name" => "read_file",
               "description" => "Run a shell command.",
               "input_schema" => @schema
             }
           ]
  end

  test "prompt-based provider omits tool payload specs" do
    assert ToolSpec.to_provider_format([@tool], :prompt_based) == []
  end

  test "generates prompt-based system message with JSON tool-call instructions" do
    message = ToolSpec.prompt_based_system_message([@tool])

    assert message =~ ~s({"tool_call":{"name":"tool_name","arguments":{}}})
    assert message =~ "Available tools:"
    assert message =~ "read_file: Run a shell command."
    assert message =~ Jason.encode!(@schema)
  end

  test "includes examples in prompt-based tool guidance" do
    tool = Map.put(@tool, :examples, [%{"input" => %{"path" => "README.md"}}])
    message = ToolSpec.prompt_based_system_message([tool])

    assert message =~ "Examples / usage guidance:"
    assert message =~ "README.md"
  end

  test "handles empty tool lists for provider and prompt-based formats" do
    assert ToolSpec.to_provider_format([], :openai) == []

    assert ToolSpec.prompt_based_system_message([]) ==
             "No tools are available for this turn. Answer directly without emitting tool-call JSON."
  end

  test "uses blank descriptions and object schemas when optional fields are missing" do
    assert ToolSpec.translate_tool(%{"name" => "inspect_repo"}, :anthropic) == %{
             "name" => "inspect_repo",
             "description" => "",
             "input_schema" => %{"type" => "object", "properties" => %{}}
           }
  end

  test "also accepts database row parameter field names" do
    tool = %{
      "name" => "create_plan",
      "description" => "Create a plan.",
      "parameters" => @schema
    }

    assert %{"function" => %{"parameters" => @schema}} = ToolSpec.translate_tool(tool, :openai)
  end

  test "accepts existing dotted runtime tool names" do
    tool = %{
      "name" => "plan.create",
      "description" => "Create a plan.",
      "parameters_schema" => @schema
    }

    assert %{"name" => "plan.create", "input_schema" => @schema} = ToolSpec.translate_tool(tool, :anthropic)
  end

  test "preserves existing inputSchema tool parameter contracts" do
    tool = %{
      "name" => "plan.create",
      "description" => "Create a plan.",
      "inputSchema" => @schema
    }

    assert %{"function" => %{"name" => "plan.create", "parameters" => @schema}} =
             ToolSpec.translate_tool(tool, :openai_compatible)
  end

  test "validates tool names before provider translation" do
    assert_raise ArgumentError, ~r/invalid tool name "ReadFile"/, fn ->
      ToolSpec.translate_tool(%{@tool | name: "ReadFile"}, :openai)
    end

    too_long_name = "a" <> String.duplicate("b", 63)

    assert_raise ArgumentError, ~r/invalid tool name/, fn ->
      ToolSpec.translate_tool(%{@tool | name: too_long_name}, :anthropic)
    end
  end

  test "parses prompt-based tool calls from plain JSON" do
    assert ToolSpec.parse_prompt_based_tool_call(~s({"tool_call":{"name":"read_file","arguments":{"path":"README.md"}}})) ==
             {:ok, %{"name" => "read_file", "arguments" => %{"path" => "README.md"}}}
  end

  test "parses prompt-based tool calls from fenced JSON" do
    text = """
    ```json
    {"tool_call":{"name":"read_file","arguments":{"path":"lib/app.ex"}}}
    ```
    """

    assert ToolSpec.parse_prompt_based_tool_call(text) ==
             {:ok, %{"name" => "read_file", "arguments" => %{"path" => "lib/app.ex"}}}
  end

  test "parses prompt-based tool calls when JSON is embedded in surrounding text" do
    text = ~s(I should inspect it. {"tool_call":{"name":"read_file","arguments":{"path":"notes/ü.md"}}})

    assert ToolSpec.parse_prompt_based_tool_call(text) ==
             {:ok, %{"name" => "read_file", "arguments" => %{"path" => "notes/ü.md"}}}
  end

  test "ignores malformed partial JSON and non-tool JSON objects" do
    assert ToolSpec.parse_prompt_based_tool_call(~s({"tool_call":{"name":"read_file","arguments":)) == :no_tool_call
    assert ToolSpec.parse_prompt_based_tool_call(~s({"message":"done"})) == :no_tool_call
  end

  test "rejects parsed prompt-based tool calls with invalid names or argument shapes" do
    assert ToolSpec.parse_prompt_based_tool_call(~s({"tool_call":{"name":"bad-name","arguments":{}}})) == :no_tool_call

    assert ToolSpec.parse_prompt_based_tool_call(~s({"tool_call":{"name":"read_file","arguments":"README.md"}})) ==
             :no_tool_call
  end
end
