// Package localapi exposes localhost-only helper endpoints for browser UI
// actions that must run on the user's machine.
package localapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

const DefaultAddr = "127.0.0.1:7317"

type Server struct {
	addr   string
	logger *slog.Logger
	server *http.Server
}

type PickDirectoryRequest struct {
	DefaultLocation string `json:"defaultLocation,omitempty"`
	Prompt          string `json:"prompt,omitempty"`
}

type PickDirectoryResponse struct {
	Cancelled  bool                 `json:"cancelled"`
	Path       *string              `json:"path"`
	Validation *DirectoryValidation `json:"validation,omitempty"`
}

type DirectoryValidation struct {
	OK     bool   `json:"ok"`
	Path   string `json:"path"`
	Reason string `json:"reason,omitempty"`
}

func NewServer(addr string, logger *slog.Logger) *Server {
	if strings.TrimSpace(addr) == "" {
		addr = DefaultAddr
	}
	if logger == nil {
		logger = slog.Default()
	}
	s := &Server{addr: addr, logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", s.handleHealth)
	mux.HandleFunc("/api/local/pick-directory", s.handlePickDirectory)
	s.server = &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	return s
}

func (s *Server) Start() error {
	ln, err := net.Listen("tcp", s.addr)
	if err != nil {
		return err
	}
	s.logger.Info("starting local helper api", "addr", ln.Addr().String())
	go func() {
		if err := s.server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.logger.Error("local helper api exited", "error", err)
		}
	}()
	return nil
}

func (s *Server) Shutdown(ctx context.Context) error {
	return s.server.Shutdown(ctx)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	if !s.allowLocalBrowserRequest(w, r) {
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method is not allowed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handlePickDirectory(w http.ResponseWriter, r *http.Request) {
	if !s.allowLocalBrowserRequest(w, r) {
		return
	}
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "Method is not allowed")
		return
	}

	var req PickDirectoryRequest
	if r.Body != nil {
		defer r.Body.Close()
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid_json", "Request body must be JSON")
			return
		}
	}

	picked, err := pickDirectory(req)
	if err != nil {
		writeError(w, http.StatusNotImplemented, "picker_unavailable", err.Error())
		return
	}
	if picked == "" {
		writeJSON(w, http.StatusOK, PickDirectoryResponse{Cancelled: true, Path: nil})
		return
	}
	validation := validateDirectory(picked)
	writeJSON(w, http.StatusOK, PickDirectoryResponse{
		Cancelled:  false,
		Path:       &picked,
		Validation: &validation,
	})
}

func (s *Server) allowLocalBrowserRequest(w http.ResponseWriter, r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		writeError(w, http.StatusForbidden, "origin_required", "Origin header is required")
		return false
	}
	if !allowedOrigin(origin) {
		writeError(w, http.StatusForbidden, "origin_forbidden", "Origin is not allowed")
		return false
	}
	w.Header().Set("Access-Control-Allow-Origin", origin)
	w.Header().Set("Vary", "Origin")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "content-type")
	w.Header().Set("Access-Control-Max-Age", "600")
	if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
		w.Header().Set("Access-Control-Allow-Private-Network", "true")
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		writeError(w, http.StatusForbidden, "loopback_required", "Local helper API only accepts loopback requests")
		return false
	}
	if r.Method == http.MethodPost && !jsonContentType(r.Header.Get("Content-Type")) {
		writeError(w, http.StatusUnsupportedMediaType, "content_type_required", "Content-Type must be application/json")
		return false
	}
	return true
}

func jsonContentType(value string) bool {
	mediaType, _, err := mime.ParseMediaType(value)
	return err == nil && mediaType == "application/json"
}

func allowedOrigin(origin string) bool {
	for _, allowed := range allowedOrigins() {
		if origin == allowed {
			return true
		}
	}
	return false
}

func allowedOrigins() []string {
	if configured := strings.TrimSpace(os.Getenv("OPENMACAW_LOCAL_API_ALLOWED_ORIGINS")); configured != "" {
		return splitOrigins(configured)
	}

	return []string{
		"http://localhost:5173",
		"http://127.0.0.1:5173",
	}
}

func splitOrigins(value string) []string {
	parts := strings.Split(value, ",")
	origins := make([]string, 0, len(parts))

	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			origins = append(origins, trimmed)
		}
	}

	return origins
}

func pickDirectory(req PickDirectoryRequest) (string, error) {
	if runtime.GOOS != "darwin" {
		return "", fmt.Errorf("native directory picker is currently only supported on macOS; paste the path manually")
	}
	prompt := strings.TrimSpace(req.Prompt)
	if prompt == "" {
		prompt = "Choose a workspace directory for this local runtime"
	}

	var clauses []string
	clauses = append(clauses, fmt.Sprintf("with prompt %q", prompt))
	if strings.TrimSpace(req.DefaultLocation) != "" {
		clauses = append(clauses, fmt.Sprintf("default location (POSIX file %q)", strings.TrimSpace(req.DefaultLocation)))
	}
	script := fmt.Sprintf(`
try
  set chosen to choose folder %s
  POSIX path of chosen
on error errMsg number errNum
  if errNum is -128 then return ""
  error errMsg number errNum
end try
`, strings.Join(clauses, " "))

	output, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		return "", fmt.Errorf("open directory picker: %w", err)
	}
	return strings.TrimRight(strings.TrimSpace(string(output)), "/"), nil
}
