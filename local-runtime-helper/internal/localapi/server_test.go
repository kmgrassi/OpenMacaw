package localapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthAllowsProductionAppOrigin(t *testing.T) {
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

func TestRejectsNonLoopbackRequests(t *testing.T) {
	s := NewServer("127.0.0.1:0", nil)
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.RemoteAddr = "192.0.2.10:50000"
	rec := httptest.NewRecorder()

	s.server.Handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusForbidden)
	}
	if !strings.Contains(rec.Body.String(), "loopback_required") {
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
