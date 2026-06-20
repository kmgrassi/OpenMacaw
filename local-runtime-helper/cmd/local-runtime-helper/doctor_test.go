package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestDialAddressAddsDefaultPortForIPv6URL(t *testing.T) {
	t.Parallel()
	got, err := dialAddress("https://[::1]/worker-bridge/relay/ws")
	if err != nil {
		t.Fatal(err)
	}
	if got != "[::1]:443" {
		t.Fatalf("dialAddress = %q, want [::1]:443", got)
	}
}

func TestCheckOpenAIModelsRejectsInvalidPayload(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<html>not models</html>"))
	}))
	defer server.Close()

	err := checkOpenAIModels(context.Background(), runnerConfig{
		Kind:     "openai_compatible",
		Endpoint: server.URL + "/v1",
		Model:    "qwen2.5-coder:latest",
	})
	if err == nil {
		t.Fatal("expected invalid /models payload to fail")
	}
}

func TestHTTPChecksUseContextDeadline(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(25 * time.Millisecond)
		_, _ = w.Write([]byte(`{"data":[{"id":"qwen2.5-coder:latest"}]}`))
	}))
	defer server.Close()

	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	err := checkOpenAIModels(ctx, runnerConfig{
		Kind:     "openai_compatible",
		Endpoint: server.URL + "/v1",
		Model:    "qwen2.5-coder:latest",
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("checkOpenAIModels error = %v, want context deadline exceeded", err)
	}
}

func TestCmdDoctorJSONOutput(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":[{"id":"qwen2.5-coder:latest"}]}`))
	}))
	defer server.Close()

	configPath := filepath.Join(t.TempDir(), "runtime.toml")
	config := `
[machine]
display_name = "dev-machine"

[cloud]
endpoint = "` + server.URL + `"
workspace_id = "dev-workspace"
token = "token"

[runner.openai_compatible]
endpoint = "` + server.URL + `/v1"
model = "qwen2.5-coder:latest"
`
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}

	stdout := os.Stdout
	readPipe, writePipe, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	os.Stdout = writePipe
	t.Cleanup(func() { os.Stdout = stdout })

	cmdDoctor([]string{"--config", configPath, "--timeout", "1s", "--json"})

	if err := writePipe.Close(); err != nil {
		t.Fatalf("close write pipe: %v", err)
	}
	data, err := io.ReadAll(readPipe)
	if err != nil {
		t.Fatalf("read output: %v", err)
	}

	var output doctorJSONOutput
	if err := json.Unmarshal(data, &output); err != nil {
		t.Fatalf("doctor output is not JSON: %v\n%s", err, data)
	}
	if output.Status != "ok" {
		t.Fatalf("status = %q, want ok; output = %s", output.Status, data)
	}
	if len(output.Checks) == 0 {
		t.Fatalf("checks empty; output = %s", data)
	}
}
