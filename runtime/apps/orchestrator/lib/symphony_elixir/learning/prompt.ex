defmodule SymphonyElixir.Learning.Prompt do
  @moduledoc false

  @prompt_path :code.priv_dir(:symphony_elixir)
               |> Path.join("prompts/learning-system-v1.md")

  @spec load!() :: String.t()
  def load!, do: File.read!(@prompt_path)
end
