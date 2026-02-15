# Playwright CLI Reference

For quick-start examples, see [SKILL.md](../SKILL.md).

Complete command reference for `@playwright/cli`. The CLI provides token-efficient browser automation — one command per action, no tool schemas loaded into context.

## Install

```bash
npm install -g @playwright/cli@latest
playwright-cli --help
```

### Browser Binaries

```bash
playwright-cli install              # install default browsers
playwright-cli install --skills     # register with coding agents (Claude Code, Copilot, etc.)
```

### Local Alternative (npx)

```bash
npx playwright-cli open https://example.com
```

## Navigation

```bash
playwright-cli open [url]              # launch browser, optionally navigate
playwright-cli open --headed           # visible browser window
playwright-cli open --browser=firefox  # specific browser
playwright-cli open --persistent       # persistent profile (survives close)
playwright-cli open --profile=<path>   # custom profile directory
playwright-cli goto <url>             # navigate to URL
playwright-cli go-back                # browser back
playwright-cli go-forward             # browser forward
playwright-cli reload                 # reload page
playwright-cli close                  # close page
```

## Snapshots & Screenshots

```bash
playwright-cli snapshot                # accessibility snapshot with element refs
playwright-cli snapshot --filename=f   # save snapshot to file
playwright-cli screenshot              # full page screenshot
playwright-cli screenshot <ref>        # screenshot specific element
playwright-cli screenshot --filename=f # save with specific filename
playwright-cli pdf                     # save page as PDF
playwright-cli pdf --filename=page.pdf # PDF with specific filename
```

## Interaction

```bash
playwright-cli click <ref> [button]    # click element (button: left|right|middle)
playwright-cli dblclick <ref> [button] # double-click element
playwright-cli type <text>             # type text into focused element
playwright-cli fill <ref> <text>       # fill text field by ref
playwright-cli select <ref> <value>    # select dropdown option
playwright-cli check <ref>             # check checkbox/radio
playwright-cli uncheck <ref>           # uncheck checkbox/radio
playwright-cli hover <ref>             # hover over element
playwright-cli drag <startRef> <endRef> # drag and drop
playwright-cli upload <file>           # upload file(s)
```

## Keyboard & Mouse

```bash
# Keyboard
playwright-cli press <key>             # press key (Enter, Escape, Tab, etc.)
playwright-cli press Control+a         # key combo
playwright-cli keydown <key>           # key down
playwright-cli keyup <key>             # key up

# Mouse
playwright-cli mousemove <x> <y>      # move to coordinates
playwright-cli mousedown [button]     # mouse button down
playwright-cli mouseup [button]       # mouse button up
playwright-cli mousewheel <dx> <dy>   # scroll
```

## Dialogs

```bash
playwright-cli dialog-accept [prompt]  # accept dialog (optional prompt text)
playwright-cli dialog-dismiss          # dismiss dialog
```

## Window

```bash
playwright-cli resize <width> <height> # resize browser window
```

## Tab Management

```bash
playwright-cli tab-list               # list all tabs
playwright-cli tab-new [url]          # open new tab
playwright-cli tab-select <index>     # switch to tab by index
playwright-cli tab-close [index]      # close tab (default: current)
```

## DevTools

```bash
playwright-cli console [level]        # show console messages (error|warning|info|debug)
playwright-cli network                # show network requests
playwright-cli eval <js-expression>   # evaluate JS on page
playwright-cli eval <js-expression> <ref> # evaluate JS on element
playwright-cli run-code <code>        # run Playwright code snippet
```

## Storage & State

### State Persistence

```bash
playwright-cli state-save [filename]   # save cookies + localStorage + sessionStorage
playwright-cli state-load <filename>   # restore saved state
```

### Cookies

```bash
playwright-cli cookie-list [--domain]  # list cookies
playwright-cli cookie-get <name>       # get cookie value
playwright-cli cookie-set <name> <val> # set cookie
playwright-cli cookie-delete <name>    # delete cookie
playwright-cli cookie-clear            # clear all cookies
```

### LocalStorage

```bash
playwright-cli localstorage-list       # list all entries
playwright-cli localstorage-get <key>  # get value
playwright-cli localstorage-set <k> <v> # set value
playwright-cli localstorage-delete <k> # delete entry
playwright-cli localstorage-clear      # clear all
```

### SessionStorage

```bash
playwright-cli sessionstorage-list       # list all entries
playwright-cli sessionstorage-get <key>  # get value
playwright-cli sessionstorage-set <k> <v> # set value
playwright-cli sessionstorage-delete <k> # delete entry
playwright-cli sessionstorage-clear      # clear all
```

## Network Mocking

```bash
playwright-cli route <pattern> [opts]  # mock network requests
playwright-cli route-list              # list active routes
playwright-cli unroute [pattern]       # remove route(s)
```

## Recording

```bash
playwright-cli tracing-start           # start trace recording
playwright-cli tracing-stop            # stop trace recording
playwright-cli video-start             # start video recording
playwright-cli video-stop [filename]   # stop video recording
```

## Sessions

Named sessions provide isolated, parallel browser instances.

```bash
# Run any command in a named session
playwright-cli -s=myapp open https://example.com
playwright-cli -s=myapp click e5
playwright-cli -s=myapp snapshot

# Persistent profile (survives browser close)
playwright-cli -s=myapp open https://example.com --persistent

# Environment variable for session
PLAYWRIGHT_CLI_SESSION=myapp playwright-cli open https://example.com

# Session management
playwright-cli list                    # list all sessions
playwright-cli -s=myapp close          # close one session
playwright-cli close-all               # close all sessions
playwright-cli kill-all                # force kill all
playwright-cli -s=myapp delete-data    # delete session user data
playwright-cli delete-data             # delete default session data
```

## Monitoring Dashboard

```bash
playwright-cli show
```

Opens a visual dashboard showing all active sessions with live screencasts. Click into a session viewport to take control; press Escape to release.

## Configuration File

Playwright CLI loads `playwright-cli.json` from the working directory, or accepts `--config path/to/config.json`.

### Key Options

| Option | Default | Description |
|--------|---------|-------------|
| `browser.browserName` | `chromium` | Browser engine (chromium, firefox, webkit) |
| `browser.isolated` | `true` | Keep profile in memory |
| `browser.userDataDir` | — | Persistent profile path |
| `outputDir` | `./` | Output directory for screenshots, PDFs |
| `outputMode` | `file` | `file` or `stdout` |
| `console.level` | `info` | Console message level |
| `timeouts.action` | `5000` | Default action timeout (ms) |
| `timeouts.navigation` | `60000` | Default navigation timeout (ms) |
| `testIdAttribute` | `data-testid` | Test ID attribute name |

### Example Config

```json
{
  "browser": {
    "browserName": "chromium",
    "isolated": true,
    "launchOptions": {
      "headless": true
    }
  },
  "outputDir": "./playwright-output",
  "outputMode": "stdout",
  "timeouts": {
    "action": 10000,
    "navigation": 30000
  }
}
```
