# Testing Reference

For quick-start examples, see [SKILL.md](../SKILL.md).

Deep-dive into Playwright Test: configuration, test anatomy, debugging, CI integration.

## Configuration

Playwright Test uses `playwright.config.ts` at the project root.

### Minimal Config

```typescript
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
});
```

### Multi-Browser Config

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'html',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

### Key Config Options

| Option | Description |
|--------|-------------|
| `testDir` | Directory containing test files |
| `timeout` | Per-test timeout in ms (default: 30000) |
| `retries` | Number of retries for failed tests |
| `workers` | Parallel worker count (default: half CPU cores) |
| `fullyParallel` | Run tests within files in parallel |
| `reporter` | Output format(s) |
| `use.baseURL` | Base URL for `page.goto('/')` |
| `use.trace` | Trace recording strategy |
| `use.screenshot` | Screenshot capture strategy |
| `webServer` | Auto-start dev server before tests |

## Test Anatomy

### Basic Test

```typescript
import { test, expect } from '@playwright/test';

test('homepage has title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/My App/);
});
```

### Test with Setup

```typescript
test.describe('authenticated flows', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('[name=email]', 'user@example.com');
    await page.fill('[name=password]', 'password');
    await page.click('button[type=submit]');
    await page.waitForURL('/dashboard');
  });

  test('can view profile', async ({ page }) => {
    await page.click('text=Profile');
    await expect(page.locator('h1')).toHaveText('My Profile');
  });

  test('can update settings', async ({ page }) => {
    await page.click('text=Settings');
    await expect(page.locator('form')).toBeVisible();
  });
});
```

### Fixtures

```typescript
import { test as base, expect } from '@playwright/test';

type Fixtures = {
  authenticatedPage: import('@playwright/test').Page;
};

const test = base.extend<Fixtures>({
  authenticatedPage: async ({ page }, use) => {
    await page.goto('/login');
    await page.fill('[name=email]', 'admin@example.com');
    await page.fill('[name=password]', 'admin');
    await page.click('button[type=submit]');
    await use(page);
  },
});

test('admin can see dashboard', async ({ authenticatedPage }) => {
  await authenticatedPage.goto('/admin');
  await expect(authenticatedPage.locator('h1')).toHaveText('Admin Dashboard');
});
```

## Selector Strategy

Prefer selectors in this order (most to least resilient):

1. **Role selectors** — `page.getByRole('button', { name: 'Submit' })`
2. **Text selectors** — `page.getByText('Welcome')`
3. **Label selectors** — `page.getByLabel('Email')`
4. **Placeholder** — `page.getByPlaceholder('Search...')`
5. **Test ID** — `page.getByTestId('submit-btn')`
6. **CSS selectors** — `page.locator('.btn-primary')` (last resort)

### Locator Chaining

```typescript
// Scope within a container
const form = page.locator('form#signup');
await form.getByLabel('Email').fill('test@example.com');
await form.getByRole('button', { name: 'Sign up' }).click();
```

## Running Tests

### Filtering

```bash
# By file
npx playwright test tests/auth.spec.ts

# By test title (grep)
npx playwright test --grep "login"
npx playwright test --grep-invert "slow"

# By project (browser)
npx playwright test --project chromium

# By tag (Playwright 1.42+)
npx playwright test --grep "@smoke"
```

### Debugging

```bash
# Playwright Inspector (step through, pick locators)
npx playwright test --debug

# Debug specific test
npx playwright test --debug --grep "checkout"

# UI mode (interactive, watch mode)
npx playwright test --ui

# Headed browser (visible)
npx playwright test --headed
```

### Parallelism

```bash
# Control worker count
npx playwright test --workers 4
npx playwright test --workers 1       # Sequential

# Shard across CI machines
npx playwright test --shard 1/3       # Machine 1 of 3
npx playwright test --shard 2/3       # Machine 2 of 3
npx playwright test --shard 3/3       # Machine 3 of 3
```

## Reporters

| Reporter | Use Case |
|----------|----------|
| `list` | Default, shows test names and status |
| `dot` | Minimal, one char per test |
| `html` | Rich HTML report with traces |
| `json` | Machine-readable output |
| `junit` | CI integration (JUnit XML) |
| `github` | GitHub Actions annotations |
| `blob` | For merging sharded results |

```bash
# Multiple reporters
npx playwright test --reporter=list,html

# View HTML report
npx playwright show-report
```

## Traces

Traces capture a complete record of test execution: DOM snapshots, network, console, actions.

### Recording Strategies

| Strategy | When Recorded |
|----------|---------------|
| `on` | Always |
| `off` | Never |
| `on-first-retry` | Only on first retry (recommended for CI) |
| `retain-on-failure` | Recorded always, kept only on failure |

### Viewing Traces

```bash
# Open trace viewer
npx playwright show-trace trace.zip

# Traces are in test-results/ after a run
npx playwright show-trace test-results/test-name/trace.zip
```

The trace viewer shows: timeline, action log, DOM snapshots at each step, network requests, console messages, and source code.

## CI Integration

### GitHub Actions

```yaml
name: Playwright Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30
```

### Sharded CI

```yaml
jobs:
  test:
    strategy:
      matrix:
        shard: [1/4, 2/4, 3/4, 4/4]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npx playwright install --with-deps
      - run: npx playwright test --shard ${{ matrix.shard }}
      - uses: actions/upload-artifact@v4
        if: ${{ !cancelled() }}
        with:
          name: blob-report-${{ strategy.job-index }}
          path: blob-report/

  merge-reports:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci
      - uses: actions/download-artifact@v4
        with:
          path: all-blob-reports
          pattern: blob-report-*
          merge-multiple: true
      - run: npx playwright merge-reports --reporter=html ./all-blob-reports
      - uses: actions/upload-artifact@v4
        with:
          name: playwright-report
          path: playwright-report/
```

### Key CI Tips

- Always use `npx playwright install --with-deps` to install browsers and OS dependencies.
- Set `retries: 2` in CI config to handle flaky tests.
- Use `reporter: 'github'` for inline annotations on PRs.
- Upload `playwright-report/` as an artifact for post-mortem analysis.
- Set `workers: 1` in CI if tests share state or resources.
