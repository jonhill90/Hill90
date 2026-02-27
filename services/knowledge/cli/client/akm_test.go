package client

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestCLIWriteAndRead(t *testing.T) {
	// Mock AKM server
	var createdPath string
	var createdContent string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify auth header
		auth := r.Header.Get("Authorization")
		if auth != "Bearer test-token" {
			w.WriteHeader(401)
			w.Write([]byte(`{"detail":"authentication required"}`))
			return
		}

		switch {
		case r.Method == "POST" && r.URL.Path == "/api/v1/entries":
			var body map[string]string
			json.NewDecoder(r.Body).Decode(&body)
			createdPath = body["path"]
			createdContent = body["content"]
			w.WriteHeader(201)
			json.NewEncoder(w).Encode(map[string]interface{}{
				"id":          "test-uuid",
				"path":        createdPath,
				"title":       "Test",
				"entry_type":  "note",
				"sync_status": "synced",
			})
		case r.Method == "GET" && r.URL.Path == "/api/v1/entries/notes/test.md":
			json.NewEncoder(w).Encode(map[string]interface{}{
				"id":      "test-uuid",
				"path":    "notes/test.md",
				"title":   "Test",
				"content": createdContent,
			})
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	c := &Client{
		BaseURL:    server.URL,
		Token:      "test-token",
		HTTPClient: server.Client(),
	}

	// Write
	content := "---\ntitle: Test\ntype: note\n---\nHello from Go."
	entry, err := c.CreateEntry("notes/test.md", content)
	if err != nil {
		t.Fatalf("CreateEntry failed: %v", err)
	}
	if entry["path"] != "notes/test.md" {
		t.Errorf("expected path notes/test.md, got %v", entry["path"])
	}

	// Read back
	readEntry, err := c.ReadEntry("notes/test.md")
	if err != nil {
		t.Fatalf("ReadEntry failed: %v", err)
	}
	if readEntry["content"] != content {
		t.Errorf("content mismatch: got %v", readEntry["content"])
	}
}

func TestCLIAuthFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(401)
		w.Write([]byte(`{"detail":"authentication required"}`))
	}))
	defer server.Close()

	c := &Client{
		BaseURL:    server.URL,
		Token:      "bad-token",
		HTTPClient: server.Client(),
	}

	_, err := c.ReadEntry("notes/test.md")
	if err == nil {
		t.Fatal("expected auth error, got nil")
	}
}

func TestCLIRefreshOnExpiry(t *testing.T) {
	callCount := 0
	newToken := "refreshed-token"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/internal/agents/refresh-token":
			w.WriteHeader(200)
			json.NewEncoder(w).Encode(map[string]string{
				"token":          newToken,
				"refresh_secret": "new-secret",
			})
		case r.URL.Path == "/api/v1/entries/notes/test.md":
			callCount++
			auth := r.Header.Get("Authorization")
			if auth == "Bearer "+newToken {
				json.NewEncoder(w).Encode(map[string]interface{}{
					"id":      "test-uuid",
					"path":    "notes/test.md",
					"content": "refreshed content",
				})
			} else {
				w.WriteHeader(401)
				w.Write([]byte(`{"detail":"expired"}`))
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer server.Close()

	// Set up refresh secret env var
	os.Setenv("AKM_REFRESH_SECRET", "test-refresh-secret")
	defer os.Unsetenv("AKM_REFRESH_SECRET")

	c := &Client{
		BaseURL:    server.URL,
		Token:      "expired-token",
		HTTPClient: server.Client(),
	}

	entry, err := c.ReadEntry("notes/test.md")
	if err != nil {
		t.Fatalf("ReadEntry with refresh failed: %v", err)
	}
	if entry["content"] != "refreshed content" {
		t.Errorf("expected refreshed content, got %v", entry["content"])
	}
	if c.Token != newToken {
		t.Errorf("expected token to be updated to %s, got %s", newToken, c.Token)
	}
}

func TestNewFromEnvMissingURL(t *testing.T) {
	os.Unsetenv("AKM_SERVICE_URL")
	os.Unsetenv("AKM_TOKEN")
	_, err := NewFromEnv()
	if err == nil {
		t.Fatal("expected error when AKM_SERVICE_URL not set")
	}
}

func TestNewFromEnvMissingToken(t *testing.T) {
	os.Setenv("AKM_SERVICE_URL", "http://localhost:8002")
	defer os.Unsetenv("AKM_SERVICE_URL")
	os.Unsetenv("AKM_TOKEN")
	_, err := NewFromEnv()
	if err == nil {
		t.Fatal("expected error when AKM_TOKEN not set")
	}
}
