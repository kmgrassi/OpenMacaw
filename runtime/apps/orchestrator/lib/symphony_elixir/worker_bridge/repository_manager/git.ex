defmodule SymphonyElixir.WorkerBridge.RepositoryManager.Git do
  @moduledoc false

  require Logger

  alias SymphonyElixir.WorkerBridge.RepositoryCredential

  @askpass_filename "git-askpass.sh"

  @spec run(Path.t(), [String.t()], RepositoryCredential.t() | nil) ::
          {:ok, String.t()} | {:error, term()}
  def run(root_dir, args, credential \\ nil)
      when is_binary(root_dir) and is_list(args) do
    cmd_opts =
      [stderr_to_stdout: true]
      |> maybe_put_git_credential_env(root_dir, credential)

    case System.cmd("git", args, cmd_opts) do
      {output, 0} ->
        {:ok, output}

      {output, status} ->
        sanitized = output |> redact_credential_output(credential) |> String.slice(0, 1000)
        Logger.warning("Worker bridge git command failed status=#{status} output=#{inspect(sanitized)}")
        {:error, {:git_failed, status, redact_credential_output(output, credential)}}
    end
  end

  @spec materialize_checkout(
          Path.t(),
          Path.t(),
          map(),
          atom(),
          Path.t()
        ) :: {:ok, String.t()} | {:error, term()}
  def materialize_checkout(cache_path, workspace_path, repository, :worktree, root_dir) do
    case worktree_checkout(cache_path, workspace_path, repository, root_dir) do
      :ok ->
        {:ok, "worktree"}

      {:error, _reason} ->
        File.rm_rf!(workspace_path)
        clone_checkout(cache_path, workspace_path, repository, root_dir)
    end
  end

  def materialize_checkout(cache_path, workspace_path, repository, _method, root_dir) do
    clone_checkout(cache_path, workspace_path, repository, root_dir)
  end

  @spec clone_checkout(Path.t(), Path.t(), map(), Path.t()) ::
          {:ok, String.t()} | {:error, term()}
  def clone_checkout(cache_path, workspace_path, repository, root_dir) do
    with {:ok, _output} <- run(root_dir, ["clone", cache_path, workspace_path]),
         :ok <- maybe_checkout_ref(workspace_path, repository, root_dir) do
      {:ok, "clone"}
    end
  end

  @spec workspace_revision(Path.t(), Path.t()) :: String.t() | nil
  def workspace_revision(workspace_path, root_dir) do
    case run(root_dir, ["-C", workspace_path, "rev-parse", "--verify", "HEAD"]) do
      {:ok, output} -> String.trim(output)
      {:error, _reason} -> nil
    end
  end

  defp worktree_checkout(cache_path, workspace_path, repository, root_dir) do
    ref = repository_ref(repository)

    with {:ok, _output} <-
           run(root_dir, ["--git-dir", cache_path, "worktree", "add", "--detach", workspace_path, ref]),
         :ok <- maybe_checkout_ref(workspace_path, repository, root_dir) do
      :ok
    end
  end

  defp maybe_checkout_ref(_workspace_path, %{"ref" => ref}, _root_dir) when ref in [nil, ""], do: :ok

  defp maybe_checkout_ref(_workspace_path, %{} = repository, _root_dir)
       when not is_map_key(repository, "ref"),
       do: :ok

  defp maybe_checkout_ref(workspace_path, %{"ref" => ref}, root_dir) when is_binary(ref) do
    case run(root_dir, ["-C", workspace_path, "checkout", ref]) do
      {:ok, _output} ->
        :ok

      {:error, _reason} ->
        checkout_remote_branch(workspace_path, ref, root_dir)
    end
  end

  defp checkout_remote_branch(workspace_path, ref, root_dir) do
    with {:ok, _output} <- run(root_dir, ["-C", workspace_path, "fetch", "--all", "--prune"]),
         {:ok, _output} <- run(root_dir, ["-C", workspace_path, "checkout", "-B", ref, "origin/#{ref}"]) do
      :ok
    else
      {:error, reason} -> {:error, {:repository_checkout_failed, ref, reason}}
    end
  end

  defp repository_ref(%{"ref" => ref}) when is_binary(ref) and ref != "", do: ref
  defp repository_ref(_repository), do: "HEAD"

  defp maybe_put_git_credential_env(opts, _root_dir, nil), do: opts

  defp maybe_put_git_credential_env(opts, root_dir, %RepositoryCredential{} = credential) do
    Keyword.put(opts, :env, [
      {"GIT_ASKPASS", askpass_path!(root_dir)},
      {"GIT_TERMINAL_PROMPT", "0"},
      {"SYMPHONY_GIT_USERNAME", credential.username},
      {"SYMPHONY_GIT_PASSWORD", credential.token}
    ])
  end

  defp askpass_path!(root_dir) do
    File.mkdir_p!(root_dir)
    path = Path.join(root_dir, @askpass_filename)

    unless File.exists?(path) do
      File.write!(path, askpass_script())
      File.chmod!(path, 0o700)
    end

    path
  end

  defp askpass_script do
    """
    #!/bin/sh
    case "$1" in
      *Username*) printf '%s\\n' "$SYMPHONY_GIT_USERNAME" ;;
      *Password*) printf '%s\\n' "$SYMPHONY_GIT_PASSWORD" ;;
      *) printf '%s\\n' "$SYMPHONY_GIT_PASSWORD" ;;
    esac
    """
  end

  defp redact_credential_output(output, nil), do: output || ""

  defp redact_credential_output(output, %RepositoryCredential{token: token}) do
    output = output || ""

    if is_binary(token) and token != "" do
      String.replace(output, token, "[REDACTED]")
    else
      output
    end
  end
end
