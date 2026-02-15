# MCP Tool Reference

For quick-start examples, see [SKILL.md](../SKILL.md).

Complete parameter reference for Playwright MCP tools. Tool prefix: `mcp__playwright__`.

## Navigation

### browser_navigate

Navigate to a URL.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | Yes | URL to navigate to (must include protocol) |

Returns: Page title and snapshot of the loaded page.

```
{ "url": "https://example.com" }
```

### browser_go_back / browser_go_forward

Navigate browser history. No parameters.

### browser_wait_for

Wait for a condition before continuing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `selector` | string | No | CSS selector to wait for |
| `text` | string | No | Text content to wait for |
| `timeout` | number | No | Max wait time in ms (default: 30000) |

```
{ "selector": ".results-loaded", "timeout": 5000 }
{ "text": "Upload complete" }
```

## Interaction

### browser_click

Click an element identified by accessibility snapshot ref.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element` | string | Yes | Human-readable element description |
| `ref` | string | Yes | Ref value from accessibility snapshot (`[ref=eN]`) |

```
{ "element": "Submit button", "ref": "e15" }
```

### browser_type

Type text into an editable element. Clears existing content first.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element` | string | Yes | Human-readable element description |
| `ref` | string | Yes | Ref value from accessibility snapshot |
| `text` | string | Yes | Text to type |
| `submit` | boolean | No | Press Enter after typing (default: false) |

```
{ "element": "Search box", "ref": "e7", "text": "playwright mcp", "submit": true }
```

### browser_hover

Hover over an element.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element` | string | Yes | Human-readable element description |
| `ref` | string | Yes | Ref value from accessibility snapshot |

### browser_drag

Drag one element to another.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `startElement` | string | Yes | Source element description |
| `startRef` | string | Yes | Source ref value |
| `endElement` | string | Yes | Target element description |
| `endRef` | string | Yes | Target ref value |

### browser_press_key

Press a keyboard key or shortcut.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Key name (e.g., `Enter`, `Escape`, `Control+a`, `Meta+c`) |

```
{ "key": "Escape" }
{ "key": "Control+a" }
```

## Forms

### browser_select_option

Select option(s) from a `<select>` dropdown.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `element` | string | Yes | Dropdown description |
| `ref` | string | Yes | Ref value |
| `values` | string[] | Yes | Option values to select |

```
{ "element": "Country", "ref": "e9", "values": ["US"] }
```

### browser_file_upload

Upload file(s) to a file input.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `paths` | string[] | Yes | Absolute file paths to upload |

```
{ "paths": ["/tmp/report.pdf"] }
```

### browser_handle_dialog

Accept or dismiss a browser dialog (alert, confirm, prompt).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `accept` | boolean | Yes | Accept (true) or dismiss (false) |
| `promptText` | string | No | Text to enter in prompt dialog |

```
{ "accept": true }
{ "accept": true, "promptText": "my input" }
```

Dialogs block all other browser interactions until handled.

## Observation

### browser_snapshot

Return an accessibility snapshot of the current page. This is the primary tool for reading page content and discovering element refs.

No parameters. Returns a text-based accessibility tree with `[ref=eN]` markers for each interactive element.

**Prefer this over `browser_take_screenshot`** — text is more token-efficient and provides actionable refs.

### browser_take_screenshot

Capture a screenshot of the current page.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `raw` | boolean | No | Return raw base64 image (default: false) |

Requires `--caps=vision` for image analysis. Without it, the screenshot is captured but not analyzed.

### browser_console_messages

Return console messages (log, warn, error) from the browser.

No parameters. Returns messages accumulated since page load or last call.

### browser_network_requests

Return captured network requests.

No parameters. Requires `--caps=network`.

## Execution

### browser_evaluate

Execute JavaScript in the browser context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `expression` | string | Yes | JavaScript expression to evaluate |

Returns the expression result. Requires `--caps=devtools`.

```
{ "expression": "document.title" }
{ "expression": "document.querySelectorAll('a').length" }
{ "expression": "localStorage.getItem('token')" }
```

## Session Management

### browser_tabs

List all open browser tabs. No parameters.

Returns tab titles, URLs, and identifiers for switching.

### browser_tab_new

Open a new tab.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `url` | string | No | URL to open in new tab |

### browser_tab_select

Switch to a specific tab.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `index` | number | Yes | Tab index (0-based) |

### browser_close

Close the current page/tab. No parameters.

Call between unrelated browsing sessions to avoid state leakage.

### browser_install

Install browser binaries required for automation. No parameters.

Call before first use if browsers haven't been installed. Equivalent to `npx playwright install` on the CLI.

## Storage

### browser_get_cookies

Get cookies for the current page. No parameters.

### browser_clear_cookies

Clear all cookies. No parameters.

### browser_set_storage

Set localStorage or sessionStorage values.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `entries` | object[] | Yes | Array of `{ key, value, type }` objects |

```
{ "entries": [{ "key": "theme", "value": "dark", "type": "localStorage" }] }
```

### browser_get_storage

Get a storage value.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Storage key |
| `type` | string | No | `localStorage` (default) or `sessionStorage` |

## PDF

### browser_pdf

Generate a PDF of the current page. Requires `--caps=pdf`. No parameters.

Returns the PDF content.
