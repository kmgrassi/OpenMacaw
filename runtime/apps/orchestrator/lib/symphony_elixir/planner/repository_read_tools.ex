defmodule SymphonyElixir.Planner.RepositoryReadTools do
  @moduledoc """
  Contract for read-only repository tools used by future planner agents.

  This module intentionally defines schemas and policy metadata only. Runtime
  execution is added separately so these tools can be reviewed without changing
  current model tool exposure.

  Safety behavior required by implementations:

  - Reject path traversal and absolute paths supplied as repository-relative paths.
  - Resolve symlinks and reject reads or listings that escape the materialized
    workspace or repository cache.
  - Bound list, search, snippet, and file-content output sizes.
  """

  @tools ["repo.list", "repo.search", "repo.read_file"]

  @default_limit 50
  @max_list_entries 200
  @max_search_results 100
  @max_snippet_bytes 4_096
  @max_file_bytes 64 * 1024

  @safety_rules [
    "no_path_traversal",
    "no_symlink_escape",
    "stay_inside_workspace_or_repo_cache"
  ]

  @spec tool_names() :: [String.t()]
  def tool_names, do: @tools

  @spec safety_rules() :: [String.t()]
  def safety_rules, do: @safety_rules

  @spec output_limits() :: map()
  def output_limits do
    %{
      default_limit: @default_limit,
      max_list_entries: @max_list_entries,
      max_search_results: @max_search_results,
      max_snippet_bytes: @max_snippet_bytes,
      max_file_bytes: @max_file_bytes
    }
  end

  @spec tool_specs() :: [map()]
  def tool_specs do
    [
      %{
        "name" => "repo.list",
        "description" =>
          "List files and directories under a repository path without reading file contents. " <>
            safety_description(),
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["workspace_id", "repo_id", "path"],
          "properties" =>
            common_repo_properties()
            |> Map.merge(%{
              "path" => path_schema("Repository-relative directory path to list."),
              "max_depth" => %{
                "type" => ["integer", "null"],
                "minimum" => 0,
                "maximum" => 10,
                "description" => "Optional maximum directory depth to traverse from `path`."
              },
              "limit" => limit_schema(@max_list_entries)
            })
        },
        "outputLimits" => %{
          "defaultLimit" => @default_limit,
          "maxEntries" => @max_list_entries
        },
        "safetyRules" => @safety_rules
      },
      %{
        "name" => "repo.search",
        "description" =>
          "Search repository text with bounded snippets and structured path/line results. " <>
            safety_description(),
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["workspace_id", "repo_id", "query"],
          "properties" =>
            common_repo_properties()
            |> Map.merge(%{
              "query" => string_schema("Search query string."),
              "path" => nullable_path_schema("Optional repository-relative path prefix to search within."),
              "limit" => limit_schema(@max_search_results)
            })
        },
        "outputLimits" => %{
          "defaultLimit" => @default_limit,
          "maxResults" => @max_search_results,
          "maxSnippetBytes" => @max_snippet_bytes
        },
        "safetyRules" => @safety_rules
      },
      %{
        "name" => "repo.read_file",
        "description" =>
          "Read bounded text content from one repository file. " <>
            safety_description(),
        "inputSchema" => %{
          "type" => "object",
          "additionalProperties" => false,
          "required" => ["workspace_id", "repo_id", "path"],
          "properties" =>
            common_repo_properties()
            |> Map.merge(%{
              "path" => path_schema("Repository-relative file path to read."),
              "limit" => %{
                "type" => ["integer", "null"],
                "minimum" => 1,
                "maximum" => @max_file_bytes,
                "description" => "Optional maximum bytes to return from the file."
              }
            })
        },
        "outputLimits" => %{
          "maxFileBytes" => @max_file_bytes
        },
        "safetyRules" => @safety_rules
      }
    ]
  end

  defp common_repo_properties do
    %{
      "workspace_id" => string_schema("Workspace database UUID."),
      "repo_id" => string_schema("Repository identifier for the materialized workspace or repo cache.")
    }
  end

  defp string_schema(description), do: %{"type" => "string", "description" => description}

  defp path_schema(description) do
    string_schema(description)
    |> Map.put("minLength", 1)
  end

  defp nullable_path_schema(description) do
    %{
      "type" => ["string", "null"],
      "description" => description,
      "minLength" => 1
    }
  end

  defp limit_schema(maximum) do
    %{
      "type" => ["integer", "null"],
      "minimum" => 1,
      "maximum" => maximum,
      "description" => "Optional maximum number of results to return."
    }
  end

  defp safety_description do
    "Implementations must reject path traversal and symlink escapes."
  end
end
