defmodule SymphonyElixir.CloudExecutor.PublicRepositoryTest do
  use ExUnit.Case, async: true

  alias SymphonyElixir.CloudExecutor.PublicRepository

  @commit "0123456789abcdef0123456789abcdef01234567"

  test "materializes a public repository at a requested ref and runs read-only commands" do
    root = tmp_dir()
    git = fake_git!()

    request = %{
      "workspace_id" => "workspace-1",
      "agent_id" => "agent-1",
      "run_id" => "run-1",
      "resources" => [
        %{
          "kind" => "git_repository",
          "provider" => "github",
          "resource_id" => "resource-1",
          "grant_id" => "grant-1",
          "alias" => "public_repo",
          "url" => "https://github.com/example/public-repo.git",
          "ref" => @commit
        }
      ],
      "commands" => [
        %{
          "name" => "head",
          "argv" => ["git", "rev-parse", "HEAD"],
          "cwd" => "resources/public_repo"
        }
      ]
    }

    assert {:ok, result} = PublicRepository.run(request, workspace_root: root, git_path: git)

    assert [
             %{
               "alias" => "public_repo",
               "path" => "resources/public_repo",
               "commit" => @commit,
               "status" => "materialized",
               "credential_ref" => nil
             }
           ] = result["resources"]

    assert [
             %{
               "name" => "head",
               "cwd" => "resources/public_repo",
               "status" => "completed",
               "output" => output
             }
           ] = result["commands"]

    assert String.trim(output) == @commit
  end

  test "bad refs return structured materialization failures" do
    request = %{
      "resources" => [
        %{"alias" => "public_repo", "url" => "https://github.com/example/public-repo.git", "ref" => "bad-ref"}
      ]
    }

    assert {:error, %{"code" => "command_failed", "alias" => "public_repo", "exit_code" => 128}} =
             PublicRepository.run(request, workspace_root: tmp_dir(), git_path: fake_git!())
  end

  test "rejects bad repository URLs before clone" do
    request = %{
      "resources" => [
        %{"alias" => "public_repo", "url" => "https://token@example.com/private.git", "ref" => @commit}
      ]
    }

    assert {:error, %{"code" => "repository_url_contains_credentials"}} = PublicRepository.run(request, workspace_root: tmp_dir())
  end

  test "rejects unsafe aliases before they become paths" do
    request = %{
      "resources" => [
        %{"alias" => "../escape", "url" => "https://github.com/example/public-repo.git", "ref" => @commit}
      ]
    }

    assert {:error, %{"code" => "invalid_resource_alias"}} = PublicRepository.run(request, workspace_root: tmp_dir())
  end

  test "rejects command cwd traversal outside the workspace" do
    root = tmp_dir()
    File.mkdir_p!(Path.join(root, "resources/public_repo"))

    assert {:error, %{"code" => "cwd_denied"}} = PublicRepository.command_cwd(root, "../outside")
  end

  test "rejects non-read-only commands" do
    request = %{
      "resources" => [
        %{"alias" => "public_repo", "url" => "https://github.com/example/public-repo.git", "ref" => @commit}
      ],
      "commands" => [
        %{"name" => "write", "argv" => ["git", "checkout", "main"], "cwd" => "resources/public_repo"}
      ]
    }

    assert {:error, %{"code" => "command_not_allowed"}} = PublicRepository.normalize_request(request)
  end

  test "rejects find -exec escape attempts" do
    request = command_request(["find", ".", "-type", "f", "-exec", "rm", "{}", ";"])

    assert {:error, %{"code" => "command_not_allowed", "detail" => detail}} =
             PublicRepository.normalize_request(request)

    assert detail =~ "-exec"
  end

  test "rejects find -delete and -fprint variants" do
    for arg <- ["-delete", "-execdir", "-fprint", "-fprintf"] do
      request = command_request(["find", ".", arg, "value"])
      assert {:error, %{"code" => "command_not_allowed"}} = PublicRepository.normalize_request(request)
    end
  end

  test "rejects sed in-place edits" do
    for arg <- ["-i", "--in-place", "--in-place=.bak"] do
      request = command_request(["sed", arg, "s/a/b/", "file"])
      assert {:error, %{"code" => "command_not_allowed"}} = PublicRepository.normalize_request(request)
    end
  end

  test "rejects global escape flags like --upload-pack and --exec" do
    for arg <- ["--upload-pack=evil", "--exec=evil", "--eval=evil", "--filter=evil"] do
      request = command_request(["git", "log", arg])
      assert {:error, %{"code" => "command_not_allowed"}} = PublicRepository.normalize_request(request)
    end
  end

  test "rejects git remote write subcommands and rev-parse remains allowed" do
    request = command_request(["git", "remote", "add", "origin", "https://example.com/x.git"])
    assert {:error, %{"code" => "command_not_allowed"}} = PublicRepository.normalize_request(request)

    ok_request = command_request(["git", "rev-parse", "HEAD"])
    assert {:ok, _} = PublicRepository.normalize_request(ok_request)
  end

  test "returns structured error when resource path is a regular file" do
    root = tmp_dir()
    resources_dir = Path.join(root, "resources")
    File.mkdir_p!(resources_dir)
    # Place a regular file where the cloned resource directory would go.
    File.write!(Path.join(resources_dir, "public_repo"), "preexisting file")

    request = %{
      "resources" => [
        %{
          "alias" => "public_repo",
          "url" => "https://github.com/example/public-repo.git",
          "ref" => @commit
        }
      ],
      "commands" => []
    }

    assert {:error, %{"code" => "resource_path_not_directory", "alias" => "public_repo"}} =
             PublicRepository.run(request, workspace_root: root, git_path: fake_git!())
  end

  defp command_request(argv) do
    %{
      "resources" => [
        %{"alias" => "public_repo", "url" => "https://github.com/example/public-repo.git", "ref" => @commit}
      ],
      "commands" => [
        %{"name" => "probe", "argv" => argv, "cwd" => "resources/public_repo"}
      ]
    }
  end

  defp tmp_dir do
    path = Path.join(System.tmp_dir!(), "public-repository-test-#{System.unique_integer([:positive])}")
    File.rm_rf!(path)
    File.mkdir_p!(path)
    path
  end

  defp fake_git! do
    dir = tmp_dir()
    path = Path.join(dir, "git")

    File.write!(path, """
    #!/bin/sh
    set -eu

    if [ "$1" = "clone" ]; then
      dest="$4"
      mkdir -p "$dest/.git"
      printf "%s" "$3" > "$dest/.git/source-url"
      exit 0
    fi

    if [ "$1" = "-C" ]; then
      repo="$2"
      shift 2

      if [ "$1" = "checkout" ]; then
        ref="$3"
        if [ "$ref" = "bad-ref" ]; then
          echo "fatal: bad revision" >&2
          exit 128
        fi
        printf "%s" "$ref" > "$repo/.git/HEAD"
        exit 0
      fi

      if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
        cat "$repo/.git/HEAD"
        printf "\\n"
        exit 0
      fi
    fi

    if [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
      cat ".git/HEAD"
      printf "\\n"
      exit 0
    fi

    echo "unexpected fake git invocation: $*" >&2
    exit 2
    """)

    File.chmod!(path, 0o755)
    path
  end
end
