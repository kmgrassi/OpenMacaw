defmodule SymphonyElixir.Runner.LlmToolRunner.Cutover do
  @moduledoc false

  alias SymphonyElixir.{AgentInventory, Attention, Cutover}
  alias SymphonyElixir.AgentInventory.StoredCredential
  alias SymphonyElixir.Manager.ModelClient
  alias SymphonyElixir.Runner.LlmToolRunner.SessionConfig
  alias SymphonyElixir.WorkerBridge.SecretResolver

  def create_response(session, request, attempt) do
    context = %{
      workspace_id: Map.get(session, :workspace_id),
      agent_id: Map.get(session, :agent_id),
      work_item_id: get_in(request, ["metadata", "work_item_id"]),
      run_id: Map.get(session, :run_id),
      trace_id: Map.get(session, :trace_id)
    }

    case Cutover.walk(session, context, fn link ->
           with {:ok, link_session} <- session_for_cutover_link(session, link) do
             client = link_session.model_client

             link_session
             |> client.create_response(
               request_for_cutover_link(request, link_session),
               attempt + link.position
             )
             |> normalize_cutover_call_result()
           end
         end) do
      {:ok, response, _decision} ->
        {:ok, response}

      {:error, :floor_exhausted, decision} ->
        Attention.escalate(:cutover_floor_exhausted, decision, session)

      {:error, :exhausted, decision} ->
        Attention.escalate(:cutover_exhausted, decision, session)

      {:error, {:non_retryable, reason}, _decision} ->
        passthrough_provider_error(reason)
    end
  end

  defp session_for_cutover_link(session, %Cutover.CutoverLink{} = link) do
    provider = link.provider || session.provider
    model_client = SessionConfig.model_client(%{"provider" => provider})

    with {:ok, credential} <- resolve_cutover_credential(session, link, model_client) do
      {:ok,
       session
       |> Map.put(:provider, provider)
       |> Map.put(:model, SessionConfig.provider_model(link.model) || session.model)
       |> Map.put(:credential_ref, link.credential_ref)
       |> Map.put(:model_client, model_client)
       |> Map.put(:base_url, SessionConfig.default_base_url(model_client))
       |> Map.put(:api_key, credential.api_key)
       |> Map.put(:credential_id, credential.credential_id)
       |> Map.put(:credential_scope, Map.get(credential, :credential_scope))}
    end
  end

  defp request_for_cutover_link(request, session) when is_map(request),
    do: Map.put(request, "model", session.model)

  defp resolve_cutover_credential(session, %Cutover.CutoverLink{source: :primary}, _model_client) do
    {:ok,
     %{
       api_key: Map.get(session, :api_key),
       credential_id: Map.get(session, :credential_id),
       credential_scope: Map.get(session, :credential_scope)
     }}
  end

  defp resolve_cutover_credential(_session, %Cutover.CutoverLink{} = link, ModelClient.LocalRelay) do
    {:ok, %{api_key: "local-runtime", credential_id: link.credential_id}}
  end

  defp resolve_cutover_credential(
         session,
         %Cutover.CutoverLink{} = link,
         ModelClient.OpenAICompatibleChat
       ) do
    case resolve_stored_cutover_credential(session, link) do
      {:ok, credential} -> {:ok, credential}
      {:error, _reason} -> {:ok, %{api_key: nil, credential_id: link.credential_id}}
    end
  end

  defp resolve_cutover_credential(session, %Cutover.CutoverLink{} = link, _model_client) do
    resolve_stored_cutover_credential(session, link)
  end

  defp resolve_stored_cutover_credential(session, %Cutover.CutoverLink{} = link) do
    cond do
      same_credential?(session, link) ->
        {:ok,
         %{
           api_key: Map.get(session, :api_key),
           credential_id: Map.get(session, :credential_id),
           credential_scope: Map.get(session, :credential_scope)
         }}

      not is_binary(Map.get(session, :agent_id)) ->
        {:error, credential_failure(link, :missing_agent_id)}

      true ->
        with {:ok, credentials} <- AgentInventory.list_credentials(Map.fetch!(session, :agent_id)),
             {:ok, %StoredCredential{} = credential} <- find_cutover_credential(credentials, link),
             {:ok, env} <- SecretResolver.resolve(credential),
             {:ok, api_key} <- api_key_from_env(env, link.provider) do
          {:ok,
           %{
             api_key: api_key,
             credential_id: credential.id,
             credential_scope: credential.provider
           }}
        else
          {:error, reason} -> {:error, credential_failure(link, reason)}
          nil -> {:error, credential_failure(link, :credential_not_found)}
        end
    end
  end

  defp same_credential?(session, %Cutover.CutoverLink{credential_id: credential_id})
       when is_binary(credential_id) do
    credential_id == Map.get(session, :credential_id)
  end

  defp same_credential?(_session, _link), do: false

  defp find_cutover_credential(credentials, %Cutover.CutoverLink{} = link)
       when is_list(credentials) do
    credentials
    |> Enum.find(&credential_matches_link?(&1, link))
    |> case do
      %StoredCredential{} = credential -> {:ok, credential}
      nil -> nil
    end
  end

  defp credential_matches_link?(%StoredCredential{} = credential, %Cutover.CutoverLink{} = link) do
    id = link.credential_id

    (is_binary(id) and (credential.id == id or credential_row_id(credential.id) == id)) or
      credential_alias(link.credential_ref) in credential.aliases
  end

  defp credential_row_id(id) when is_binary(id),
    do: id |> String.split(":", parts: 2) |> List.first()

  defp credential_row_id(_id), do: nil

  defp credential_alias(%{"type" => "credential_alias", "value" => value}), do: value
  defp credential_alias(%{"type" => "credential_alias", "credential_alias" => value}), do: value
  defp credential_alias(%{type: "credential_alias", value: value}), do: value
  defp credential_alias(%{type: :credential_alias, value: value}), do: value
  defp credential_alias(_ref), do: nil

  defp api_key_from_env(env, provider) when is_map(env) do
    candidates =
      case provider do
        "openai_compatible" ->
          ["OPENAI_COMPATIBLE_API_KEY", "LOCAL_MODEL_API_KEY", "OPENAI_API_KEY"]

        "local" ->
          ["LOCAL_MODEL_API_KEY", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"]

        "anthropic" ->
          ["ANTHROPIC_API_KEY"]

        _ ->
          ["OPENAI_API_KEY"]
      end

    candidates
    |> Enum.map(&Map.get(env, &1))
    |> Enum.find(&(is_binary(&1) and &1 != ""))
    |> case do
      value when is_binary(value) -> {:ok, value}
      _ -> {:error, :credential_secret_missing}
    end
  end

  defp credential_failure(%Cutover.CutoverLink{} = link, reason) do
    %{
      error_code: "provider_auth_failed",
      retryable: false,
      provider: link.provider,
      model: link.model,
      credential_id: link.credential_id,
      reason: inspect(reason)
    }
  end

  defp passthrough_provider_error({kind, _classification} = error)
       when kind in [:fatal, :retryable], do: {:error, error}

  defp passthrough_provider_error(reason), do: {:error, {:fatal, reason}}

  defp normalize_cutover_call_result({:error, {_kind, classification}})
       when is_map(classification), do: {:error, classification}

  defp normalize_cutover_call_result(result), do: result
end
