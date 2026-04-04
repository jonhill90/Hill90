# AI-136 + AI-137: Container Profiles Phase 2 — Specialized Profiles + Documentation

**Linear:** AI-136, AI-137 | **Status:** In Progress | **Date:** 2026-04-04

## Context

Phase 1 (AI-91/AI-122) shipped the container profiles foundation: `container_profiles` table with `standard` seed profile, agent FK, CRUD API, UI dropdown in agent form, and image resolution at container start. All agents currently use the single `hill90/agentbox:latest` image.

Phase 2 adds **specialized container profiles** (browser, monitor) with compose template generation, and **documents the profiles system** in agent-harness.md.

### Current State
- **Schema**: `container_profiles` table with columns: `id`, `name`, `description`, `docker_image`, `default_cpus`, `default_mem_limit`, `default_pids_limit`, `is_platform`, `created_at`, `updated_at`
- **Seed**: Single `standard` profile (`hill90/agentbox:latest`)
- **Docker flow**: `agents.ts` resolves `profileImage` from DB → passes to `createAndStartContainer()` → Docker API `Image` field
- **Container creation**: `docker.ts` creates container with image, 3 named volumes, config bind mount, resource limits, network assignment
- **Agentbox Dockerfile**: `python:3.12-slim` with bash, git, curl, wget, jq, rsync, vim, make

---

## 1. Goal / Signal

After this lands:
- Two new platform profiles seeded: `browser` and `monitor`
- `browser` profile targets a Playwright-equipped image (`hill90/agentbox-browser:latest`) with higher default resources
- `monitor` profile targets a lightweight image (`hill90/agentbox-monitor:latest`) with lower default resources
- Migration 039 seeds the new profiles (no schema changes — existing table is sufficient)
- Compose templates exist for building specialized images (Dockerfiles + compose override files)
- `docker.ts` `createAndStartContainer()` supports optional extra volumes and env vars from profile metadata
- Migration 039 adds a `metadata` JSONB column to `container_profiles` for profile-specific configuration (extra volumes, env vars, ports)
- `agent-harness.md` documents the profiles system comprehensively
- Admin can assign any profile to an agent; the correct image + config is used at start time
- 6 API tests + UI admin page displays new profiles

---

## 2. Scope

**In scope:**
- Migration 039: add `metadata JSONB DEFAULT '{}'` to `container_profiles`, seed `browser` and `monitor` profiles
- `Dockerfile.browser` and `Dockerfile.monitor` in `services/agentbox/` — specialized image definitions
- `docker-compose.agentbox-images.yml` in `deploy/compose/prod/` — compose file for building all agentbox image variants
- `docker.ts` update: read profile `metadata` for extra volumes/env, pass to container creation
- `agents.ts` update: resolve profile metadata alongside image at start time
- `container-profiles.ts` update: return metadata in GET responses
- Agent harness docs update: new "Container Profiles" section in `docs/architecture/agent-harness.md`
- 6 API tests for profile metadata resolution and container creation with extra config
- OpenAPI spec update for metadata field

**Out of scope:**
- Actually building and pushing the specialized Docker images (that's CI/deployment — this PR adds the Dockerfiles and compose, not the built images)
- Runtime changes to agentbox app code (the Python application is image-agnostic)
- UI changes beyond what already works (the profile dropdown already shows all profiles)
- GPU profiles or CUDA support (future)
- Profile version tracking

---

## 3. TDD Matrix

| # | Requirement | Test Name | Type | File |
|---|---|---|---|---|
| T1 | Migration adds metadata column | `container_profiles has metadata column` | jest | routes-container-profiles.test.ts |
| T2 | GET profiles returns metadata field | `GET /container-profiles returns metadata` | jest | routes-container-profiles.test.ts |
| T3 | POST profile accepts metadata | `POST /container-profiles accepts metadata` | jest | routes-container-profiles.test.ts |
| T4 | Agent start resolves profile metadata | `agent start passes profile metadata to docker` | jest | routes-agents.test.ts |
| T5 | createAndStartContainer uses extra volumes from metadata | `createAndStartContainer applies extra volumes from metadata` | jest | docker.test.ts (new or existing) |
| T6 | createAndStartContainer uses extra env from metadata | `createAndStartContainer applies extra env from metadata` | jest | docker.test.ts |

---

## 4. Implementation Steps

### Phase A: Migration 039

1. Create `services/api/src/db/migrations/039_add_profile_metadata_and_seed.sql`:
   ```sql
   -- Add metadata JSONB for profile-specific container config
   ALTER TABLE container_profiles ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}';

   -- Seed browser profile
   INSERT INTO container_profiles (name, description, docker_image, default_cpus, default_mem_limit, default_pids_limit, is_platform, metadata)
   VALUES (
     'browser',
     'Agentbox with Playwright and Chromium for web browsing, scraping, and testing',
     'hill90/agentbox-browser:latest',
     '2.0', '2g', 300, true,
     '{"extra_env": ["PLAYWRIGHT_BROWSERS_PATH=/data/browsers"], "shm_size": "256m"}'
   );

   -- Seed monitor profile
   INSERT INTO container_profiles (name, description, docker_image, default_cpus, default_mem_limit, default_pids_limit, is_platform, metadata)
   VALUES (
     'monitor',
     'Lightweight monitoring agent with minimal resource footprint',
     'hill90/agentbox-monitor:latest',
     '0.5', '256m', 100, true,
     '{}'
   );
   ```

### Phase B: Specialized Dockerfiles

2. Create `services/agentbox/Dockerfile.browser`:
   - FROM `hill90/agentbox:latest` (extends standard)
   - Install Playwright dependencies + Chromium
   - Set `PLAYWRIGHT_BROWSERS_PATH=/data/browsers`
   - Keep same entrypoint, user, health check

3. Create `services/agentbox/Dockerfile.monitor`:
   - FROM `python:3.12-slim` (minimal — no git, curl, jq, etc.)
   - Only install core Python deps for the agentbox app
   - Smaller footprint for monitoring/health-only agents

4. Create `deploy/compose/prod/docker-compose.agentbox-images.yml`:
   - Build targets for all three images: standard, browser, monitor
   - Used by `docker compose build` on VPS during deploy

### Phase C: Docker service enhancement

5. Update `CreateAgentContainerOpts` interface in `docker.ts`:
   ```typescript
   export interface CreateAgentContainerOpts {
     // ... existing fields
     metadata?: {
       extra_env?: string[];
       extra_volumes?: Array<{ source: string; target: string; type?: string }>;
       shm_size?: string;
     };
   }
   ```

6. Update `createAndStartContainer()` to apply metadata:
   - Append `metadata.extra_env` to container `Env` array
   - Append `metadata.extra_volumes` to `Mounts` array
   - Set `ShmSize` on `HostConfig` if `metadata.shm_size` is set (needed for Chromium)

### Phase D: Agent start flow enhancement

7. Update `agents.ts` agent start (lines ~828-848):
   - After resolving `profileImage`, also resolve `profileMetadata` from the same query
   - Pass `metadata` to `createAndStartContainer()`

8. Update `container-profiles.ts` GET routes to include `metadata` in SELECT and response.

### Phase E: OpenAPI spec update

9. Add `metadata` field to ContainerProfile schema in `openapi.yaml` + sync to `docs/site/openapi.yaml`.

### Phase F: Documentation (AI-137)

10. Add **Container Profiles** section to `docs/architecture/agent-harness.md` after the "Container Resources" section. Content:
    - What profiles are and why they exist
    - Profile table schema reference
    - Three platform profiles: standard, browser, monitor (image, purpose, default resources)
    - How profiles are assigned (agent form, API)
    - How profiles are resolved at start time (image + metadata)
    - Metadata contract (extra_env, extra_volumes, shm_size)
    - Custom profile creation guidance (admin CRUD API)
    - Specialized image build process (Dockerfiles, compose)

### Phase G: Tests

11. Add T1-T3 to `routes-container-profiles.test.ts` (or create if needed).
12. Add T4 to `routes-agents.test.ts` (agent start with profile metadata).
13. Add T5-T6 testing `createAndStartContainer` with metadata.

---

## 5. Verification Matrix

| ID | Check | Command | Expected |
|---|---|---|---|
| V1 | Migration applies | `psql: SELECT column_name FROM information_schema.columns WHERE table_name='container_profiles' AND column_name='metadata'` | 1 row |
| V2 | New profiles seeded | `psql: SELECT name, docker_image FROM container_profiles ORDER BY name` | 3 rows: browser, monitor, standard |
| V3 | API returns metadata | `curl /container-profiles` | All profiles include metadata field |
| V4 | Agent start with browser profile | Start agent with browser profile | Container created with `hill90/agentbox-browser:latest` image + shm_size |
| V5 | Dockerfiles valid | `docker build -f Dockerfile.browser .` | Builds successfully |
| V6 | API tests pass | `cd services/api && npm test` | All pass |
| V7 | Docs section exists | `grep 'Container Profiles' docs/architecture/agent-harness.md` | Found |
| V8 | OpenAPI drift clean | CI check | Pass |

---

## 6. CI / Drift Gates

- **Existing gates preserved:** Jest (API), Vitest (UI), OpenAPI drift, compose validation
- **New Dockerfiles**: Not built in CI (no Docker-in-Docker). Build verification is deployment-time.
- **Drift risk**: If container_profiles schema changes, the metadata parsing in docker.ts must be updated. The T5-T6 tests catch this.

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Browser image too large for VPS disk | Medium | Medium | Chromium adds ~400MB. Monitor that VPS disk stays under 80%. Can prune old images. |
| Playwright needs /dev/shm for Chromium | Certain | High | `shm_size` in metadata is applied via Docker `ShmSize` param. Without it, Chromium crashes. |
| Metadata JSONB schema drift | Low | Medium | Metadata is typed in TypeScript interface. No arbitrary keys. Tests validate structure. |
| Existing agents unaffected | Very Low | High | Standard profile metadata is `{}` — empty. No extra_env, no extra_volumes. Backward compatible. |
| Browser image needs Xvfb or headless flag | Medium | Low | Playwright in headless mode (default). No X11/Xvfb needed. |

---

## 8. Definition of Done

- [ ] Migration 039 applies cleanly (V1, V2)
- [ ] GET /container-profiles returns metadata for all profiles (V3)
- [ ] Agent start with browser profile creates container with correct image + shm_size (V4)
- [ ] Dockerfile.browser and Dockerfile.monitor exist and are valid (V5)
- [ ] Compose file for image building exists
- [ ] docker.ts applies metadata (extra_env, shm_size) to container creation (T5, T6)
- [ ] 6 API tests pass (V6)
- [ ] agent-harness.md has comprehensive Container Profiles section (V7)
- [ ] OpenAPI spec updated (V8)
- [ ] No existing test regressions
- [ ] No changes to agentbox Python application code

---

## 9. Stop Conditions

**Stop if:**
- Metadata JSONB approach is too loose — would need a structured `profile_config` table instead (unlikely — 3 optional keys is fine for JSONB)
- Browser image exceeds 2GB (would need multi-stage build optimization first)
- Docker API doesn't support ShmSize through the dockerode client (verify before implementing)
- VPS has insufficient disk for 3 image variants (check `df -h` before merge)

**Out of scope (future work):**
- GPU/CUDA profiles (need nvidia-docker runtime, not available on Hostinger VPS)
- Profile versioning / tag management
- Automated image building in CI (needs Docker-in-Docker or remote builder)
- Profile-specific health check overrides
- Custom user-created profiles with custom Dockerfiles (admin can create profiles via API, but image must already exist)

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
| `services/api/src/db/migrations/039_add_profile_metadata_and_seed.sql` | NEW — metadata column + browser/monitor seeds |
| `services/agentbox/Dockerfile.browser` | NEW — Playwright + Chromium agentbox variant |
| `services/agentbox/Dockerfile.monitor` | NEW — minimal monitoring agentbox variant |
| `deploy/compose/prod/docker-compose.agentbox-images.yml` | NEW — build targets for all image variants |
| `services/api/src/services/docker.ts` | Apply profile metadata (extra_env, shm_size) |
| `services/api/src/routes/agents.ts` | Resolve profile metadata at start time |
| `services/api/src/routes/container-profiles.ts` | Include metadata in SELECT/response |
| `services/api/src/openapi/openapi.yaml` | ContainerProfile metadata field |
| `docs/site/openapi.yaml` | Sync |
| `docs/architecture/agent-harness.md` | New "Container Profiles" section (AI-137) |
| `services/api/src/__tests__/routes-container-profiles.test.ts` | T1-T3 |
| `services/api/src/__tests__/routes-agents.test.ts` | T4 |
| `services/api/src/__tests__/docker.test.ts` | T5-T6 (new file or section) |
