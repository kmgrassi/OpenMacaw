package localapi

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestHealthRejectsProductionAppOriginByDefault(t *testing.T) {
	s := NewServer("127.0.0.1:0", nil)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.RemoteAddr = "127.0.0.1:50000"
	req.Header.Set("Origin", "https://app.openmacaw.ai")
	rec := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusForbidden, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "origin_forbidden") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestHealthRejectsMissingOrigin(t *testing.T) {
	s := NewServer("127.0.0.1:0", nil)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.RemoteAddr = "127.0.0.1:50000"
	rec := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusForbidden, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "origin_required") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestRejectsNonLoopbackRequests(t *testing.T) {
	s := NewServer("127.0.0.1:0", nil)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.RemoteAddr = "192.0.2.10:50000"
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	rec := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	if !strings.Contains(rec.Body.String(), "loopback_required") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestHealthAllowsConfiguredProductionAppOrigin(t *testing.T) {
	t.Setenv("OPENMACAW_LOCAL_API_ALLOWED_ORIGINS", "https://app.openmacaw.ai,http://localhost:5173")
	s := NewServer("127.0.0.1:0", nil)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.RemoteAddr = "127.0.0.1:50000"
	req.Header.Set("Origin", "https://app.openmacaw.ai")
	rec := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusOK, rec.Body.String())
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://app.openmacaw.ai" {
		t.Fatalf("Access-Control-Allow-Origin = %q", got)
	}
}

func TestAllowedOriginsDefaultsToLocalhostOnly(t *testing.T) {
	_ = os.Unsetenv("OPENMACAW_LOCAL_API_ALLOWED_ORIGINS")

	got := allowedOrigins()

	if len(got) != 2 || got[0] != "http://localhost:5173" || got[1] != "http://127.0.0.1:5173" {
		t.Fatalf("allowedOrigins() = %#v", got)
	}
}

func TestPickDirectoryRejectsNonJSONRequests(t *testing.T) {
	s := NewServer("127.0.0.1:0", nil)
	req := httptest.NewRequest(http.MethodPost, "/api/local/pick-directory", strings.NewReader("prompt=pick"))
	req.RemoteAddr = "127.0.0.1:50000"
	req.Header.Set("Origin", "http://127.0.0.1:5173")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	rec := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, http.StatusUnsupportedMediaType, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "content_type_required") {
		t.Fatalf("body = %s", rec.Body.String())
	}
}

func TestValidateDirectory(t *testing.T) {
	dir := t.TempDir()

	valid := validateDirectory(dir)
	if !valid.OK || valid.Path != dir {
		t.Fatalf("valid = %#v", valid)
	}

	relative := validateDirectory("relative")
	if relative.OK || relative.Reason != "not_absolute" {
		t.Fatalf("relative = %#v", relative)
	}
}
