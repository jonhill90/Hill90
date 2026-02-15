# Best Practices

For quick-start examples, see [SKILL.md](../SKILL.md).

Agent-specific guidance for browsing with Playwright MCP and writing resilient tests.

## Token-Efficient Browsing

### Use Snapshots, Not Screenshots

`browser_snapshot` returns a text accessibility tree (~2-5KB). `browser_take_screenshot` returns an image (~100-500KB of tokens). Always prefer snapshots unless you need to verify visual layout.

### Minimize Round Trips

Plan your interaction sequence before starting. A typical page interaction needs:

1. Navigate
2. Snapshot (get refs)
3. Interact (click/type)
4. Snapshot (verify result)

Avoid unnecessary snapshots between sequential actions on the same page if refs haven't changed (no navigation, no dynamic content update).

### Extract Data from Snapshots

The accessibility tree contains text content, headings, links, form values, and ARIA labels. You can often answer user questions directly from a snapshot without clicking through multiple pages.

## Element Targeting

### Refs Go Stale

After any navigation, form submission, or significant DOM change, `[ref=eN]` values from a previous snapshot are invalid. Always take a fresh snapshot before targeting elements.

### Use Element Descriptions

The `element` parameter is a human-readable description, not a selector. It helps the tool disambiguate when multiple elements share a ref context. Be descriptive:

- Good: `"Submit order button"`, `"Email address input field"`
- Bad: `"button"`, `"input"`

### Handle Dynamic Content

For pages with loading states or lazy content:

```
1. browser_navigate  → target URL
2. browser_wait_for  → { "selector": ".content-loaded" }
3. browser_snapshot  → now refs are stable
```

## Session Management

### Clean Separation

Call `browser_close` between unrelated browsing tasks. This prevents:
- Cookie/session leakage between different sites
- State confusion from previous page's DOM
- Memory accumulation from long sessions

### Multi-Tab Workflows

Use tabs when you need to compare two pages or keep a reference open:

```
1. browser_navigate    → open first page
2. browser_tab_new     → { "url": "https://other-site.com" }
3. browser_snapshot    → read second page
4. browser_tab_select  → { "index": 0 }
5. browser_snapshot    → back to first page
```

### Authentication Persistence

Cookies persist within a session. If you log in on one page, subsequent navigations to the same domain stay authenticated until `browser_close` or `browser_clear_cookies`.

## Error Recovery

### Page Load Failures

If `browser_navigate` fails or times out:
1. Retry once — transient network issues are common.
2. Check the URL for typos (protocol, domain spelling).
3. Try with a simpler URL path (e.g., just the domain root).

### Element Not Found

If a click or type fails with "element not found":
1. Take a fresh `browser_snapshot` — refs may have gone stale.
2. Check if the element is behind a dropdown, modal, or scroll.
3. Try `browser_wait_for` if content is loading dynamically.
4. Use `browser_evaluate` as a last resort to inspect the DOM.

### Dialog Blocking

If any MCP tool returns an error about a dialog:
1. Call `browser_handle_dialog` with `{ "accept": true }` (or `false` to dismiss).
2. Retry the original action.

Dialogs (alert, confirm, prompt) block all browser interaction until handled.

### Timeout Issues

If actions are timing out:
1. Increase timeout in `browser_wait_for` for slow-loading pages.
2. Check `browser_console_messages` for JavaScript errors that may prevent rendering.
3. Check `browser_network_requests` (requires `--caps=network`) for failed API calls.

## Test Resilience

### Selector Stability

In test code, prefer selectors that survive UI refactors:

```typescript
// Best — semantic role
page.getByRole('button', { name: 'Submit' })

// Good — test ID (stable, explicit)
page.getByTestId('checkout-submit')

// Acceptable — label text
page.getByLabel('Email address')

// Fragile — CSS class (changes with styling)
page.locator('.btn-primary-lg')

// Worst — XPath or nth-child
page.locator('//div[3]/form/button[2]')
```

### Test Isolation

Each test should:
- Start from a known state (use `beforeEach` for setup)
- Not depend on other tests' side effects
- Clean up any data it creates (or use isolated test accounts)
- Use `test.describe.serial` only when test order truly matters

### Avoiding Flakiness

- **Wait for conditions, not time:** Use `expect(locator).toBeVisible()` instead of `page.waitForTimeout(2000)`.
- **Use web-first assertions:** `await expect(page.getByText('Success')).toBeVisible()` auto-retries.
- **Avoid animation races:** Wait for animations to complete before asserting.
- **Isolate test data:** Use unique data per test run to avoid conflicts.

### Assertion Patterns

```typescript
// Preferred — auto-retrying web-first assertions
await expect(page.getByRole('heading')).toHaveText('Dashboard');
await expect(page.getByRole('button')).toBeEnabled();
await expect(page).toHaveURL(/\/dashboard/);

// For lists and counts
await expect(page.getByRole('listitem')).toHaveCount(5);

// For visibility
await expect(page.getByText('Loading')).toBeHidden();
await expect(page.getByTestId('modal')).toBeVisible();
```

## Performance Tips

### Reduce Browser Overhead

- Use `chromium` only (skip firefox/webkit) during development.
- Run multi-browser only in CI.
- Use `fullyParallel: true` for independent tests.

### Network Optimization

- Mock API responses for unit-style tests: `page.route('**/api/**', handler)`.
- Use `baseURL` in config to avoid repeating the domain.
- Disable images/fonts in tests that don't need them:

```typescript
use: {
  launchOptions: {
    args: ['--blink-settings=imagesEnabled=false'],
  },
}
```

### Storage State

Save and reuse authentication state across tests to avoid repeated logins:

```typescript
// Save auth state after login
await page.context().storageState({ path: 'auth.json' });

// Reuse in config
use: {
  storageState: 'auth.json',
}
```
