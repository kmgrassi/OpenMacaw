defmodule SymphonyElixir.PlatformLearningClientTest do
  use ExUnit.Case, async: false

  alias SymphonyElixir.PlatformLearningClient

  setup do
    original_endpoint = System.get_env("PLATFORM_LEARNING_HANDLER_ENDPOINT")
    original_api_key = System.get_env("PLATFORM_LEARNING_HANDLER_API_KEY")

    Application.delete_env(:symphony_elixir, :platform_learning_handler)

    Application.put_env(:symphony_elixir, :platform_learning_req_options, plug: {Req.Test, __MODULE__})

    System.delete_env("PLATFORM_LEARNING_HANDLER_ENDPOINT")
    System.delete_env("PLATFORM_LEARNING_HANDLER_API_KEY")

    on_exit(fn ->
      restore_env("PLATFORM_LEARNING_HANDLER_ENDPOINT", original_endpoint)
      restore_env("PLATFORM_LEARNING_HANDLER_API_KEY", original_api_key)
      Application.delete_env(:symphony_elixir, :platform_learning_handler)
      Application.delete_env(:symphony_elixir, :platform_learning_req_options)
    end)

    :ok
  end

  test "posts learning jobs to the kind-dispatched platform endpoint with the runtime payload shape" do
    System.put_env("PLATFORM_LEARNING_HANDLER_ENDPOINT", "https://platform.example/")
    System.put_env("PLATFORM_LEARNING_HANDLER_API_KEY", "secret-key")

    expected_payloads = %{
      "/api/learning/jobs/learning_reflection" => %{
        "kind" => "learning_reflection",
        "scheduled_task_id" => "task-1",
        "scheduled_task_run_id" => "task-run-1",
        "scheduled_run_id" => "scheduled_run-1",
        "workspace_id" => "workspace-1",
        "agent_id" => "agent-1",
        "source_work_item_id" => "work-item-1",
        "scheduled_for" => "2026-06-15T12:00:00Z",
        "delivery" => %{
          "kind" => "learning_reflection",
          "sourceRunId" => "run-1",
          "sourceTaskId" => "work-item-1"
        },
        "trace_id" => "trace-1"
      },
      "/api/learning/jobs/learning_distillation" => %{
        "kind" => "learning_distillation",
        "scheduled_task_id" => "task-2",
        "scheduled_task_run_id" => "task-run-2",
        "scheduled_run_id" => "scheduled_run-2",
        "workspace_id" => "workspace-1",
        "scheduled_for" => "2026-06-15T13:00:00Z",
        "delivery" => %{
          "kind" => "learning_distillation",
          "windowDays" => 7
        },
        "trace_id" => "trace-2"
      }
    }

    Req.Test.stub(__MODULE__, fn conn ->
      assert Map.has_key?(expected_payloads, conn.request_path)
      assert Plug.Conn.get_req_header(conn, "authorization") == ["Bearer secret-key"]
      assert Plug.Conn.get_req_header(conn, "content-type") == ["application/json"]

      {:ok, body, conn} = Plug.Conn.read_body(conn)
      assert Jason.decode!(body) == Map.fetch!(expected_payloads, conn.request_path)

      conn
      |> Plug.Conn.put_resp_content_type("application/json")
      |> Plug.Conn.send_resp(200, Jason.encode!(%{"accepted" => true}))
    end)

    assert {:ok, %{"accepted" => true}} =
             PlatformLearningClient.post_job(
               "learning_reflection",
               expected_payloads["/api/learning/jobs/learning_reflection"]
             )

    assert {:ok, %{"accepted" => true}} =
             PlatformLearningClient.post_job(
               "learning_distillation",
               expected_payloads["/api/learning/jobs/learning_distillation"]
             )
  end

  defp restore_env(name, nil), do: System.delete_env(name)
  defp restore_env(name, value), do: System.put_env(name, value)
end
