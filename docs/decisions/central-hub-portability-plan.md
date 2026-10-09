# Central Hub: a provider-agnostic platform plan

**Status:** proposed, 2026-10-09. Nothing in this document has been built, run or
deployed, and it changes no file outside `docs/`. The forks in section 8 are
Jon's to decide; each carries a recommendation, not a decision.

**Evidence labels.** Following this repository's rule that a figure is either
measured or inferred, every claim below is tagged **[measured]** (read from this
tree on the date above) or **[inferred]** (from general knowledge of the products,
to be checked before it is relied on).

## 1. Goal and motto

> Anything worth doing is worth doing well.

Hill90 should be the Central Hub: a self-hosted, open-source platform that
provides identity, networking, data, secrets, storage and observability to
whatever runs on it. The compute underneath it must be replaceable. Today that
compute is a Hostinger VPS. Tomorrow it could be Azure, DigitalOcean, Akash or a
machine at home, and moving should be a configuration change plus a restore, not
a rewrite.

Three properties, in Jon's words, are the acceptance test for every choice below:

| Property | Concrete meaning here |
|---|---|
| **Adaptable** | Changing the provider, a service or the runtime touches one named place. |
| **Modular** | Every layer is reached through a contract (a protocol or a small interface), never through a product's name. |
| **Easy to iterate** | A full rebuild from empty is routine and rehearsed, not an emergency. |

This extends [Hill90 as an open-source mirror of the Azure platform primitives](platform-primitives.md)
and the tenant contract in [App tenancy on the VPS](app-tenancy-on-the-vps.md).
It does not replace either. The governing principle stays: **the platform
provides identity, data and storage; tenants consume them.**

## 2. Design rules

1. **Depend on contracts, not products.** Keycloak is "an OIDC issuer", OpenBao is
   "a secrets API", MinIO is "an S3 endpoint", Postgres is "a libpq endpoint".
   A tenant that names the product has leaked the implementation.
2. **The provider is a leaf.** Exactly one layer (L0) knows which company owns the
   machine. Nothing above it may name a provider, an IP, or a provider API.
3. **State is the only real lock-in.** Compute is cheap to replace; data is not.
   Portability is therefore measured by one question: *can the state be restored
   on a different provider from a copy that does not live on the old one?*
4. **A claim of portability is a test, not a sentence.** Nothing is "provider
   agnostic" until it has been stood up on a second provider and the same checks
   passed. Until then it is "designed to be".
5. **Pin and prefer open licences and open protocols.** Where a component is not
   fully open, name the exit.
6. **Smallest swap wins.** Do not introduce an abstraction layer for a swap nobody
   has a plan to make. Write the contract down; build the adapter when a second
   implementation exists.

## 3. The layers

Each layer says what it is for, what its contract is, what implements it now, and
what it could be swapped for.

| Layer | Purpose | Contract (what upper layers rely on) | Today | Swap candidates |
|---|---|---|---|---|
| **L0 Provider** | Supplies a machine, disk, public address and a way to rebuild it | "A Linux host I can reach over SSH once, with a disk and an IP" | Hostinger VPS via `scripts/hostinger.sh`, `recreate-vps.yml` | DigitalOcean, Azure VM, local VM or mini-PC, Akash (as a workload target only, see section 6) |
| **L1 Host baseline** | Turns a blank OS into a hardened Docker host | Ansible playbooks `01`–`12` under `infra/ansible/playbooks` | AlmaLinux 10 + Ansible | Any distro, if the playbooks stay variable-driven |
| **L2 Network** | Private admin plane and service-to-service reachability | A flat private address space across hosts; no public admin surface | Tailscale | Headscale (self-hosted control plane), NetBird, plain WireGuard |
| **L3 Runtime** | Runs containers and wires their networks and volumes | OCI images, named networks, named volumes, health checks | Docker Compose | k3s or another Kubernetes (CNCF), Nomad |
| **L4 Platform services** | The shared services tenants consume | See table in section 4 | Keycloak, OpenBao, Postgres, MinIO, Traefik, LGTM stack | Per row in section 4 |
| **L5 State and recovery** | Backups, restore, and the proof they work | Restic-style encrypted snapshot to storage on a different provider | `scripts/backup.sh`, on the VPS itself | S3 bucket elsewhere, a second site |
| **L6 Tenant contract** | What an app gets and must follow | Versioned document and a conformance check | `app-tenancy-on-the-vps.md`, hill90-app | Same contract, any runtime |

Measured coupling of this tree to L0, so the first refactor has a real list
**[measured, 2026-10-09, `grep -i hostinger` over `.github`, `scripts`,
`infra/ansible`, `Makefile`]**:

- `scripts/hostinger.sh` (the whole file) and `scripts/vps.sh` `cmd_recreate`,
  which hardcodes Hostinger template id `1183` and reads the new IP from the
  Hostinger response.
- `.github/workflows/recreate-vps.yml` passes `HOSTINGER_API_KEY`.
- `Makefile` target for `vps snapshot create`.
- `HOSTINGER_API_KEY` in the secrets schema and in `scripts/vault.sh`.
- Mail: `scripts/render-alertmanager-config.sh` uses `smtp.hostinger.com`. This is
  a mail provider dependency, separate from compute. Mail records are already
  outside this repo ([dns.md](../reference/dns.md)).
- DNS is already provider-neutral: Cloudflare, one record at a time
  ([dns.md](../reference/dns.md)). That is the pattern to copy.
- L1 is RHEL-family specific: `firewalld` and `dnf` appear in playbooks `01`, `02`,
  `04`, `05` and `ssh-harden`.

There is no Kubernetes anywhere in the tree; everything is Compose.

## 4. Platform services and how each is swapped

| Service | Role | Contract tenants use | Open status | If it has to change |
|---|---|---|---|---|
| Keycloak | Identity | OIDC discovery, realm, client roles | Apache-2.0, CNCF incubating **[inferred]** | Any OIDC issuer; clients only know an issuer URL and client id |
| OpenBao | Secrets | Vault-compatible KV/transit HTTP API | MPL-2.0, Linux Foundation **[inferred]** | HashiCorp Vault; SOPS remains the bootstrap and recovery path ([vault-vs-sops.md](vault-vs-sops.md)) |
| Postgres (+pgvector) | Relational data | libpq connection string, per-tenant database and role | PostgreSQL licence | Managed Postgres at any cloud, same string |
| MinIO | Object storage | S3 API, scoped credentials | AGPL-3.0; check current release and distribution policy before relying on it **[inferred]** | Garage, SeaweedFS, Ceph RGW, or a cloud S3, because the contract is S3 |
| Traefik | Edge routing, TLS | Host-based routing, ACME | MIT, not a CNCF project **[inferred]** | Envoy Gateway or any Gateway API implementation (CNCF) |
| Prometheus, OpenTelemetry | Metrics, telemetry intake | PromQL scrape, OTLP | CNCF graduated **[inferred]** | Stay |
| Loki, Tempo, Grafana | Logs, traces, dashboards | Loki/Tempo push and query APIs, Grafana dashboards-as-files | AGPL-3.0, Grafana Labs, not CNCF **[inferred]** | VictoriaLogs, Jaeger (CNCF), Perses (CNCF) |
| Portainer | Container UI | Admin only, none upstream | Source-available CE | Drop it, or Headlamp / k9s if the runtime moves to Kubernetes |

"CNCF where reasonable" is a preference, not a rule: Postgres, OpenBao, MinIO and
the Grafana stack are the right tools and are not CNCF projects. The test is the
contract and the exit, not the foundation.

## 5. Where the provider boundary goes

Create one directory and one interface, and nothing else, for L0:

```text
infra/providers/
  README.md            the contract below
  hostinger/           today's recreate/snapshot code, moved, behaviour unchanged
  local/               libvirt or Multipass VM on a laptop or mini-PC (first proof)
  digitalocean/        added when a second remote provider is wanted
```

A provider adapter implements five verbs and nothing more:

| Verb | Returns | Notes |
|---|---|---|
| `create` | host id, public IPv4 | Idempotent for a given site name |
| `recreate` | new public IPv4 | The destructive one; keeps today's `RECREATE` confirmation |
| `snapshot` | snapshot id | May be "unsupported"; callers must cope |
| `destroy` | none | Also behind confirmation |
| `describe` | state, address | Read-only; used by checks |

Everything after the address is returned is provider-independent: Ansible runs
against that address, Tailscale joins it, and the deploy workflows already work
over the tailnet.

A **site** is one running hub. Per-site values (provider, region, hostnames, which
services are enabled) live in `sites/<name>/site.yaml`, and the secrets store
stays SOPS-encrypted per site. The same repository then describes `prod` (today's
VPS) and any `lab` or `dr` site without forking files. This is the answer to "make
changes easy": a change is a diff to one site file or one adapter.

For tooling, the adapters can start as the existing shell, because the shell
already works and is tested (`tests/scripts/hostinger.bats`). OpenTofu (an open
fork of Terraform, in the CNCF sandbox **[inferred]**) becomes worth adopting when
the second remote provider arrives, since DigitalOcean and Azure have mature
providers for it. Do not rewrite working Hostinger code into it before then.

## 6. Where each provider fits

| Provider | Role | What changes | Main catch |
|---|---|---|---|
| Hostinger VPS | Current core host | Nothing | API surface is small; one snapshot kept **[measured: WP-05 note]** |
| Local machine | First portability proof and dev site | New adapter using a VM | Needs a stable tailnet identity and no public ports; certificates become DNS-01 only |
| DigitalOcean | Second remote core host | New adapter; OS image choice | Cheap and API-friendly; closest to Hostinger in shape |
| Azure | Core host or tenant-side services | VM adapter, later managed services behind the same contracts | Cost and identity sprawl; keep Keycloak as the one issuer |
| Akash | Burst or GPU **workload** target, not a core host | A tenant runs there and calls back over the tailnet | Deployments are container-only with no host access and no durable local disk, so Postgres, OpenBao and Keycloak do not belong there **[inferred]**; confirm persistent-storage options before any commitment |

The first four can each be the core. Akash is a place to run a tenant, which the
tenant contract already allows.

## 7. Phased path from today's VPS

Each phase has an exit test. A phase is not done on its own say-so.

**Phase 0: this document (now).** Exit: Jon has decided the forks in section 8.

**Phase 1: make the rebuild safe, and fix the seams while it is empty.** Aligned
with the planned wipe, not a change to it (section 9).
- Move backups off the VPS. Today they live on the host being wiped
  **[measured: WP-05, 4.6 GiB]**. Target: encrypted snapshots to storage at a
  different provider (a bucket, or the Mac as an interim).
- Extract `infra/providers/hostinger/` behind the five verbs, behaviour unchanged.
- Make the playbooks distro-neutral via variables, or record that the hub is
  RHEL-family on purpose.
- Introduce `sites/prod/site.yaml`, holding values that are scattered today.
- Exit: `recreate` and `config` still pass through the adapter; a restore from the
  off-host copy succeeds on the rebuilt host.

**Phase 2: prove a second site (the portability test).** Stand up `sites/lab` on
a local VM using only the adapter, Ansible and the existing deploy workflows,
then restore a Postgres and OpenBao backup from Phase 1 into it.
- Exit: the same health checks pass on both sites, and the diff between the two
  site files is the whole difference between them.

**Phase 3: tenant conformance.** Turn the tenant contract into a short checklist
plus a script. Run hill90-app against the `lab` site.
- Exit: the app runs on `lab` with no change in hill90-app except site values.

**Phase 4: second remote provider (DigitalOcean first).** Add the adapter and
perform a full cutover rehearsal: restore, switch DNS, switch tailnet identity.
- Exit: timed, written-down rehearsal; the old host untouched until it passes.

**Phase 5: runtime decision.** With real measurements from Phases 2 to 4, decide
whether Compose is still enough or k3s earns its cost (section 8, fork 1).

**Phase 6: Azure and Akash.** Azure as a core-host adapter or tenant-side
services; Akash as a workload target for a GPU or burst tenant.

## 8. Forks for Jon, with recommendations

| # | Fork | Recommendation | Why |
|---|---|---|---|
| 1 | **Runtime: stay on Compose or move to k3s/Kubernetes now** | Stay on Compose through Phase 4. Write every service so it could run unchanged as a container with environment and volumes. Re-decide at Phase 5. | Kubernetes buys scheduling and multi-host orchestration this single-host hub does not yet need, and costs a large rewrite of 22 workflows and the deploy guards. CNCF alignment is satisfied by the contracts now, and by the runtime later if evidence supports it. |
| 2 | **Network: Tailscale, or a fully open control plane** | Keep Tailscale (already chosen), hide it behind L2 so Headscale or NetBird is a swap. | The Tailscale client is open but its coordination server is not **[inferred]**. Jon's choice stands; the exit is just recorded. |
| 3 | **Provisioning tool for L0** | Keep shell adapters now; adopt OpenTofu when the second remote provider is added. | Working, tested Hostinger code should not be rewritten before a second provider exists to justify it. |
| 4 | **Base OS** | Keep AlmaLinux for the coming rebuild; make the playbooks variable-driven so a Debian-family host also works. | Changing OS during the wipe adds a second variable to a risky operation. Phase 2 shows whether neutrality is real. |
| 5 | **Backup target** | One encrypted store at a provider other than the hub's. Recommended: Cloudflare R2 or Backblaze B2, plus the Mac as an interim copy. | Cheap, S3-compatible, independent of the compute provider. This is the single highest-value change for portability. |
| 6 | **Repository shape** | Keep this repo as the platform repo; hub notes and experiments stay in Research; labs and apps stay one repo each. | Matches the split already agreed, and Hill90 plus hill90-app already work this way. |
| 7 | **MinIO** | Keep, but track its licence and release channel; the S3 contract keeps Garage or SeaweedFS available. | Switching costs nothing until it has to happen. |

## 9. Does this change the planned wipe and rebuild?

The wipe is owned by another thread and nothing here touches the VPS. The plan
does not require delaying it, but three things in `HILL90-REBUILD-PACKAGE.md`
interact with it:

1. **Backups on the VPS are the portability gap in miniature.** The package
   already copies them to the Mac before the wipe. Keep that step, and treat the
   off-host store in fork 5 as the permanent version.
2. **"OS and config only, then add services one at a time" fits this plan.** It is
   a clean first run of the Phase 1 seams. Hold the individual service deploys
   until the adapter extraction is at least designed, so they are not written
   against Hostinger-shaped scripts.
3. **The rebuild is a free test.** Record how long `recreate` plus `config` takes
   and what had to be done by hand. That is the baseline Phase 2 is measured
   against.

Recommended change: add a restore drill (restore the Mac copy onto the rebuilt
host, or onto a local VM) to the rebuild's exit criteria. A rebuild without a
restore is half a test.

## 10. Risks and non-goals

- **Abstraction before need.** Rule 6 exists because adapters for imaginary
  providers are the usual failure. Only Hostinger and one proof site are built
  before they are used.
- **Public repository.** Hill90 is public. Site files hold names and shapes only;
  addresses and keys stay in SOPS ([dns.md](../reference/dns.md) explains why).
- **Not in scope:** multi-region, high availability, and Kubernetes adoption.
  Those are decisions for Phase 5 onward, with measurements.
- **Open questions that are Jon's:** budget ceiling per provider, whether any
  data must stay on hardware he owns, and whether the tailnet is shared with
  non-hub devices.
