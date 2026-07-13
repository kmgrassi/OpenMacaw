defmodule SymphonyElixir.WorkerBridge.PortLauncher do
  @moduledoc false

  @spec open(%{required(:command) => String.t(), required(:cwd) => String.t() | nil, required(:env) => map()}) ::
          {:ok, port()} | {:error, :bash_not_found}
  def open(%{command: command, cwd: cwd, env: env}) do
    case System.find_executable("bash") do
      nil ->
        {:error, :bash_not_found}

      executable ->
        opts =
          [
            :binary,
            :exit_status,
            :stderr_to_stdout,
            args: [~c"-lc", String.to_charlist(command)]
          ]
          |> maybe_put_cd(cwd)
          |> maybe_put_env(env)

        {:ok, Port.open({:spawn_executable, String.to_charlist(executable)}, opts)}
    end
  end

  @spec stop(port()) :: :ok
  def stop(port) when is_port(port) do
    try do
      Port.close(port)
    catch
      :error, :badarg -> :ok
    end

    :ok
  end

  defp maybe_put_cd(opts, nil), do: opts
  defp maybe_put_cd(opts, cwd), do: Keyword.put(opts, :cd, String.to_charlist(cwd))

  defp maybe_put_env(opts, env) when env in [%{}, nil], do: opts

  defp maybe_put_env(opts, env) when is_map(env) do
    formatted =
      Enum.map(env, fn {key, value} ->
        {String.to_charlist(key), String.to_charlist(value)}
      end)

    Keyword.put(opts, :env, formatted)
  end
end
