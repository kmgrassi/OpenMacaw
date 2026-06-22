// Command local-runtime-helper is the daemon that bridges a user's
// machine to the OpenMacaw runtime orchestrator.
//
// Subcommands:
//
//	register    Register this machine with a workspace (writes runtime.toml)
//	start       Start the daemon (long-running)
//	status      Print local configuration and daemon setup status
//	doctor      Check config, cloud reachability, and runner endpoints
//	logout      Print local token cleanup and cloud revoke guidance
//	version     Print the version
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/kmgrassi/local-runtime-helper/internal/config"
	"github.com/kmgrassi/local-runtime-helper/internal/protocol"
	"github.com/kmgrassi/local-runtime-helper/internal/relay"
	"github.com/kmgrassi/local-runtime-helper/internal/runner"
	"github.com/kmgrassi/local-runtime-helper/internal/runner/openai_compatible"
	"github.com/kmgrassi/local-runtime-helper/internal/runner/openclaw"
	"github.com/kmgrassi/local-runtime-helper/internal/tools"
)

var version = "0.1.0-dev"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(2)
	}

	switch os.Args[1] {
	case "register":
		cmdRegister(os.Args[2:])
	case "start":
		cmdStart(os.Args[2:])
	case "status":
		cmdStatus(os.Args[2:])
	case "doctor":
		os.Exit(cmdDoctor(os.Args[2:]))
	case "logout":
		cmdLogout(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println("local-runtime-helper", version)
	case "help", "--help", "-h":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		printUsage()
		os.Exit(2)
	}
}

func printUsage() {
	fmt.Println(`local-runtime-helper - daemon that bridges a local machine to the cloud orchestrator

Usage:
  local-runtime-helper <command> [flags]

Commands:
  register    Register this machine with a workspace (writes runtime.toml)
  start       Start the daemon (long-running)
  status      Print local configuration and daemon setup status
  doctor      Check config, cloud reachability, and runner endpoints
  logout      Show local token cleanup and cloud revoke guidance
  version     Print the version
  help        Show this help

Register flags:
  --endpoint <wss-url>       Cloud relay endpoint
  --workspace <id>           Workspace id to register with
  --machine-id <id>          Stable machine id from OpenMacaw registration
  --name <display-name>      Machine display name
  --token <token>            One-time local runtime token
  --workspace-root <path>    Local workspace root for filesystem tools
  --openai-compatible-endpoint <url>
                            OpenAI-compatible runner endpoint
  --openai-compatible-model <model>
                            OpenAI-compatible runner model
  --openai-compatible-api-key <key>
                            Optional OpenAI-compatible runner API key
  --tool-call-capability <value>
                            OpenAI-compatible tool mode (default native_tools)
  --openclaw-endpoint <url> Local OpenClaw endpoint
  --openclaw-api-key <key>  Optional OpenClaw API key
  --config <path>            Config path (default ~/.config/openmacaw/runtime.toml)
  --force                    Replace an existing config file

See docs/install.md in the local-runtime-helper directory for setup guidance.`)
}

func cmdRegister(args []string) {
	fs := flag.NewFlagSet("register", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	endpoint := fs.String("endpoint", "", "cloud relay endpoint")
	workspaceID := fs.String("workspace", "", "workspace id")
	machineID := fs.String("machine-id", "", "stable machine id from OpenMacaw registration")
	displayName := fs.String("name", "", "machine display name")
	token := fs.String("token", "", "one-time local runtime token")
	workspaceRoot := fs.String("workspace-root", "", "local workspace root for filesystem tools")
	openAICompatibleEndpoint := fs.String("openai-compatible-endpoint", "", "OpenAI-compatible runner endpoint")
	openAICompatibleModel := fs.String("openai-compatible-model", "", "OpenAI-compatible runner model")
	openAICompatibleAPIKey := fs.String("openai-compatible-api-key", "", "optional OpenAI-compatible runner API key")
	toolCallCapability := fs.String("tool-call-capability", "native_tools", "OpenAI-compatible tool mode")
	openClawEndpoint := fs.String("openclaw-endpoint", "", "local OpenClaw endpoint")
	openClawAPIKey := fs.String("openclaw-api-key", "", "optional OpenClaw API key")
	configPath := fs.String("config", "", "config path")
	force := fs.Bool("force", false, "replace an existing config file")

	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, `Usage:
  local-runtime-helper register --endpoint <wss-url> --workspace <id> --machine-id <id> --name <display-name> --token <token> --openai-compatible-endpoint <url> --openai-compatible-model <model> [--workspace-root <path>] [--force]

Flags:`)
		fs.PrintDefaults()
	}

	if err := fs.Parse(args); err != nil {
		os.Exit(2)
	}
	if fs.NArg() != 0 {
		fmt.Fprintf(os.Stderr, "register: unexpected argument: %s\n\n", fs.Arg(0))
		fs.Usage()
		os.Exit(2)
	}

	cfg := config.Config{
		Machine: config.MachineConfig{
			ID:            strings.TrimSpace(*machineID),
			DisplayName:   strings.TrimSpace(*displayName),
			WorkspaceRoot: strings.TrimSpace(*workspaceRoot),
		},
		Cloud: config.CloudConfig{
			Endpoint:    strings.TrimSpace(*endpoint),
			WorkspaceID: strings.TrimSpace(*workspaceID),
			Token:       strings.TrimSpace(*token),
		},
	}
	if strings.TrimSpace(*openAICompatibleEndpoint) != "" || strings.TrimSpace(*openAICompatibleModel) != "" {
		cfg.Runners.OpenAICompatible = &config.OpenAICompatibleConfig{
			Endpoint:           strings.TrimSpace(*openAICompatibleEndpoint),
			APIKey:             strings.TrimSpace(*openAICompatibleAPIKey),
			Model:              strings.TrimSpace(*openAICompatibleModel),
			ToolCallCapability: strings.TrimSpace(*toolCallCapability),
		}
	}
	if strings.TrimSpace(*openClawEndpoint) != "" {
		cfg.Runners.OpenClaw = &config.OpenClawConfig{
			Endpoint: strings.TrimSpace(*openClawEndpoint),
			APIKey:   strings.TrimSpace(*openClawAPIKey),
		}
	}

	path, err := config.Write(cfg, config.WriteOptions{
		Path:      strings.TrimSpace(*configPath),
		Overwrite: *force,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "register: %v\n", err)
		os.Exit(1)
	}

	fmt.Fprintf(os.Stdout, "registered local runtime helper config at %s\n", path)
}

func cmdStart(args []string) {
	fs := flag.NewFlagSet("start", flag.ExitOnError)
	configPath := fs.String("config", "", "config path (default ~/.config/openmacaw/runtime.toml)")
	maxConcurrent := fs.Int("max-concurrent", relay.DefaultMaxConcurrentDispatches, "maximum simultaneous dispatches")
	logLevel := fs.String("log-level", "info", "log level (debug, info, warn, error)")
	if err := fs.Parse(args); err != nil {
		fmt.Fprintf(os.Stderr, "start: %v\n", err)
		os.Exit(2)
	}

	// Set up structured logger.
	var level slog.Level
	switch strings.ToLower(*logLevel) {
	case "debug":
		level = slog.LevelDebug
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	// Load config.
	cfg, err := config.Load(*configPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "start: load config: %v\n", err)
		os.Exit(1)
	}
	logger.Info("loaded config", "path", cfg.Path)

	runners, activeRunnerKinds, localToolExecutor, err := buildRunners(cfg, logger)
	if err != nil {
		fmt.Fprintf(os.Stderr, "start: %v\n", err)
		os.Exit(1)
	}
	if len(runners) == 0 {
		fmt.Fprintln(os.Stderr, "start: no runners configured in runtime.toml")
		os.Exit(1)
	}

	registry, err := runner.NewRegistry(runners...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "start: initialize runner registry: %v\n", err)
		os.Exit(1)
	}

	// Create the relay client first (it implements Sender).
	// We need to create a temporary client to get its SendFrame method,
	// then create the dispatcher with it, then set the dispatcher on the client.
	// Instead, we create the client config, build a placeholder dispatcher,
	// then replace the sender.

	// Create a "late-bound" sender that forwards to the client once it's ready.
	var client *relay.Client
	sender := relay.SenderFunc(func(ctx context.Context, frame protocol.Frame) error {
		if client == nil {
			return fmt.Errorf("relay client not initialized")
		}
		return client.SendFrame(ctx, frame)
	})

	dispatcher, err := relay.NewDispatcher(relay.DispatcherOptions{
		Runners:       registry,
		Sender:        sender,
		Logger:        logger,
		MaxConcurrent: *maxConcurrent,
		ToolExecutor:  localToolExecutor,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "start: initialize dispatcher: %v\n", err)
		os.Exit(1)
	}

	clientCfg := relay.NewClientFromConfig(cfg, activeRunnerKinds, version, dispatcher, logger)
	clientCfg.RefreshRunners = relay.NewRunnerRegistrationRefresher(runners, clientCfg.Runners)
	client, err = relay.NewClient(clientCfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "start: initialize relay client: %v\n", err)
		os.Exit(1)
	}

	// Run until interrupted.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	logger.Info("starting relay client", "endpoint", cfg.Cloud.Endpoint)
	if err := client.Run(ctx); err != nil && ctx.Err() == nil {
		fmt.Fprintf(os.Stderr, "start: relay client exited: %v\n", err)
		os.Exit(1)
	}

	// Wait for in-flight dispatches to drain.
	dispatcher.Wait()
	logger.Info("shutdown complete")
}

// buildRunners constructs the set of runners requested by cfg and returns
// them alongside the runner kinds to advertise in the relay RegisterFrame.
// Only initialized runners are advertised so the helper never claims a
// capability it cannot serve.
func buildRunners(cfg *config.Config, logger *slog.Logger) ([]runner.Runner, []string, openai_compatible.ToolExecutor, error) {
	if logger == nil {
		logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}

	var runners []runner.Runner
	var activeRunnerKinds []string
	var localToolExecutor openai_compatible.ToolExecutor

	if cfg.Machine.WorkspaceRoot != "" {
		executor, err := tools.NewExecutor(cfg.Machine.WorkspaceRoot)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("initialize local tool executor: %w", err)
		}
		localToolExecutor = executor
		logger.Info("registered local tool workspace", "workspace_root", cfg.Machine.WorkspaceRoot)
	}

	if rc := cfg.Runners.OpenAICompatible; rc != nil {
		r, err := openai_compatible.New(openai_compatible.Config{
			Endpoint:     rc.Endpoint,
			APIKey:       rc.APIKey,
			Model:        rc.Model,
			ToolExecutor: localToolExecutor,
			Logger:       logger,
		})
		if err != nil {
			return nil, nil, nil, fmt.Errorf("initialize openai_compatible runner: %w", err)
		}
		runners = append(runners, r)
		activeRunnerKinds = append(activeRunnerKinds, "openai_compatible")
		logger.Info("registered runner", "kind", "openai_compatible", "model", rc.Model, "endpoint", rc.Endpoint)
	}

	if rc := cfg.Runners.OpenClaw; rc != nil {
		r, err := openclaw.New(openclaw.Config{
			Endpoint: rc.Endpoint,
			APIKey:   rc.APIKey,
		})
		if err != nil {
			return nil, nil, nil, fmt.Errorf("initialize openclaw runner: %w", err)
		}
		runners = append(runners, r)
		activeRunnerKinds = append(activeRunnerKinds, "openclaw")
		logger.Info("registered runner", "kind", "openclaw", "endpoint", rc.Endpoint)
	}

	return runners, activeRunnerKinds, localToolExecutor, nil
}
