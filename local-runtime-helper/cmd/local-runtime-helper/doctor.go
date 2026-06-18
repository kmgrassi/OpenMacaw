package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

type checkResult struct {
	Name string
	Err  error
}

type doctorJSONResult struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Error  string `json:"error,omitempty"`
}

type doctorJSONOutput struct {
	Status string             `json:"status"`
	Checks []doctorJSONResult `json:"checks"`
}

func cmdDoctor(args []string) {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	configPath := fs.String("config", defaultConfigPath, "path to runtime.toml")
	timeout := fs.Duration("timeout", 3*time.Second, "timeout for network checks")
	jsonOutput := fs.Bool("json", false, "emit machine-readable JSON")
	_ = fs.Parse(args)

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	results := []checkResult{}
	cfg, err := loadRuntimeConfig(*configPath)
	results = append(results, checkResult{Name: "config readable", Err: err})
	if err == nil {
		for _, validationErr := range validationErrors(cfg) {
			results = append(results, checkResult{Name: "config valid", Err: validationErr})
		}
		if len(validationErrors(cfg)) == 0 {
			results = append(results, checkResult{Name: "config valid"})
		}
		results = append(results, checkManagedService(ctx))
		results = append(results, checkResult{Name: "cloud reachable", Err: checkTCP(ctx, cfg.Cloud.Endpoint)})
		for _, kind := range sortedRunnerKinds(cfg.Runners) {
			runner := cfg.Runners[kind]
			results = append(results, checkRunner(ctx, runner))
		}
	}

	failed := false
	jsonResults := make([]doctorJSONResult, 0, len(results))
	if !*jsonOutput {
		fmt.Println("local-runtime-helper doctor")
	}
	for _, result := range results {
		if result.Err != nil {
			failed = true
			jsonResults = append(jsonResults, doctorJSONResult{Name: result.Name, Status: "fail", Error: result.Err.Error()})
			if *jsonOutput {
				continue
			}
			fmt.Printf("FAIL %s: %v\n", result.Name, result.Err)
			continue
		}
		jsonResults = append(jsonResults, doctorJSONResult{Name: result.Name, Status: "ok"})
		if *jsonOutput {
			continue
		}
		fmt.Printf("OK   %s\n", result.Name)
	}
	if *jsonOutput {
		status := "ok"
		if failed {
			status = "fail"
		}
		data, err := json.MarshalIndent(doctorJSONOutput{Status: status, Checks: jsonResults}, "", "  ")
		if err != nil {
			fmt.Fprintf(os.Stderr, "doctor: encode json: %v\n", err)
			os.Exit(1)
		}
		fmt.Println(string(data))
	}
	if failed {
		os.Exit(1)
	}
}

func checkManagedService(ctx context.Context) checkResult {
	if runtime.GOOS != "darwin" {
		return checkResult{Name: "managed service"}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return checkResult{Name: "managed service", Err: fmt.Errorf("read home directory: %w", err)}
	}
	plistPath := filepath.Join(home, "Library", "LaunchAgents", "com.openmacaw.local-runtime-helper.plist")
	if _, err := os.Stat(plistPath); errors.Is(err, os.ErrNotExist) {
		return checkResult{Name: "managed service"}
	} else if err != nil {
		return checkResult{Name: "managed service", Err: fmt.Errorf("inspect LaunchAgent plist: %w", err)}
	}

	label := fmt.Sprintf("gui/%d/com.openmacaw.local-runtime-helper", os.Getuid())
	output, err := exec.CommandContext(ctx, "launchctl", "print", label).CombinedOutput()
	if err != nil {
		return checkResult{
			Name: "managed service",
			Err:  fmt.Errorf("LaunchAgent is installed but not inspectable; run: launchctl kickstart -k %q", label),
		}
	}
	if !strings.Contains(string(output), "state = running") {
		return checkResult{
			Name: "managed service",
			Err:  fmt.Errorf("LaunchAgent is installed but not running; run: launchctl kickstart -k %q", label),
		}
	}
	return checkResult{Name: "managed service"}
}

func checkRunner(ctx context.Context, runner runnerConfig) checkResult {
	name := fmt.Sprintf("runner.%s reachable", runner.Kind)
	if runner.Endpoint == "" {
		return checkResult{Name: name, Err: errors.New("endpoint is missing")}
	}
	if runner.Kind == "openai_compatible" {
		return checkResult{Name: "runner.openai_compatible models", Err: checkOpenAIModels(ctx, runner)}
	}
	return checkResult{Name: name, Err: checkHTTP(ctx, runner.Endpoint, "")}
}

func checkTCP(ctx context.Context, rawEndpoint string) error {
	host, err := dialAddress(rawEndpoint)
	if err != nil {
		return err
	}
	var d net.Dialer
	conn, err := d.DialContext(ctx, "tcp", host)
	if err != nil {
		return err
	}
	return conn.Close()
}

func dialAddress(rawEndpoint string) (string, error) {
	if rawEndpoint == "" {
		return "", errors.New("endpoint is missing")
	}
	u, err := url.Parse(rawEndpoint)
	if err != nil {
		return "", err
	}
	if u.Host != "" {
		port := u.Port()
		if port == "" {
			port, err = defaultPort(u.Scheme)
			if err != nil {
				return "", err
			}
		}
		return net.JoinHostPort(u.Hostname(), port), nil
	}
	if _, _, err := net.SplitHostPort(rawEndpoint); err == nil {
		return rawEndpoint, nil
	}
	return "", fmt.Errorf("endpoint %q has no port and unsupported scheme %q", rawEndpoint, u.Scheme)
}

func defaultPort(scheme string) (string, error) {
	switch scheme {
	case "https", "wss":
		return "443", nil
	case "http", "ws":
		return "80", nil
	default:
		return "", fmt.Errorf("unsupported endpoint scheme %q", scheme)
	}
}

func checkHTTP(ctx context.Context, rawEndpoint string, bearerToken string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, rawEndpoint, nil)
	if err != nil {
		return err
	}
	if bearerToken != "" {
		req.Header.Set("Authorization", "Bearer "+bearerToken)
	}
	client := httpClient()
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	return nil
}

func checkOpenAIModels(ctx context.Context, runner runnerConfig) error {
	modelsURL, err := appendPath(runner.Endpoint, "models")
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, modelsURL, nil)
	if err != nil {
		return err
	}
	if runner.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+runner.APIKey)
	}
	resp, err := httpClient().Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("GET %s returned HTTP %d", modelsURL, resp.StatusCode)
	}

	var body struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return fmt.Errorf("invalid /models response: %w", err)
	}
	if len(body.Data) == 0 {
		return errors.New("/models returned no models")
	}
	if runner.Model == "" {
		return nil
	}
	for _, model := range body.Data {
		if model.ID == runner.Model {
			return nil
		}
	}
	return fmt.Errorf("configured model %q was not returned by /models", runner.Model)
}

func appendPath(rawEndpoint string, suffix string) (string, error) {
	u, err := url.Parse(rawEndpoint)
	if err != nil {
		return "", err
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/" + suffix
	return u.String(), nil
}

func httpClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12},
		},
	}
}
