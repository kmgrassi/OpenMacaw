package relay

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"

	"github.com/kmgrassi/local-runtime-helper/internal/config"
	"github.com/kmgrassi/local-runtime-helper/internal/protocol"
	"github.com/kmgrassi/local-runtime-helper/internal/runner"
)

const (
	defaultHeartbeatInterval = 30 * time.Second
	minBackoff               = 1 * time.Second
	maxBackoff               = 60 * time.Second
	writeTimeout             = 10 * time.Second
	readLimit                = 16 << 20
)

// Client maintains a persistent WebSocket connection to the cloud relay,
// handles registration, heartbeats, and routes incoming frames to a Dispatcher.
type Client struct {
	cfg    ClientConfig
	logger *slog.Logger

	mu   sync.Mutex
	conn *websocket.Conn
}

// ClientConfig configures the relay WebSocket client.
type ClientConfig struct {
	// Endpoint is the ws(s) URL to the relay, e.g. "ws://localhost:8080".
	// The path /local-relay/ws is appended automatically.
	Endpoint string

	// Token is the bearer token for authentication.
	Token string

	// WorkspaceID identifies the workspace this helper belongs to.
	WorkspaceID string

	// MachineID is an optional stable machine identifier.
	MachineID string

	// MachineDisplayName is the human-readable name for this machine.
	MachineDisplayName string

	// Version is the local-runtime-helper build version advertised to the relay.
	Version string

	// RunnerKinds lists the runner kinds this helper advertises.
	RunnerKinds []string

	// Runners lists concrete initialized runner capabilities.
	Runners []protocol.RunnerRegistration

	// RefreshRunners returns the current runner/model advertisements for
	// heartbeat frames. If nil, heartbeats omit runner refreshes.
	RefreshRunners func(context.Context) ([]protocol.RunnerRegistration, error)

	// Dispatcher routes incoming dispatch/cancel frames.
	Dispatcher *Dispatcher

	// Logger for structured logging. Uses a discard logger if nil.
	Logger *slog.Logger
}

// NewClient creates a relay WebSocket client.
func NewClient(cfg ClientConfig) (*Client, error) {
	if cfg.Endpoint == "" {
		return nil, errors.New("relay endpoint is required")
	}
	if cfg.Token == "" {
		return nil, errors.New("relay token is required")
	}
	if cfg.WorkspaceID == "" {
		return nil, errors.New("workspace id is required")
	}
	if cfg.Dispatcher == nil {
		return nil, errors.New("dispatcher is required")
	}
	if len(cfg.RunnerKinds) == 0 {
		return nil, errors.New("at least one runner kind is required")
	}
	logger := cfg.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Client{cfg: cfg, logger: logger}, nil
}

// NewClientFromConfig creates a ClientConfig from the application config.
// runnerKinds should list only the runner kinds that were actually initialized
// in cmdStart, not all config sections — to avoid advertising capabilities
// the daemon cannot execute.
func NewClientFromConfig(appCfg *config.Config, runnerKinds []string, version string, dispatcher *Dispatcher, logger *slog.Logger) ClientConfig {
	machineID := appCfg.Machine.ID
	if machineID == "" {
		machineID = appCfg.Machine.DisplayName
	}
	if machineID == "" {
		machineID = "local-helper"
	}

	return ClientConfig{
		Endpoint:           appCfg.Cloud.Endpoint,
		Token:              appCfg.Cloud.Token,
		WorkspaceID:        appCfg.Cloud.WorkspaceID,
		MachineID:          machineID,
		MachineDisplayName: appCfg.Machine.DisplayName,
		Version:            version,
		RunnerKinds:        runnerKinds,
		Runners:            runnerRegistrations(appCfg, runnerKinds),
		Dispatcher:         dispatcher,
		Logger:             logger,
	}
}

// NewRunnerRegistrationRefresher returns a heartbeat refresher backed by the
// active runner instances. Runners that do not support model listing keep their
// static startup registration.
func NewRunnerRegistrationRefresher(active []runner.Runner, fallback []protocol.RunnerRegistration) func(context.Context) ([]protocol.RunnerRegistration, error) {
	staticByKind := make(map[string]protocol.RunnerRegistration, len(fallback))
	for _, registration := range fallback {
		staticByKind[registration.RunnerKind] = registration
	}

	return func(ctx context.Context) ([]protocol.RunnerRegistration, error) {
		registrations := make([]protocol.RunnerRegistration, 0, len(fallback))
		for _, activeRunner := range active {
			if activeRunner == nil {
				continue
			}
			lister, ok := activeRunner.(runner.ModelLister)
			if !ok {
				if registration, exists := staticByKind[activeRunner.Kind()]; exists {
					registrations = append(registrations, registration)
				}
				continue
			}
			models, err := lister.ListModels(ctx)
			if err != nil {
				return nil, err
			}
			for _, model := range models {
				if model.ID == "" {
					continue
				}
				registration := staticByKind[activeRunner.Kind()]
				registration.RunnerKind = activeRunner.Kind()
				registration.Model = model.ID
				if model.Provider != "" {
					registration.Provider = model.Provider
				}
				if len(model.Capabilities) > 0 {
					registration.Capabilities = mergeCapabilities(registration.Capabilities, model.Capabilities)
				}
				registrations = append(registrations, registration)
			}
		}
		return registrations, nil
	}
}

func mergeCapabilities(base, override map[string]any) map[string]any {
	if len(base) == 0 && len(override) == 0 {
		return nil
	}
	merged := make(map[string]any, len(base)+len(override))
	for key, value := range base {
		merged[key] = value
	}
	for key, value := range override {
		merged[key] = value
	}
	return merged
}

func runnerRegistrations(appCfg *config.Config, runnerKinds []string) []protocol.RunnerRegistration {
	registrations := make([]protocol.RunnerRegistration, 0, len(runnerKinds))
	for _, kind := range runnerKinds {
		registration := protocol.RunnerRegistration{
			RunnerKind: kind,
			Capabilities: map[string]any{
				"runtime_managed_tools": true,
			},
		}
		if kind == "openai_compatible" && appCfg.Runners.OpenAICompatible != nil {
			registration.Provider = "openai_compatible"
			registration.Model = appCfg.Runners.OpenAICompatible.Model
			registration.Capabilities["streaming"] = true
			registration.Capabilities["tool_calls"] = true
			if appCfg.Machine.WorkspaceRoot != "" {
				registration.Capabilities["helper_managed_tools"] = true
			}
		}
		registrations = append(registrations, registration)
	}
	return registrations
}

// Run connects to the relay and processes frames until ctx is canceled.
// It reconnects with exponential backoff on disconnection.
func (c *Client) Run(ctx context.Context) error {
	backoff := minBackoff
	for {
		err := c.connectAndServe(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}

		c.logger.Warn("relay connection lost, reconnecting",
			"error", err,
			"backoff", backoff,
		)

		// Jittered exponential backoff.
		jitter := time.Duration(rand.Int63n(int64(backoff) / 2))
		select {
		case <-time.After(backoff + jitter):
		case <-ctx.Done():
			return ctx.Err()
		}

		backoff = backoff * 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// connectAndServe dials the relay, registers, then runs the read/heartbeat loops.
func (c *Client) connectAndServe(ctx context.Context) error {
	wsURL := relayWSURL(c.cfg.Endpoint)
	c.logger.Info("connecting to relay", "url", wsURL)

	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": []string{"Bearer " + c.cfg.Token},
		},
	})
	if err != nil {
		return fmt.Errorf("dial relay: %w", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "shutting down")
	conn.SetReadLimit(readLimit)

	// Store conn for outbound sends.
	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.conn = nil
		c.mu.Unlock()
	}()

	// Send register frame.
	ack, err := c.register(ctx, conn)
	if err != nil {
		return fmt.Errorf("register: %w", err)
	}

	c.logger.Info("registered with relay",
		"machine_id", ack.MachineID,
		"heartbeat_interval_ms", ack.HeartbeatIntervalMillis,
		"max_concurrent", ack.MaxConcurrentDispatches,
	)

	// Determine heartbeat interval from the ack.
	heartbeatInterval := defaultHeartbeatInterval
	if ack.HeartbeatIntervalMillis > 0 {
		heartbeatInterval = time.Duration(ack.HeartbeatIntervalMillis) * time.Millisecond
	}

	// Save machine ID if the server assigned one.
	if ack.MachineID != "" {
		c.cfg.MachineID = ack.MachineID
	}

	// Run heartbeat and read loop concurrently.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	errCh := make(chan error, 2)

	go func() {
		errCh <- c.heartbeatLoop(ctx, conn, heartbeatInterval)
	}()
	go func() {
		errCh <- c.readLoop(ctx, conn)
	}()

	// Return on first error (the other goroutine will be canceled).
	err = <-errCh
	cancel()
	return err
}

// register sends the register frame and waits for register_ack.
func (c *Client) register(ctx context.Context, conn *websocket.Conn) (*protocol.RegisterAckFrame, error) {
	regFrame := &protocol.RegisterFrame{
		BaseFrame: protocol.BaseFrame{
			Type:          protocol.TypeRegister,
			SchemaVersion: protocol.SchemaVersion,
		},
		WorkspaceID:        c.cfg.WorkspaceID,
		MachineID:          c.cfg.MachineID,
		MachineDisplayName: c.cfg.MachineDisplayName,
		Version:            c.cfg.Version,
		RunnerKinds:        c.cfg.RunnerKinds,
		Runners:            c.cfg.Runners,
	}

	if err := c.writeFrame(ctx, conn, regFrame); err != nil {
		return nil, fmt.Errorf("send register frame: %w", err)
	}

	// Read register_ack (or error). The runtime's ack uses a slightly
	// different shape than the helper protocol (e.g. "heartbeat_interval_ms"
	// instead of "heartbeat_interval_millis", no "schema_version"), so we
	// decode it manually rather than through protocol.DecodeFrame.
	_, data, err := conn.Read(ctx)
	if err != nil {
		return nil, fmt.Errorf("read register response: %w", err)
	}

	var raw struct {
		Type                    string `json:"type"`
		MachineID               string `json:"machine_id"`
		HeartbeatIntervalMillis int    `json:"heartbeat_interval_millis"`
		HeartbeatIntervalMs     int    `json:"heartbeat_interval_ms"`
		MaxConcurrentDispatches int    `json:"max_concurrent_dispatches"`
		Code                    string `json:"code"`
		Message                 string `json:"message"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("decode register response: %w", err)
	}

	switch raw.Type {
	case "registered":
		hb := raw.HeartbeatIntervalMillis
		if hb == 0 {
			hb = raw.HeartbeatIntervalMs
		}
		return &protocol.RegisterAckFrame{
			MachineID:               raw.MachineID,
			HeartbeatIntervalMillis: hb,
			MaxConcurrentDispatches: raw.MaxConcurrentDispatches,
		}, nil
	case "error":
		return nil, fmt.Errorf("registration rejected: [%s] %s", raw.Code, raw.Message)
	default:
		return nil, fmt.Errorf("unexpected frame type %q during registration", raw.Type)
	}
}

// readLoop reads frames from the relay and routes them to the dispatcher.
func (c *Client) readLoop(ctx context.Context, conn *websocket.Conn) error {
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return fmt.Errorf("read frame: %w", err)
		}

		if isRelayAckFrame(data) {
			c.logger.Debug("received relay ack", "type", frameType(data))
			continue
		}

		frame, err := protocol.DecodeFrame(data)
		if err != nil {
			c.logger.Warn("failed to decode frame, skipping",
				"error", err,
				"raw", string(data),
			)
			continue
		}

		c.logger.Debug("received frame", "type", frameType(data))

		if err := c.cfg.Dispatcher.HandleFrame(ctx, frame); err != nil {
			c.logger.Error("dispatcher error", "error", err)
		}
	}
}

func isRelayAckFrame(data []byte) bool {
	var raw struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return false
	}
	return raw.Type == "heartbeat_ack"
}

// heartbeatLoop sends heartbeat frames at the specified interval.
func (c *Client) heartbeatLoop(ctx context.Context, conn *websocket.Conn, interval time.Duration) error {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	heartbeatCount := 0
	lastRunnerSignature := runnerSignature(c.cfg.Runners)

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			heartbeatCount++
			hb := &protocol.HeartbeatFrame{
				BaseFrame: protocol.BaseFrame{
					Type:          protocol.TypeHeartbeat,
					SchemaVersion: protocol.SchemaVersion,
				},
				SentAt:  time.Now(),
				Version: c.cfg.Version,
			}
			if c.cfg.RefreshRunners != nil && heartbeatCount%4 == 0 {
				runners, err := c.cfg.RefreshRunners(ctx)
				if err != nil {
					c.logger.Warn("runner heartbeat refresh failed", "error", err)
				} else if signature := runnerSignature(runners); signature != lastRunnerSignature {
					hb.Runners = runners
					lastRunnerSignature = signature
					c.cfg.Runners = runners
					c.logger.Info("runner model list changed", "runner_count", len(runners))
				} else {
					hb.Runners = runners
				}
			}
			if err := c.writeFrame(ctx, conn, hb); err != nil {
				return fmt.Errorf("send heartbeat: %w", err)
			}
			c.logger.Debug("heartbeat sent")
		}
	}
}

func runnerSignature(registrations []protocol.RunnerRegistration) string {
	data, err := json.Marshal(registrations)
	if err != nil {
		return ""
	}
	return string(data)
}

// SendFrame implements the Sender interface so the Dispatcher can write
// outbound frames (progress, output, complete, error) back over the WebSocket.
func (c *Client) SendFrame(ctx context.Context, frame protocol.Frame) error {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return errors.New("relay connection is not established")
	}
	return c.writeFrame(ctx, conn, frame)
}

// writeFrame encodes and sends a single frame over the WebSocket.
func (c *Client) writeFrame(ctx context.Context, conn *websocket.Conn, frame protocol.Frame) error {
	data, err := protocol.EncodeFrame(frame)
	if err != nil {
		return fmt.Errorf("encode frame: %w", err)
	}
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	return conn.Write(writeCtx, websocket.MessageText, data)
}

// relayWSURL returns the relay WebSocket URL. If the configured endpoint
// already contains a path (e.g., .../worker-bridge/relay/ws), it is used
// as-is. Otherwise /local-relay/ws is appended to a bare host.
func relayWSURL(endpoint string) string {
	base := strings.TrimRight(endpoint, "/")
	parsed, err := url.Parse(base)
	if err != nil || parsed.Path == "" || parsed.Path == "/" {
		return base + "/local-relay/ws"
	}
	return base
}

// frameType extracts the type field from raw JSON for logging.
func frameType(data []byte) string {
	var env struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(data, &env) == nil {
		return env.Type
	}
	return "unknown"
}
