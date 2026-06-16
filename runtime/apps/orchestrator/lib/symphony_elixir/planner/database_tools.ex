defmodule SymphonyElixir.Planner.DatabaseTools do
  @moduledoc """
  Database-backed planner tools for creating and inspecting platform plans/work items.

  Every operation requires `workspace_id`. Reads and updates include the
  workspace predicate in the PostgREST query because deployed runtime processes
  use service-role credentials.
  """

  alias SymphonyElixir.PostgRESTClient
  alias SymphonyElixir.Planner.DatabaseToolSpecs
  alias SymphonyElixir.Planner.DatabaseTools.Arguments
  alias SymphonyElixir.Planner.DatabaseTools.Payloads
  alias SymphonyElixir.Planner.DatabaseTools.Updates
  alias SymphonyElixir.Planning.PlanHandoff
  alias SymphonyElixir.Orchestrator.DispatchPolicy
  alias SymphonyElixir.WorkItem.Mapper, as: WorkItemMapper

  @plan_table "plan"
  @work_item_table "work_items"

  @tools DatabaseToolSpecs.tool_names()

  @plan_update_fields [
    "name",
    "description",
    "type",
    "is_ongoing",
    "status",
    "metadata",
    "intent",
    "default_model",
    "default_runner_kind"
  ]

  @plan_update_non_nullable_fields ["metadata", "status"]

  @task_update_fields [
    "name",
    "description",
    "instructions",
    "priority",
    "labels",
    "metadata",
    "status",
    "state",
    "depends_on",
    "completion_gates"
  ]

  @task_update_non_nullable_fields [
    "name",
    "metadata",
    "status",
    "state",
    "labels",
    "depends_on",
    "completion_gates"
  ]

  @spec tool_names() :: [String.t()]
  def tool_names, do: @tools

  @spec execute(String.t(), term(), keyword()) :: {:ok, term()} | {:error, term()}
  def execute(tool, arguments, opts \\ [])

  def execute("plan.create", arguments, opts) do
    with {:ok, args} <- Arguments.normalize_arguments(arguments),
         {:ok, workspace_id} <- Arguments.workspace_id(args, opts),
         {:ok, name} <- Arguments.required_string(args, "name"),
         {:ok, payload} <- Payloads.plan_create_payload(args, workspace_id, name, opts) do
      create_row(@plan_table, payload, opts, "plan.create", args)
    end
  end

  def execute("task.create", arguments, opts) do
    with {:ok, args} <- Arguments.normalize_arguments(arguments),
         {:ok, args, normalization_feedback} <- WorkItemMapper.normalize_intake_payload(args),
         {:ok, workspace_id} <- Arguments.workspace_id(args, opts),
         {:ok, plan_row} <- optional_plan_row(args, workspace_id, opts),
         {:ok, defaulted_args, validation_feedback} <- Payloads.default_task_create_args(args, plan_row, opts),
         {:ok, name} <- Arguments.required_string(defaulted_args, "name"),
         {:ok, resolved_args} <- resolve_author_dependencies(defaulted_args, opts),
         {:ok, payload} <- Payloads.task_create_payload(resolved_args, workspace_id, name, plan_row, opts) do
      with {:ok, row} <- create_task_row(payload, opts, resolved_args, normalization_feedback ++ validation_feedback, "task.create") do
        remember_author_task_id(resolved_args, row, opts)
        {:ok, row}
      end
    end
  end

  def execute("delegate", arguments, opts) do
    with {:ok, raw_args} <- Arguments.normalize_arguments(arguments),
         {:ok, args} <- delegate_task_args(raw_args),
         {:ok, args, normalization_feedback} <- WorkItemMapper.normalize_intake_payload(args),
         {:ok, workspace_id} <- Arguments.workspace_id(args, opts),
         {:ok, plan_row} <- optional_plan_row(args, workspace_id, opts),
         {:ok, defaulted_args, validation_feedback} <- Payloads.default_task_create_args(args, plan_row, opts),
         {:ok, name} <- Arguments.required_string(defaulted_args, "name"),
         {:ok, resolved_args} <- resolve_author_dependencies(defaulted_args, opts),
         {:ok, payload} <- Payloads.task_create_payload(resolved_args, workspace_id, name, plan_row, opts, "delegate") do
      with {:ok, row} <- create_task_row(payload, opts, resolved_args, normalization_feedback ++ validation_feedback, "delegate") do
        remember_author_task_id(resolved_args, row, opts)
        {:ok, row}
      end
    end
  end

  def execute("plan.update", arguments, opts) do
    with {:ok, args} <- Arguments.normalize_arguments(arguments),
         {:ok, workspace_id} <- Arguments.workspace_id(args, opts),
         {:ok, plan_id} <- Arguments.required_string(args, "plan_id"),
         {:ok, patch} <- Updates.plan_update_patch(args, @plan_update_fields, @plan_update_non_nullable_fields),
         {:ok, existing} <- read_existing_for_update(@plan_table, plan_id, workspace_id, opts),
         {:ok, payload, changed_fields} <- Updates.changed_update_payload(existing, patch, @plan_update_fields) do
      update_scoped_row(
        @plan_table,
        plan_id,
        workspace_id,
        payload,
        Arguments.with_if_updated_at(opts, args),
        changed_fields,
        existing
      )
    end
  end

  def execute("plan.delete", arguments, opts) do
    with {:ok, args} <- Arguments.normalize_arguments(arguments),
         {:ok, workspace_id} <- Arguments.workspace_id(args, opts),
         {:ok, plan_id} <- Arguments.required_string(args, "plan_id") do
      update_scoped_row(@plan_table, plan_id, workspace_id, %{"status" => "deleted"}, opts)
    end
  end

  def execute("task.update", arguments, opts) do
    with {:ok, args} <- Arguments.normalize_arguments(arguments),
         {:ok, workspace_id} <- Arguments.workspace_id(args, opts),
         {:ok, task_id} <- Arguments.required_string(args, "task_id"),
         :ok <- Updates.validate_task_update_args(args, @task_update_non_nullable_fields),
         {:ok, existing} <- read_existing_for_update(@work_item_table, task_id, workspace_id, opts, :task),
         {:ok, payload, changed_fields, resolved_row} <-
           Updates.task_update_payload(args, existing, @task_update_fields, @task_update_non_nullable_fields) do
      update_scoped_row(
        @work_item_table,
        task_id,
        workspace_id,
        payload,
        Arguments.with_if_updated_at(opts, args),
        changed_fields,
        resolved_row,
        {:task_not_found, task_id, workspace_id}
      )
    end
  end

  def execute("task.schedule", arguments, opts) do
    with {:ok, args} <- Arguments.normalize_arguments(arguments),
         {:ok, workspace_id} <- Arguments.workspace_id(args, opts),
         {:ok, task_id} <- Arguments.required_string(args, "task_id"),
         {:ok, payload} <- Payloads.task_schedule_payload(args),
         {:ok, client} <- client(opts) do
      query = scoped_id_query(task_id, workspace_id)

      case PostgRESTClient.patch(client, @work_item_table, query, payload, prefer: "return=representation") do
        {:ok, rows} ->
          with {:ok, row} <- updated_task_row(rows, task_id, workspace_id),
               {:ok, _event} <-
                 insert_task_schedule_event(client, workspace_id, task_id, payload, args) do
            {:ok, row}
          end

        {:error, _} = error ->
          error
      end
    end
  end

  def execute("plan.read", arguments, opts) do
    with {:ok, args} <- Arguments.normalize_arguments(arguments),
         {:ok, workspace_id} <- Arguments.workspace_id(args, opts),
         {:ok, plan_id} <- Arguments.required_string(args, "plan_id") do
      read_scoped_row(@plan_table, plan_id, workspace_id, opts)
    end
  end

  def execute("task.read", arguments, opts) do
    with {:ok, args} <- Arguments.normalize_arguments(arguments),
         {:ok, workspace_id} <- Arguments.workspace_id(args, opts),
         {:ok, task_id} <- Arguments.required_string(args, "task_id") do
      read_scoped_row(@work_item_table, task_id, workspace_id, opts)
    end
  end

  def execute("task.status", arguments, opts) do
    with {:ok, args} <- Arguments.normalize_arguments(arguments),
         {:ok, workspace_id} <- Arguments.workspace_id(args, opts),
         {:ok, task_id} <- Arguments.required_string(args, "task_id"),
         {:ok, row} <- read_scoped_row(@work_item_table, task_id, workspace_id, opts) do
      {:ok, with_dispatch_status(row)}
    end
  end

  def execute("agent_tool_grant.create", arguments, opts) do
    with {:ok, args} <- Arguments.normalize_arguments(arguments),
         {:ok, workspace_id} <- Arguments.workspace_id(args, opts),
         {:ok, agent_id} <- Arguments.required_string(args, "agentId"),
         {:ok, reason} <- Arguments.required_string(args, "reason"),
         {:ok, tool_ref} <- agent_tool_ref(args),
         {:ok, _agent} <- read_agent_in_workspace(agent_id, workspace_id, opts),
         {:ok, tool} <- read_visible_enabled_tool(tool_ref, workspace_id, opts),
         {:ok, nil} <- read_agent_tool_grant(agent_id, workspace_id, tool["id"], opts) do
      upsert_agent_tool_grant(agent_id, workspace_id, tool, "include", reason, opts)
    else
      {:ok, grant} when is_map(grant) -> {:error, :agent_tool_grant_exists}
      other -> other
    end
  end

  def execute("agent_tool_grant.update", arguments, opts) do
    with {:ok, args} <- Arguments.normalize_arguments(arguments),
         {:ok, workspace_id} <- Arguments.workspace_id(args, opts),
         {:ok, agent_id} <- Arguments.required_string(args, "agentId"),
         {:ok, mode} <- agent_tool_grant_mode(args, required: true),
         {:ok, reason} <- Arguments.required_string(args, "reason"),
         {:ok, tool_ref} <- agent_tool_ref(args),
         {:ok, _agent} <- read_agent_in_workspace(agent_id, workspace_id, opts),
         {:ok, tool} <- read_visible_enabled_tool(tool_ref, workspace_id, opts),
         {:ok, grant} when is_map(grant) <- read_agent_tool_grant(agent_id, workspace_id, tool["id"], opts),
         :ok <- reject_repeated_system_grant(grant, mode) do
      upsert_agent_tool_grant(agent_id, workspace_id, tool, mode, reason, opts)
    else
      {:ok, nil} -> {:error, :agent_tool_grant_not_found}
      other -> other
    end
  end

  def execute(tool, _arguments, _opts), do: {:error, {:unsupported_planner_tool, tool, @tools}}

  @spec tool_specs() :: [map()]
  def tool_specs, do: DatabaseToolSpecs.tool_specs()

  @spec tool_spec(String.t()) :: map()
  def tool_spec(name) when is_binary(name), do: DatabaseToolSpecs.tool_spec(name)

  defp create_row(table, payload, opts, tool, args) do
    with {:ok, client} <- client(opts) do
      case PostgRESTClient.post(client, table, payload, prefer: "return=representation") do
        {:ok, rows} -> {:ok, with_review_event(row_result(rows), tool, args)}
        {:error, _} = error -> error
      end
    end
  end

  defp create_task_row(payload, opts, args, validation_feedback, tool) do
    with {:ok, client} <- client(opts) do
      case PostgRESTClient.post(client, @work_item_table, payload, prefer: "return=representation") do
        {:ok, rows} ->
          row =
            rows
            |> row_result()
            |> with_task_create_feedback(payload, validation_feedback)
            |> with_review_event(tool, args)

          {:ok, row}

        {:error, _} = error ->
          error
      end
    end
  end

  defp with_task_create_feedback(row, payload, validation_feedback) when is_map(row) do
    dispatch_row = Map.merge(payload, row)

    row
    |> Map.put("dispatch", DispatchPolicy.dispatch_summary_for_row(dispatch_row))
    |> maybe_put_validation_feedback(validation_feedback)
  end

  defp with_task_create_feedback(row, _payload, _validation_feedback), do: row

  defp maybe_put_validation_feedback(row, []), do: row
  defp maybe_put_validation_feedback(row, feedback), do: Map.put(row, "validation_feedback", feedback)

  defp with_dispatch_status(row) when is_map(row) do
    Map.put(row, "dispatch", DispatchPolicy.dispatch_summary_for_row(row))
  end

  defp with_dispatch_status(row), do: row

  defp with_review_event(row, tool, args) when is_map(row) do
    case PlanHandoff.review_event(tool, row, args) do
      nil -> row
      event -> Map.put(row, "_review_events", [event])
    end
  end

  defp with_review_event(row, _tool, _args), do: row

  defp read_scoped_row(table, id, workspace_id, opts) do
    query = scoped_id_query(id, workspace_id)

    with {:ok, client} <- client(opts) do
      case PostgRESTClient.get(client, table, query) do
        {:ok, rows} -> {:ok, row_result(rows)}
        {:error, _} = error -> error
      end
    end
  end

  defp read_existing_for_update(table, id, workspace_id, opts, kind) do
    case read_scoped_row(table, id, workspace_id, opts) do
      {:ok, row} when is_map(row) -> {:ok, row}
      {:ok, nil} -> {:error, {:"#{kind}_not_found", id, workspace_id}}
      {:error, _} = error -> error
    end
  end

  defp update_scoped_row(table, id, workspace_id, payload, opts) do
    update_scoped_row(table, id, workspace_id, payload, opts, nil, nil, nil)
  end

  defp update_scoped_row(_table, _id, _workspace_id, payload, _opts, changed_fields, resolved_row, _empty_patch_error)
       when payload == %{} and is_list(changed_fields) and is_map(resolved_row) do
    {:ok, Map.put(resolved_row, "changed_fields", changed_fields)}
  end

  defp update_scoped_row(table, id, workspace_id, payload, opts, changed_fields, resolved_row, empty_patch_error) do
    if_updated_at = Arguments.if_updated_at_opt(opts)

    query =
      id
      |> scoped_id_query(workspace_id)
      |> Arguments.maybe_put_updated_at_guard(if_updated_at)

    with {:ok, client} <- client(opts) do
      case PostgRESTClient.patch(client, table, query, payload, prefer: "return=representation") do
        {:ok, []} when is_binary(if_updated_at) ->
          stale_row_error(client, table, id, workspace_id, if_updated_at)

        {:ok, rows} ->
          row = row_result(rows)

          cond do
            is_list(changed_fields) and is_map(row) ->
              {:ok, Map.put(row, "changed_fields", changed_fields)}

            is_list(changed_fields) and is_nil(row) and not is_nil(empty_patch_error) ->
              {:error, empty_patch_error}

            true ->
              {:ok, row || resolved_row}
          end

        {:error, _} = error ->
          error
      end
    end
  end

  defp update_scoped_row(_table, _id, _workspace_id, payload, _opts, changed_fields, existing)
       when map_size(payload) == 0 do
    {:ok, update_result(existing, changed_fields)}
  end

  defp update_scoped_row(table, id, workspace_id, payload, opts, changed_fields, existing) do
    if_updated_at = Arguments.if_updated_at_opt(opts)

    query =
      id
      |> scoped_id_query(workspace_id)
      |> Arguments.maybe_put_updated_at_guard(if_updated_at)

    with {:ok, client} <- client(opts) do
      case PostgRESTClient.patch(client, table, query, payload, prefer: "return=representation") do
        {:ok, []} when is_binary(if_updated_at) ->
          stale_row_error(client, table, id, workspace_id, if_updated_at, existing)

        {:ok, rows} ->
          {:ok, rows |> row_result() |> update_result(changed_fields)}

        {:error, _} = error ->
          error
      end
    end
  end

  defp read_existing_for_update(table, id, workspace_id, opts) do
    case read_scoped_row(table, id, workspace_id, opts) do
      {:ok, row} when is_map(row) -> {:ok, row}
      {:ok, nil} -> {:error, {:row_not_found, table, id, workspace_id}}
      {:error, _} = error -> error
    end
  end

  defp optional_plan_row(args, workspace_id, opts) do
    case Arguments.optional_value(args, "plan_id") do
      nil ->
        {:ok, nil}

      plan_id when is_binary(plan_id) ->
        case read_scoped_row(@plan_table, plan_id, workspace_id, opts) do
          {:ok, row} when is_map(row) -> {:ok, row}
          {:ok, nil} -> {:error, {:plan_not_found, plan_id, workspace_id}}
          {:error, _} = error -> error
        end

      _ ->
        {:error, {:invalid_argument, "plan_id", "must be a string"}}
    end
  end

  defp agent_tool_ref(args) do
    case {Arguments.optional_value(args, "toolId"), Arguments.optional_value(args, "toolSlug")} do
      {tool_id, _tool_slug} when is_binary(tool_id) -> {:ok, {:id, tool_id}}
      {_tool_id, tool_slug} when is_binary(tool_slug) -> {:ok, {:slug, tool_slug}}
      _ -> {:error, {:missing_argument, "toolId or toolSlug"}}
    end
  end

  defp agent_tool_grant_mode(args, opts) do
    case Arguments.optional_value(args, "mode") do
      value when value in ["include", "exclude"] -> {:ok, value}
      nil -> if Keyword.get(opts, :required), do: {:error, {:missing_argument, "mode"}}, else: {:ok, "include"}
      _ -> {:error, {:invalid_argument, "mode", "must be include or exclude"}}
    end
  end

  defp read_agent_in_workspace(agent_id, workspace_id, opts) do
    query = %{"id" => "eq.#{agent_id}", "workspace_id" => "eq.#{workspace_id}", "limit" => "1"}

    with {:ok, client} <- client(opts) do
      case PostgRESTClient.get(client, "agent", query) do
        {:ok, rows} ->
          case row_result(rows) do
            row when is_map(row) -> {:ok, row}
            nil -> {:error, :agent_not_found}
          end

        {:error, _} = error ->
          error
      end
    end
  end

  defp read_visible_enabled_tool({field, value}, workspace_id, opts) do
    query =
      %{
        Atom.to_string(field) => "eq.#{value}",
        "or" => "(workspace_id.is.null,workspace_id.eq.#{workspace_id})",
        "limit" => "1"
      }

    with {:ok, client} <- client(opts) do
      case PostgRESTClient.get(client, "tool", query) do
        {:ok, rows} ->
          case row_result(rows) do
            %{"enabled" => true} = tool -> {:ok, tool}
            %{} -> {:error, :tool_disabled}
            nil -> {:error, :tool_not_found}
          end

        {:error, _} = error ->
          error
      end
    end
  end

  defp read_agent_tool_grant(agent_id, workspace_id, tool_id, opts) do
    query = %{
      "agent_id" => "eq.#{agent_id}",
      "workspace_id" => "eq.#{workspace_id}",
      "tool_id" => "eq.#{tool_id}",
      "limit" => "1"
    }

    with {:ok, client} <- client(opts) do
      case PostgRESTClient.get(client, "agent_tool_grant", query) do
        {:ok, rows} -> {:ok, row_result(rows)}
        {:error, _} = error -> error
      end
    end
  end

  defp reject_repeated_system_grant(%{"source" => "system", "mode" => mode}, mode),
    do: {:error, :system_tool_grant_backoff}

  defp reject_repeated_system_grant(_grant, _mode), do: :ok

  defp upsert_agent_tool_grant(agent_id, workspace_id, tool, mode, reason, opts) do
    payload = %{
      "agent_id" => agent_id,
      "workspace_id" => workspace_id,
      "tool_id" => tool["id"],
      "mode" => mode,
      "source" => "system",
      "reason" => reason,
      "created_by_user_id" => nil
    }

    with {:ok, client} <- client(opts) do
      case PostgRESTClient.post(client, "agent_tool_grant", payload,
             prefer: "resolution=merge-duplicates,return=representation",
             query: %{"on_conflict" => "agent_id,workspace_id,tool_id"}
           ) do
        {:ok, rows} -> {:ok, %{"grant" => row_result(rows), "tool" => Map.take(tool, ["id", "slug", "name"])}}
        {:error, _} = error -> error
      end
    end
  end

  defp delegate_task_args(args) do
    with {:ok, instructions} <- Arguments.required_string(args, "instructions"),
         {:ok, when_value} <- delegate_when(args),
         {:ok, metadata} <- delegate_input_metadata(args) do
      task_args =
        args
        |> Map.drop(["when"])
        |> Map.put("instructions", instructions)
        |> Map.put("description", Arguments.optional_value(args, "description") || instructions)
        |> Map.put("metadata", delegate_metadata(metadata, args))
        |> Arguments.maybe_put_optional("name", Arguments.optional_value(args, "title"))
        |> maybe_apply_delegate_when(when_value)

      {:ok, task_args}
    end
  end

  defp delegate_input_metadata(args) do
    case Arguments.optional_value(args, "metadata") do
      nil -> {:ok, %{}}
      metadata when is_map(metadata) -> {:ok, metadata}
      _ -> {:error, {:invalid_argument, "metadata", "must be an object"}}
    end
  end

  defp delegate_when(args) do
    case Arguments.optional_value(args, "when") do
      nil ->
        {:ok, nil}

      "now" ->
        {:ok, DateTime.utc_now() |> DateTime.to_iso8601()}

      value when is_binary(value) ->
        case DateTime.from_iso8601(value) do
          {:ok, datetime, _offset} -> {:ok, DateTime.to_iso8601(datetime)}
          {:error, _reason} -> {:error, {:invalid_argument, "when", "must be now, ISO-8601, or null"}}
        end

      _ ->
        {:error, {:invalid_argument, "when", "must be now, ISO-8601, or null"}}
    end
  end

  defp delegate_metadata(metadata, args) do
    metadata
    |> Map.put("created_via", "planner_delegate_tool")
    |> Map.put("planner_tool", "delegate")
    |> Arguments.maybe_put_optional("intent", Arguments.optional_value(args, "intent"))
  end

  defp maybe_apply_delegate_when(args, nil), do: args

  defp maybe_apply_delegate_when(args, next_poll_at) do
    args
    |> Map.put("state", "running")
    |> Map.put("next_poll_at", next_poll_at)
  end

  defp resolve_author_dependencies(args, opts) do
    with {:ok, author_ids} <- optional_string_list(args, "depends_on_author_ids"),
         {:ok, canonical_ids} <- lookup_author_dependencies(author_ids, opts),
         {:ok, existing_ids} <- optional_string_list(args, "depends_on") do
      depends_on = Enum.uniq(existing_ids ++ canonical_ids)

      args =
        if depends_on == [] do
          args
        else
          Map.put(args, "depends_on", depends_on)
        end

      {:ok, args}
    end
  end

  defp lookup_author_dependencies([], _opts), do: {:ok, []}

  defp lookup_author_dependencies(author_ids, opts) do
    author_map = planner_author_task_ids(opts)

    missing = Enum.reject(author_ids, &Map.has_key?(author_map, &1))

    if missing == [] do
      {:ok, Enum.map(author_ids, &Map.fetch!(author_map, &1))}
    else
      {:error, {:unknown_author_task_ids, missing}}
    end
  end

  defp remember_author_task_id(args, row, opts) when is_map(row) do
    with author_task_id when is_binary(author_task_id) <- Arguments.optional_value(args, "author_task_id"),
         work_item_id when is_binary(work_item_id) <- Map.get(row, "id"),
         state when is_pid(state) <- Keyword.get(opts, :planner_state) do
      Agent.update(state, fn current ->
        Map.update(current, :author_task_ids, %{author_task_id => work_item_id}, &Map.put(&1, author_task_id, work_item_id))
      end)
    else
      _ -> :ok
    end
  catch
    :exit, _reason -> :ok
  end

  defp remember_author_task_id(_args, _row, _opts), do: :ok

  defp planner_author_task_ids(opts) do
    case Keyword.get(opts, :planner_state) do
      state when is_pid(state) ->
        Agent.get(state, fn current ->
          case Map.get(current, :author_task_ids) do
            author_task_ids when is_map(author_task_ids) -> author_task_ids
            _ -> %{}
          end
        end)

      _ ->
        %{}
    end
  catch
    :exit, _reason -> %{}
  end

  defp optional_string_list(args, key) do
    case Arguments.optional_value(args, key) do
      nil ->
        {:ok, []}

      values when is_list(values) ->
        if Enum.all?(values, &is_binary/1) do
          {:ok, values}
        else
          {:error, {:invalid_argument, key, "must be an array of strings"}}
        end

      _ ->
        {:error, {:invalid_argument, key, "must be an array of strings"}}
    end
  end

  defp scoped_id_query(id, workspace_id) do
    %{
      "id" => "eq.#{id}",
      "workspace_id" => "eq.#{workspace_id}",
      "order" => "id.asc",
      "limit" => "1"
    }
  end

  defp row_result([row | _]) when is_map(row), do: row
  defp row_result([]), do: nil
  defp row_result(row) when is_map(row), do: row
  defp row_result(other), do: other

  defp updated_task_row(rows, task_id, workspace_id) do
    case row_result(rows) do
      row when is_map(row) -> {:ok, row}
      nil -> {:error, {:task_not_found, task_id, workspace_id}}
      _other -> {:error, :invalid_task_update_response}
    end
  end

  defp update_result(row, changed_fields) when is_map(row) do
    Map.put(row, "changed_fields", changed_fields)
  end

  defp update_result(row, _changed_fields), do: row

  defp stale_row_error(client, table, id, workspace_id, expected_updated_at) do
    {:error, {:stale_row, stale_row_details(client, table, id, workspace_id, expected_updated_at, nil)}}
  end

  defp stale_row_error(client, table, id, workspace_id, expected_updated_at, existing) do
    {:error, {:stale_row, stale_row_details(client, table, id, workspace_id, expected_updated_at, existing)}}
  end

  defp stale_row_details(client, table, id, workspace_id, expected_updated_at, existing) do
    actual_updated_at =
      case PostgRESTClient.get(client, table, scoped_id_query(id, workspace_id)) do
        {:ok, rows} ->
          case row_result(rows) do
            %{} = row -> Map.get(row, "updated_at")
            _ -> existing_updated_at(existing)
          end

        {:error, _reason} ->
          existing_updated_at(existing)
      end

    %{
      table: table,
      id: id,
      workspace_id: workspace_id,
      expected_updated_at: expected_updated_at,
      actual_updated_at: actual_updated_at
    }
  end

  defp existing_updated_at(%{} = existing), do: Map.get(existing, "updated_at")
  defp existing_updated_at(_existing), do: nil

  defp insert_task_schedule_event(client, workspace_id, task_id, payload, args) do
    event_payload =
      payload
      |> Map.take(["next_poll_at", "poll_cadence_seconds"])
      |> Arguments.maybe_put_optional("reason", Arguments.optional_value(args, "reason"))

    PostgRESTClient.post(
      client,
      "event_log",
      %{
        "workspace_id" => workspace_id,
        "work_item_id" => task_id,
        "kind" => "work_item.timing_updated",
        "source" => "planner_tool",
        "payload" => event_payload
      },
      prefer: "return=representation",
      query: %{"select" => "id,kind,payload"}
    )
  end

  @doc false
  def req_options,
    do: Application.get_env(:symphony_elixir, :planner_database_tools_req_options, [])

  defp client(opts) do
    config =
      Application.get_env(:symphony_elixir, :planner_database_tools, [])
      |> normalize_config()
      |> Map.merge(normalize_config(Keyword.get(opts, :config, [])))

    {:ok, PostgRESTClient.new(config, Keyword.get(opts, :req_options, req_options()))}
  rescue
    error in ArgumentError -> {:error, {:missing_supabase_config, Exception.message(error)}}
  end

  defp normalize_config(nil), do: %{}
  defp normalize_config(config) when is_list(config), do: Map.new(config)
  defp normalize_config(config) when is_map(config), do: config
end
