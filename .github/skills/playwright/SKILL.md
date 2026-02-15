---
name: playwright
description: Browse websites, interact with web pages, and run Playwright tests. Use for navigating URLs, clicking elements, filling forms, taking screenshots, running browser automation, or executing Playwright test suites.
---

# Playwright

Three interfaces for browser automation and testing. Choose based on the task.

## When to Use Which

| Interface | Best For | How It Works |
|-----------|----------|--------------|
| **MCP Tools** | Exploratory browsing, iterative page interaction, long-running sessions | Persistent browser context via MCP protocol; accessibility snapshots with `[ref=eN]` targeting |
| **Playwright CLI** | Scripted browser automation, token-efficient agent workflows | One command per action via `playwright-cli`; no tool schemas in context |
| **Playwright Test CLI** | Running test suites, generating tests, CI pipelines | `npx playwright test` with config, reporters, traces |

**Rule of thumb:** Use MCP tools when you need to explore and reason about page content iteratively. Use Playwright CLI when you need efficient, scripted browser actions. Use Playwright Test CLI when running or writing test suites.

---

## MCP Tools

Configured via `.mcp.json` — tools are available automatically.

**How it works:** Tools return accessibility snapshots (not screenshots) for token-efficient browsing. Elements are targeted via `[ref=eN]` values from snapshots.

**Tool prefix:** `mcp__playwright__` — use `ToolSearch` to discover actual names if the prefix differs in your environment.

### Navigation & Interaction

```
Tool: mcp__playwright__browser_navigate
Parameters: { "url": "https://example.com" }

Tool: mcp__playwright__browser_click
Parameters: { "element": "Submit button", "ref": "e15" }

Tool: mcp__playwright__browser_type
Parameters: { "element": "Search input", "ref": "e7", "text": "playwright mcp" }

Tool: mcp__playwright__browser_hover
Parameters: { "element": "Menu item", "ref": "e12" }

Tool: mcp__playwright__browser_drag
Parameters: { "startElement": "Card", "startRef": "e5", "endElement": "Column", "endRef": "e20" }
```

### Page State

```
Tool: mcp__playwright__browser_snapshot
# Returns accessibility tree with [ref=eN] values — preferred over screenshots

Tool: mcp__playwright__browser_take_screenshot
# Returns page screenshot — use only when visual layout matters

Tool: mcp__playwright__browser_console_messages
# Returns browser console output

Tool: mcp__playwright__browser_network_requests
# Returns captured network requests (requires --caps=network)
```

### Forms & Dialogs

```
Tool: mcp__playwright__browser_select_option
Parameters: { "element": "Country dropdown", "ref": "e9", "values": ["US"] }

Tool: mcp__playwright__browser_file_upload
Parameters: { "paths": ["/path/to/file.pdf"] }

Tool: mcp__playwright__browser_handle_dialog
Parameters: { "accept": true }
```

### Advanced

```
Tool: mcp__playwright__browser_evaluate
Parameters: { "expression": "document.title" }

Tool: mcp__playwright__browser_wait_for
Parameters: { "selector": ".loaded", "timeout": 5000 }

Tool: mcp__playwright__browser_tabs       # List open tabs
Tool: mcp__playwright__browser_close      # Close page — use between unrelated sessions
Tool: mcp__playwright__browser_install    # Install browser binaries (first use)
```

### MCP Workflow: Navigate and Extract Info

```
1. browser_navigate  → { "url": "https://example.com/pricing" }
2. browser_snapshot  → Read page content and find elements
3. browser_click     → { "element": "Enterprise tab", "ref": "e12" }
4. browser_snapshot  → Extract pricing details from updated content
```

### MCP Workflow: Fill and Submit a Form

```
1. browser_navigate     → { "url": "https://example.com/contact" }
2. browser_snapshot     → Identify form fields and their refs
3. browser_type         → { "element": "Name", "ref": "e3", "text": "Jane Doe" }
4. browser_type         → { "element": "Email", "ref": "e5", "text": "jane@example.com" }
5. browser_select_option → { "element": "Topic", "ref": "e7", "values": ["Support"] }
6. browser_click        → { "element": "Submit", "ref": "e10" }
7. browser_snapshot     → Verify success message
```

### MCP Workflow: Debug a Failing Page

```
1. browser_navigate         → { "url": "https://example.com/broken-page" }
2. browser_console_messages → Check for JavaScript errors
3. browser_snapshot         → Inspect page structure
4. browser_evaluate         → { "expression": "document.querySelector('.error')?.textContent" }
```

---

## Playwright CLI

Token-efficient browser automation via standalone commands. Each action is a single CLI call — no tool schemas loaded into context.

### Install

```bash
npm install -g @playwright/cli@latest
playwright-cli install              # install browser binaries
playwright-cli install --skills     # register with coding agents
```

### CLI Structure

```
playwright-cli open [url]         Open browser, optionally navigate
playwright-cli goto <url>         Navigate to URL
playwright-cli snapshot           Capture page snapshot with element refs
playwright-cli screenshot [ref]   Screenshot page or element
playwright-cli click <ref>        Click element by ref
playwright-cli type <text>        Type into focused element
playwright-cli fill <ref> <text>  Fill a text field
playwright-cli select <ref> <val> Select dropdown option
playwright-cli check <ref>        Check checkbox/radio
playwright-cli press <key>        Press keyboard key
playwright-cli hover <ref>        Hover over element
playwright-cli drag <s> <e>       Drag and drop between refs
playwright-cli upload <file>      Upload file
playwright-cli close              Close page
playwright-cli tab-list           List tabs
playwright-cli tab-new [url]      Open new tab
playwright-cli tab-select <idx>   Switch tab
playwright-cli console [level]    Show console messages
playwright-cli network            Show network requests
playwright-cli eval <js> [ref]    Evaluate JavaScript
playwright-cli pdf                Save page as PDF
playwright-cli list               List active sessions
playwright-cli show               Open monitoring dashboard
```

### Sessions

Named sessions allow parallel browser instances with isolated state:

```bash
# Run command in named session
playwright-cli -s=checkout open https://shop.example.com

# Persistent profile (survives close)
playwright-cli -s=checkout open https://shop.example.com --persistent

# Set session via env var
PLAYWRIGHT_CLI_SESSION=myapp playwright-cli open https://example.com

# Manage sessions
playwright-cli list               # list all sessions
playwright-cli -s=checkout close  # close one
playwright-cli close-all          # close all
```

### Storage & State

```bash
playwright-cli state-save auth.json      # save cookies + storage
playwright-cli state-load auth.json      # restore state

playwright-cli cookie-list               # list cookies
playwright-cli cookie-set name value     # set cookie
playwright-cli localstorage-get key      # read localStorage
playwright-cli localstorage-set key val  # write localStorage
```

### CLI Workflow: Scripted Page Interaction

```bash
playwright-cli open https://demo.playwright.dev/todomvc/ --headed
playwright-cli type "Buy groceries"
playwright-cli press Enter
playwright-cli type "Water flowers"
playwright-cli press Enter
playwright-cli check e21
playwright-cli screenshot
playwright-cli close
```

### CLI Workflow: Verify Deployment

```bash
playwright-cli open https://staging.example.com
playwright-cli snapshot                          # check page loaded
playwright-cli fill e8 "test@example.com"        # email field
playwright-cli fill e10 "testpass"               # password field
playwright-cli click e12                         # sign in button
playwright-cli snapshot                          # verify dashboard
playwright-cli close
```

---

## Playwright Test CLI

Run and manage Playwright test suites.

### Run Tests

```bash
npx playwright test                              # run all tests
npx playwright test tests/login.spec.ts           # specific file
npx playwright test --grep "checkout"             # filter by title
npx playwright test --project chromium            # specific browser
npx playwright test --headed                      # visible browser
npx playwright test --debug                       # Playwright Inspector
npx playwright test --ui                          # interactive UI mode
npx playwright test --last-failed                 # re-run failures
```

### Generate Tests

```bash
npx playwright codegen https://example.com
npx playwright codegen --output tests/example.spec.ts https://example.com
```

### Reports & Traces

```bash
npx playwright test --reporter=html               # generate HTML report
npx playwright show-report                         # open report
npx playwright show-trace test-results/*/trace.zip # view trace
npx playwright merge-reports ./blob-reports        # merge sharded results
```

### Key Flags

| Flag | Description |
|------|-------------|
| `--headed` | Visible browser |
| `--debug` | Playwright Inspector |
| `--ui` | Interactive UI mode |
| `--project` | Select browser/project |
| `--grep` / `--grep-invert` | Filter/exclude tests by title |
| `--reporter` | Output format (list, dot, html, json, junit, github) |
| `--workers` | Parallelism (default: half CPU cores) |
| `--retries` | Retry failed tests N times |
| `--shard` | Distribute across CI machines (e.g., `1/3`) |
| `--trace` | Record trace (on, off, on-first-retry, retain-on-failure) |
| `--timeout` | Per-test timeout in ms |
| `--max-failures` / `-x` | Stop after N failures |
| `--last-failed` | Re-run only previous failures |
| `--only-changed` | Run tests affected by git changes |
| `--fail-on-flaky-tests` | Fail when flaky tests detected |
| `--list` | List tests without running |

---

## Gotchas

- **Prefer `browser_snapshot` over `browser_take_screenshot`** — snapshots are text-based and far more token-efficient. Only use screenshots when visual layout matters.
- **Always snapshot before targeting elements** — `[ref=eN]` values go stale after any navigation or page change. Take a fresh snapshot to get current refs.
- **First use requires browser install** — call `browser_install` (MCP), `playwright-cli install` (CLI), or `npx playwright install` (Test CLI) before first use.
- **Close between sessions** — call `browser_close` (MCP) or `playwright-cli close` (CLI) between unrelated browsing tasks to avoid state leakage.
- **Dialogs block interaction** — if a dialog appears, use `browser_handle_dialog` (MCP) or `playwright-cli dialog-accept` (CLI) before other actions.
- **Network requests require capability** — MCP `browser_network_requests` needs `--caps=network`. CLI uses `playwright-cli network` with no extra config.
- **Codegen requires headed mode** — `npx playwright codegen` opens a visible browser; not usable in headless CI.

## Configuration

### Browser Visibility

Default config runs **headless** (no visible browser window). To switch to headed mode for debugging, remove `--headless` from `args`:

```json
// Headless (default) — no browser window
"args": ["-y", "@playwright/mcp@0.0.68", "--headless"]

// Headed — visible browser window for debugging
"args": ["-y", "@playwright/mcp@0.0.68"]
```

Update in both `.mcp.json` and `.vscode/mcp.json`, then restart the session.

### MCP Capabilities

Optional capabilities can be enabled by adding `--caps` flags to the MCP server args.

| Capability | Flag | Enables |
|------------|------|---------|
| Vision | `--caps=vision` | `browser_take_screenshot` returns images for analysis |
| PDF | `--caps=pdf` | `browser_pdf` generates PDF from current page |
| Testing | `--caps=testing` | Test runner tools (`test_run`, `test_list`, etc.) |
| DevTools | `--caps=devtools` | `browser_evaluate` and console access |
| Network | `--caps=network` | `browser_network_requests` captures traffic |

**Example — headless with vision and network:**

```json
"playwright": {
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "@playwright/mcp@0.0.68", "--headless", "--caps=vision,network"]
}
```

**MCP Version:** Pinned at `@playwright/mcp@0.0.68` (pre-stable). Bump periodically by updating `args` in both `.mcp.json` and `.vscode/mcp.json`.

## References

For detailed reference material:

- [MCP tool reference](references/mcp-tools.md) — Full parameter reference for all MCP tools
- [CLI reference](references/cli.md) — Complete Playwright CLI command reference
- [Testing reference](references/testing.md) — Test runner, config, CI integration
- [Best practices](references/best-practices.md) — Agent browsing patterns, error recovery
