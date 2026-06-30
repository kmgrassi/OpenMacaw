defmodule SymphonyElixir.Policy.StateStore do
  @moduledoc """
  Durable policy session-state snapshots backed by PostgREST.
  """

  require Logger

  alias SymphonyElixir.PostgRESTClient

  @table "policy_session_state"
  @tool_call_count_key "tool_call_count"

  @type state :: %{optional(String.t()) => number() | map() | list() | nil}
  @type client :: PostgRESTClient.t()

  @spec hydrate(client() | nil, String.t() | nil) :: state()
  def hydrate(nil, _session_thread_id), do: %{}
  def hydrate(_client, nil), do: %{}
  def hydrate(_client, ""), do: %{}

  def hydrate(%PostgRESTClient{} = client, session_thread_id) when is_binary(session_thread_id) do
    query = %{
      "session_thread_id" => "eq.#{session_thread_id}",
      "select" => "key,value_numeric,value_json"
    }

    case PostgRESTClient.get(client, @table, query, log_metadata: %{caller: "policy_state_store.hydrate", session_thread_id: session_thread_id}) do
      {:ok, rows} ->
        rows
        |> decode_rows()
        |> Map.new(fn row -> {row["key"], state_value(row)} end)

      {:error, reason} ->
        Logger.warning("policy_state_hydrate_failed session_thread_id=#{inspect(session_thread_id)} reason=#{inspect(reason)}")
        %{}
    end
  end

  @spec write(client() | nil, String.t() | nil, String.t() | nil, String.t(), number() | map() | list() | nil) :: :ok
  def write(nil, _workspace_id, _session_thread_id, _key, _value), do: :ok
  def write(_client, _workspace_id, nil, _key, _value), do: :ok
  def write(_client, _workspace_id, "", _key, _value), do: :ok
  def write(_client, nil, _session_thread_id, _key, _value), do: :ok
  def write(_client, "", _session_thread_id, _key, _value), do: :ok

  def write(%PostgRESTClient{} = client, workspace_id, session_thread_id, key, value)
      when is_binary(workspace_id) and is_binary(session_thread_id) and is_binary(key) do
    payload =
      %{
        "workspace_id" => workspace_id,
        "session_thread_id" => session_thread_id,
        "key" => key,
        "updated_at" => DateTime.utc_now() |> DateTime.to_iso8601()
      }
      |> put_value(value)

    case PostgRESTClient.upsert(client, @table, payload, ["session_thread_id", "key"],
           prefer: "resolution=merge-duplicates,return=minimal",
           log_metadata: %{
             caller: "policy_state_store.write",
             workspace_id: workspace_id,
             session_thread_id: session_thread_id,
             key: key
           }
         ) do
      {:ok, _body} ->
        :ok

      {:error, reason} ->
        Logger.warning("policy_state_write_failed session_thread_id=#{inspect(session_thread_id)} key=#{inspect(key)} reason=#{inspect(reason)}")
        :ok
    end
  end

  @spec tool_call_count_key() :: String.t()
  def tool_call_count_key, do: @tool_call_count_key

  defp decode_rows(rows) when is_list(rows), do: rows

  defp decode_rows(body) when is_binary(body) do
    case Jason.decode(body) do
      {:ok, rows} when is_list(rows) -> rows
      _ -> []
    end
  end

  defp decode_rows(_body), do: []

  defp state_value(%{"value_json" => value}) when not is_nil(value), do: value
  defp state_value(%{"value_numeric" => value}) when is_number(value), do: value

  defp state_value(%{"value_numeric" => value}) when is_binary(value) do
    case Float.parse(value) do
      {number, ""} -> number
      _ -> nil
    end
  end

  defp state_value(_row), do: nil

  defp put_value(payload, value) when is_integer(value) or is_float(value) do
    payload
    |> Map.put("value_numeric", value)
    |> Map.put("value_json", nil)
  end

  defp put_value(payload, value) when is_map(value) or is_list(value) do
    payload
    |> Map.put("value_numeric", nil)
    |> Map.put("value_json", value)
  end

  defp put_value(payload, _value) do
    payload
    |> Map.put("value_numeric", nil)
    |> Map.put("value_json", nil)
  end
end
