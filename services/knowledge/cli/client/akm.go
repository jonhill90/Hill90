package client

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Client is the AKM HTTP client with Bearer auth and refresh-on-401.
type Client struct {
	BaseURL    string
	Token      string
	HTTPClient *http.Client
}

// NewFromEnv creates a Client from AKM_SERVICE_URL and AKM_TOKEN env vars.
func NewFromEnv() (*Client, error) {
	url := os.Getenv("AKM_SERVICE_URL")
	if url == "" {
		return nil, fmt.Errorf("AKM_SERVICE_URL not set")
	}
	token := os.Getenv("AKM_TOKEN")
	if token == "" {
		return nil, fmt.Errorf("AKM_TOKEN not set")
	}
	return &Client{
		BaseURL: strings.TrimRight(url, "/"),
		Token:   token,
		HTTPClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}, nil
}

// doRequest performs an HTTP request with Bearer auth. On 401, attempts token refresh.
func (c *Client) doRequest(method, path string, body interface{}) ([]byte, int, error) {
	data, statusCode, err := c.doRequestOnce(method, path, body)
	if err != nil {
		return nil, 0, err
	}
	if statusCode == 401 {
		// Attempt refresh
		if refreshErr := c.refreshToken(); refreshErr != nil {
			return data, statusCode, nil // Return original 401
		}
		// Retry with new token
		return c.doRequestOnce(method, path, body)
	}
	return data, statusCode, nil
}

func (c *Client) doRequestOnce(method, path string, body interface{}) ([]byte, int, error) {
	var reqBody io.Reader
	if body != nil {
		jsonBytes, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("marshal request: %w", err)
		}
		reqBody = bytes.NewReader(jsonBytes)
	}

	req, err := http.NewRequest(method, c.BaseURL+path, reqBody)
	if err != nil {
		return nil, 0, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("read response: %w", err)
	}
	return data, resp.StatusCode, nil
}

// refreshToken attempts to refresh the JWT using the refresh secret.
func (c *Client) refreshToken() error {
	secret := c.readRefreshSecret()
	if secret == "" {
		return fmt.Errorf("no refresh secret available")
	}

	payload := map[string]string{"refresh_secret": secret}
	jsonBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	req, err := http.NewRequest("POST", c.BaseURL+"/internal/agents/refresh-token", bytes.NewReader(jsonBytes))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("refresh failed: status %d", resp.StatusCode)
	}

	var result struct {
		Token         string `json:"token"`
		RefreshSecret string `json:"refresh_secret"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return err
	}

	c.Token = result.Token

	// Write new refresh secret to file
	secretFile := os.Getenv("AKM_REFRESH_SECRET_FILE")
	if secretFile != "" {
		if err := os.WriteFile(secretFile, []byte(result.RefreshSecret), 0600); err != nil {
			return fmt.Errorf("failed to write refresh secret to %s: %w", secretFile, err)
		}
	}

	return nil
}

// readRefreshSecret reads the refresh secret from file first, then env var fallback.
func (c *Client) readRefreshSecret() string {
	secretFile := os.Getenv("AKM_REFRESH_SECRET_FILE")
	if secretFile != "" {
		data, err := os.ReadFile(secretFile)
		if err == nil && len(data) > 0 {
			return strings.TrimSpace(string(data))
		}
	}
	return os.Getenv("AKM_REFRESH_SECRET")
}

// CreateEntry creates a new knowledge entry.
func (c *Client) CreateEntry(path, content string) (map[string]interface{}, error) {
	body := map[string]string{"path": path, "content": content}
	data, status, err := c.doRequest("POST", "/api/v1/entries", body)
	if err != nil {
		return nil, err
	}
	if status != 201 {
		return nil, fmt.Errorf("create entry failed (status %d): %s", status, string(data))
	}
	var result map[string]interface{}
	return result, json.Unmarshal(data, &result)
}

// ReadEntry reads a knowledge entry by path.
func (c *Client) ReadEntry(path string) (map[string]interface{}, error) {
	data, status, err := c.doRequest("GET", "/api/v1/entries/"+path, nil)
	if err != nil {
		return nil, err
	}
	if status == 404 {
		return nil, fmt.Errorf("entry not found: %s", path)
	}
	if status != 200 {
		return nil, fmt.Errorf("read entry failed (status %d): %s", status, string(data))
	}
	var result map[string]interface{}
	return result, json.Unmarshal(data, &result)
}

// ListEntries lists knowledge entries.
func (c *Client) ListEntries(entryType string) ([]map[string]interface{}, error) {
	path := "/api/v1/entries"
	if entryType != "" {
		path += "?type=" + url.QueryEscape(entryType)
	}
	// Use the list endpoint — for now reuse the entries path
	// The server doesn't have a dedicated list endpoint on entries, use search with empty query
	data, status, err := c.doRequest("GET", path, nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("list entries failed (status %d): %s", status, string(data))
	}
	var result []map[string]interface{}
	return result, json.Unmarshal(data, &result)
}

// SearchEntries searches knowledge entries.
func (c *Client) SearchEntries(query string) (map[string]interface{}, error) {
	data, status, err := c.doRequest("GET", "/api/v1/search?q="+url.QueryEscape(query), nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("search failed (status %d): %s", status, string(data))
	}
	var result map[string]interface{}
	return result, json.Unmarshal(data, &result)
}

// AppendJournal appends to today's journal.
func (c *Client) AppendJournal(content string) (map[string]interface{}, error) {
	body := map[string]string{"content": content}
	data, status, err := c.doRequest("POST", "/api/v1/journal", body)
	if err != nil {
		return nil, err
	}
	if status != 201 {
		return nil, fmt.Errorf("journal append failed (status %d): %s", status, string(data))
	}
	var result map[string]interface{}
	return result, json.Unmarshal(data, &result)
}

// GetContext retrieves the context summary.
func (c *Client) GetContext() (map[string]interface{}, error) {
	data, status, err := c.doRequest("GET", "/api/v1/context", nil)
	if err != nil {
		return nil, err
	}
	if status != 200 {
		return nil, fmt.Errorf("context failed (status %d): %s", status, string(data))
	}
	var result map[string]interface{}
	return result, json.Unmarshal(data, &result)
}
