# AI-101 + AI-102: Logged-Out Landing Page & Hidden Nav

**Linear:** AI-101, AI-102 | **Status:** In Progress | **Date:** 2026-04-04

## Context

Currently, logged-out users see the full AppShell (sidebar + nav + services grid). The middleware only protects `/dashboard`, `/profile`, `/settings`, `/agents`, `/docs`, `/admin` — but `/`, `/chat`, and `/harness/*` are unprotected and show the full nav to unauthenticated users. The home page shows internal service cards that are meaningless to logged-out visitors.

**AI-101**: Hide app navigation (sidebar, mobile drawer, hamburger) for logged-out users.
**AI-102**: Replace the current home page with a marketing-style hero + login CTA for logged-out users.

---

## 1. Goal / Signal

After this lands:
- Logged-out users at `/` see a clean hero landing page with Hill90 branding and a "Sign in" CTA
- Logged-out users see NO sidebar, NO mobile drawer, NO hamburger menu — only TopBar with logo + sign-in button
- Logged-in users at `/` see the existing services grid page with full nav (unchanged)
- Middleware now also protects `/chat` and `/harness` routes
- All existing authenticated-user behavior is unchanged

---

## 2. Scope

**In scope:**
- New `LandingHero` client component — marketing hero with logo, headline, description, sign-in CTA
- Conditional rendering in `page.tsx` — show `LandingHero` when no session, existing content when authenticated
- `Sidebar.tsx` — return `null` when no session
- `MobileDrawer.tsx` — return `null` when no session (already has `useSession`)
- `TopBar.tsx` — hide hamburger button when no session
- `middleware.ts` — add `/chat/:path*` and `/harness/:path*` to matcher
- 7 vitest tests

**Out of scope:**
- Changes to `AuthButtons.tsx` (already handles logged-out state correctly — shows sign-in icon)
- Changes to `nav-items.ts` (nav config unchanged — just hidden when logged out)
- Changes to `AppShell.tsx` (server component — session gating done in children)
- Changes to `layout.tsx`
- Any API changes
- Landing page animations, illustrations, or dynamic content

---

## 3. TDD Matrix

| # | Requirement | Test Name | Type | File |
|---|---|---|---|---|
| T1 | Landing hero renders for logged-out users | `shows landing hero when not authenticated` | vitest | LandingHero.test.tsx |
| T2 | Landing hero has sign-in CTA | `landing hero has sign-in button` | vitest | LandingHero.test.tsx |
| T3 | Home page shows services grid for authenticated users | `home page shows services grid when authenticated` | vitest | AppShell.test.tsx |
| T4 | Sidebar returns null when no session | `Sidebar renders nothing when logged out` | vitest | Sidebar.test.tsx |
| T5 | Sidebar renders nav when authenticated | `Sidebar renders nav items when logged in` | vitest | Sidebar.test.tsx |
| T6 | MobileDrawer returns null when no session | `MobileDrawer renders nothing when logged out` | vitest | MobileDrawer.test.tsx |
| T7 | TopBar hides hamburger when no session | `TopBar hides hamburger menu when logged out` | vitest | TopBar.test.tsx |

---

## 4. Implementation Steps

### Phase A: Middleware expansion

1. Add `/chat/:path*` and `/harness/:path*` to the middleware matcher array in `middleware.ts`.

### Phase B: Nav hiding (AI-101)

2. **Sidebar.tsx**: Add early return `if (!session) return null` after the `useSession()` call. The sidebar already calls `useSession()` for role checks.

3. **MobileDrawer.tsx**: Add early return `if (!session) return null` before the existing `if (!open) return null`. Already calls `useSession()`.

4. **TopBar.tsx**: Conditionally hide the hamburger button. TopBar is a client component but doesn't have `useSession`. Add `useSession()` and wrap the hamburger `<button>` with `{session && ...}`.

### Phase C: Landing page (AI-102)

5. Create `services/ui/src/components/LandingHero.tsx` — client component:
   - Full-viewport centered hero
   - HillLogo (large)
   - Headline: "Hill90 Platform"
   - Subtitle: concise platform description
   - "Sign in" button calling `signIn("keycloak")`
   - Footer with copyright
   - Uses existing design tokens (navy-900, brand-500, mountain-400)

6. Update `services/ui/src/app/page.tsx`:
   - Convert to a client component (needs `useSession`)
   - If no session: render `<LandingHero />`
   - If session: render existing `<AppShell>` with services grid

### Phase D: Tests

7. Create `services/ui/src/__tests__/LandingHero.test.tsx` with T1-T2.
8. Add T4-T5 to existing `Sidebar.test.tsx`.
9. Add T6 to existing `MobileDrawer.test.tsx`.
10. Add T7 to existing `TopBar.test.tsx`.

---

## 5. Verification Matrix

| ID | Check | Command | Expected |
|---|---|---|---|
| V1 | New LandingHero tests pass | `cd services/ui && npx vitest run LandingHero` | 2 tests green |
| V2 | Sidebar tests pass | `cd services/ui && npx vitest run Sidebar` | All pass including T4-T5 |
| V3 | MobileDrawer tests pass | `cd services/ui && npx vitest run MobileDrawer` | All pass including T6 |
| V4 | TopBar tests pass | `cd services/ui && npx vitest run TopBar` | All pass including T7 |
| V5 | Full UI suite passes | `cd services/ui && npx vitest run` | All 522+ pass |
| V6 | Middleware test | `cd services/ui && npx vitest run middleware` | All pass |

---

## 6. CI / Drift Gates

- **Existing gates preserved:** Vitest (UI), Jest (API), compose validation
- **No new CI job:** existing vitest suite covers 7 new tests
- **Drift risk:** If new routes are added without middleware protection, logged-out users could access them. The nav hiding is defense-in-depth — middleware is the security boundary.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `useSession` in TopBar causes loading flash | Low | Low | AuthButtons already handles loading state with skeleton; hamburger hidden during loading is acceptable |
| page.tsx conversion to client component breaks SEO | Low | Low | Home page has no meaningful SEO content; metadata exported from layout.tsx is unaffected |
| Existing Sidebar/MobileDrawer tests break | Medium | Low | Tests mock `useSession` — update mock to return null for logged-out tests |
| Middleware redirect loop for `/` | None | N/A | `/` is NOT in the matcher — it remains public, handled by page.tsx conditional |

---

## 8. Definition of Done

- [ ] Logged-out users see hero landing page at `/` (T1, T2)
- [ ] Logged-out users see no sidebar (T4)
- [ ] Logged-out users see no mobile drawer (T6)
- [ ] Logged-out users see no hamburger button (T7)
- [ ] Logged-in users see full nav + services grid (T3, T5)
- [ ] `/chat` and `/harness` routes redirect to sign-in when not authenticated
- [ ] 7 new tests pass (V1-V4)
- [ ] Full UI suite green (V5)
- [ ] No changes to API
- [ ] No changes to nav-items.ts

---

## 9. Stop Conditions

**Stop if:**
- `useSession()` in TopBar causes a visible layout shift during loading (would need a different approach — prop-drilling or server-side session)
- Landing page renders inside AppShell (should render standalone — verify)
- Middleware expansion causes redirect loops for any public route

**Out of scope (future work):**
- Landing page feature showcase / marketing content
- Landing page animations
- SEO metadata for landing page
- `/` route redirect for authenticated users (they see the services grid, which is fine)

---

## Plan Checklist

- [x] Goal / Signal
- [x] Scope
- [x] TDD Matrix
- [x] Implementation Steps
- [x] Verification Matrix
- [x] CI / Drift Gates
- [x] Risks & Mitigations
- [x] Definition of Done
- [x] Stop Conditions

---

## Critical Files

| File | Change |
|---|---|
| `services/ui/src/middleware.ts` | Add `/chat/:path*`, `/harness/:path*` to matcher |
| `services/ui/src/components/Sidebar.tsx` | Return null when no session |
| `services/ui/src/components/MobileDrawer.tsx` | Return null when no session |
| `services/ui/src/components/TopBar.tsx` | Add useSession, hide hamburger when logged out |
| `services/ui/src/components/LandingHero.tsx` | NEW — marketing hero with sign-in CTA |
| `services/ui/src/app/page.tsx` | Conditional: LandingHero (logged out) vs AppShell+grid (logged in) |
| `services/ui/src/__tests__/LandingHero.test.tsx` | NEW — 2 tests (T1-T2) |
| `services/ui/src/__tests__/Sidebar.test.tsx` | 2 new tests (T4-T5) |
| `services/ui/src/__tests__/MobileDrawer.test.tsx` | 1 new test (T6) |
| `services/ui/src/__tests__/TopBar.test.tsx` | 1 new test (T7) |
