defmodule SymphonyElixir.WorkerCommonDriftCheck do
  @moduledoc false

  @type file_pair :: %{
          left: Path.t(),
          right: Path.t(),
          status: :identical | :intentional_drift,
          left_sha256: String.t() | nil,
          right_sha256: String.t() | nil,
          reason: String.t() | nil
        }

  @type finding :: %{
          left: Path.t(),
          right: Path.t(),
          status: :content_drift | :intentional_drift_changed | :missing_file,
          message: String.t()
        }

  @default_pairs [
    %{
      left: "lib/symphony_elixir/codex/app_server.ex",
      right: "../../workers/common/symphony_elixir/codex/app_server.ex",
      status: :intentional_drift,
      left_sha256: "130cd2edf433cb0c7262a1f41f7096ba8cbbd9f8a67241e1d1c73534fec725c9",
      right_sha256: "830e94ba441da778fb013f88e6f8935eceea56ad9d02e28b457c18be0c399445",
      reason: "orchestrator copy already uses PortProtocol and TurnEventDispatcher while worker common now delegates transport and approvals into smaller helper modules"
    },
    %{
      left: "lib/symphony_elixir/workspace.ex",
      right: "../../workers/common/symphony_elixir/workspace.ex",
      status: :intentional_drift,
      left_sha256: "30e7203ab96d59893827631d1f7c1ced2eecd2845f5de80b2baf92e65d042473",
      right_sha256: "9893c4740379e9d6c169c160b976ddb8344c93952f180ebd88d47f06b75f09e3",
      reason: "orchestrator copy wires repository bootstrap while worker common keeps only generic workspace lifecycle"
    }
  ]

  @spec default_pairs() :: [file_pair()]
  def default_pairs, do: @default_pairs

  @spec findings([file_pair()]) :: [finding()]
  def findings(pairs \\ @default_pairs) do
    pairs
    |> Enum.flat_map(&pair_findings/1)
    |> Enum.sort_by(&{&1.left, &1.right, &1.status})
  end

  @spec digest(Path.t()) :: {:ok, String.t()} | {:error, File.posix()}
  def digest(path) when is_binary(path) do
    with {:ok, content} <- File.read(path) do
      {:ok, Base.encode16(:crypto.hash(:sha256, content), case: :lower)}
    end
  end

  defp pair_findings(%{left: left, right: right, status: :identical}) do
    with {:ok, left_content} <- read_file(left, right),
         {:ok, right_content} <- read_file(right, left) do
      if left_content == right_content do
        []
      else
        [
          %{
            left: left,
            right: right,
            status: :content_drift,
            message: "#{left} and #{right} are expected to be identical but differ"
          }
        ]
      end
    else
      {:error, finding} -> [finding]
    end
  end

  defp pair_findings(%{
         left: left,
         right: right,
         status: :intentional_drift,
         left_sha256: expected_left,
         right_sha256: expected_right
       }) do
    with {:ok, actual_left} <- digest_or_finding(left, right),
         {:ok, actual_right} <- digest_or_finding(right, left) do
      cond do
        actual_left == expected_left and actual_right == expected_right ->
          []

        true ->
          [
            %{
              left: left,
              right: right,
              status: :intentional_drift_changed,
              message: "#{left} or #{right} changed from the recorded intentional-drift digests; sync the copies or update the drift record"
            }
          ]
      end
    else
      {:error, finding} -> [finding]
    end
  end

  defp read_file(path, paired_path) do
    case File.read(path) do
      {:ok, content} ->
        {:ok, content}

      {:error, reason} ->
        {:error,
         %{
           left: path,
           right: paired_path,
           status: :missing_file,
           message: "Unable to read #{path}: #{inspect(reason)}"
         }}
    end
  end

  defp digest_or_finding(path, paired_path) do
    case digest(path) do
      {:ok, value} ->
        {:ok, value}

      {:error, reason} ->
        {:error,
         %{
           left: path,
           right: paired_path,
           status: :missing_file,
           message: "Unable to read #{path}: #{inspect(reason)}"
         }}
    end
  end
end
