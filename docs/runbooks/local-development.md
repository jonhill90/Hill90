# Local Development Runbook

Run the Hill90 infrastructure stack on a Mac, using the same compose files
production uses.

## Before you start

Docker Desktop must be running. Nothing else is required — no SOPS, no age key,
no Tailscale, no VPS access, no secrets of any kind.

`.env.local` is created for you from `.env.local.example` on first run; you do
not need to copy it yourself. It is gitignored.

## One command

```bash
bash scripts/local.sh up
```

That builds and starts ten containers — the edge stack (Traefik, dns-manager,
Portainer) and the observability stack (Prometheus, Grafana, Loki, Tempo,
Promtail, node-exporter, cAdvisor) — and waits until they actually answer.

```bash
bash scripts/local.sh health     # probe every routed surface
bash scripts/local.sh urls       # print the URLs
bash scripts/local.sh status     # container status
bash scripts/local.sh logs       # follow everything, or: logs <container>
bash scripts/local.sh down       # remove containers and networks, keep data
bash scripts/local.sh reset      # also delete the local volumes (prompts)
```

Cold start takes roughly a minute, most of it Grafana installing plugins. From a
completely clean machine — no containers, no volumes, no `.env.local` — the
measured time is 65 seconds.

Verify it worked:

```bash
bash scripts/local.sh health
```

```
Routed surfaces
  ✓ Traefik dashboard — HTTP 200
  ✓ Portainer — HTTP 200
  ✓ Grafana — HTTP 200

Observability internals
  ✓ Prometheus ready
  ✓ Loki ready
  ✓ Grafana health

✓ All local checks passed.
```

## URLs

| Surface | URL |
|---|---|
| Traefik dashboard | http://traefik.localtest.me:8080/dashboard/ |
| Portainer | http://portainer.localtest.me:8080/ |
| Grafana | http://grafana.localtest.me:8080/ (admin / admin) |

`localtest.me` is a public DNS zone where every name resolves to `127.0.0.1`.
That gives real `Host`-header routing through Traefik with no `/etc/hosts`
editing and no wildcard DNS to configure.

## How this avoids "works on my machine"

**The compose files are the production ones.** `scripts/local.sh` runs
`deploy/compose/prod/docker-compose.{infra,observability}.yml` — the exact files
`deploy.sh infra prod` runs — layered with
`deploy/compose/overrides/local.*.yml` and `.env.local`. There is no dev compose
tree. There used to be one; it was deleted because it had drifted so far it
referenced a service that no longer existed.

**Production is the default, not a configuration.** Every `${VAR}` in those
files carries a production default, so with no environment set at all they
resolve to exactly what the VPS gets:

```bash
docker compose -f deploy/compose/prod/docker-compose.infra.yml config | grep -E 'container_name|hill90.com'
#   container_name: traefik
#   traefik.http.routers.traefik.rule: Host(`traefik.hill90.com`)
```

Local development cannot silently change production, because local development
is what happens when you *add* variables.

**CI enforces the surface.** `scripts/checks/check_env_surface.py` fails the
build if a variable is used but undocumented, documented but unused, missing a
production default, or — for a credential — given a fallback value.

## What differs locally, and why

macOS Docker Desktop has no systemd, no firewalld, no Tailscale, no public DNS
and no path to Let's Encrypt. Each difference is one variable:

| Difference | Mechanism | Production default |
|---|---|---|
| Hostnames | `BASE_DOMAIN=localtest.me` | `hill90.com` |
| Plain HTTP, no TLS | `ADMIN_ENTRYPOINT=web` | `websecure` |
| No certificates | `ADMIN_CERT_RESOLVER=` | `letsencrypt-dns` |
| No Tailscale allowlist | `ADMIN_MIDDLEWARES=compress@file` | `tailscale-only@file` |
| No basic-auth secret | `TRAEFIK_MIDDLEWARES=compress@file` | `auth@file,tailscale-only@file` |
| Port 80 already in use | `HTTP_PORT=8080` | `80` |
| Coexist with other stacks | `CONTAINER_PREFIX`, `NETWORK_PREFIX`, `VOLUME_PREFIX` | unset / `hill90` / `prod` |

If `up` reports that a network belongs to another compose project, change
`NETWORK_PREFIX` in `.env.local`. The default is `hill90dev`; an earlier default
of `hill90local` collided with a separate Hill90 app stack on the reference
machine, which is why that check exists.

### The one file that is genuinely duplicated

`platform/edge/traefik.local.yml` exists alongside `platform/edge/traefik.yml`.

This is not a shortcut. Traefik v2 reads its **static** configuration from
exactly one source — a file, environment variables, or CLI flags — and does not
merge them. Verified directly:

```
$ docker run traefik:v2.11 --certificatesresolvers.le.acme.caserver=https://canary.invalid/dir
  (with /etc/traefik/traefik.yml mounted)
level=info msg="Configuration loaded from file: /etc/traefik/traefik.yml"
```

The flag is silently ignored. So the local variant cannot be an override; it
has to be a second file. The two differ only in ACME, the HTTPS redirect, the
log level, and a local-only Docker provider constraint. **If you change one,
change both.**

## Teardown and rebuild

Iteration is only safe when teardown is routine.

```bash
bash scripts/local.sh down     # containers and networks; volumes survive
bash scripts/local.sh up       # rebuild to an identical result
```

`reset` is the destructive form. It deletes the local volumes and requires you
to type `reset` to confirm. It can only ever touch the local Docker daemon —
`local.sh` contains no SSH and no VPS hostname, asserted by a test.

Volumes survive `down`, so a rebuild comes back with its data. Verified: 7
volumes before and after, and Grafana still has its 4 provisioned dashboards.

On the VPS, the equivalent is:

```bash
bash scripts/deploy.sh teardown observability prod   # backs up first, keeps volumes
bash scripts/deploy.sh observability prod            # rebuild
bash scripts/deploy.sh verify observability
```

`deploy.sh teardown` never removes volumes and never uses orphan removal. On
the VPS, deleting a volume stays a deliberate manual act preceded by
`scripts/backup.sh` — routine operations must not be able to destroy data.

## Troubleshooting

**Port already allocated.** Something else owns 8080. Change `HTTP_PORT` in
`.env.local`.

**Traefik ignores an edit to `traefik.local.yml`.** Static config is read once
at startup and is not watched. `local.sh up` force-recreates the edge stack for
exactly this reason; if you started Traefik another way, restart it.

**Grafana 404 immediately after `up`.** It is still installing plugins.
`local.sh up` waits for it; `docker compose up` on its own does not.

**Loki shows logs from containers that are not Hill90's.** Expected. Promtail
discovers containers through the Docker socket and ships everything on the host;
on a developer Mac that includes whatever else you have running. On the VPS there
are no neighbours, so the config is not narrowed — narrowing it locally would
mean forking `promtail.yml`, which is exactly what this setup avoids. Filter in
Grafana with `{container=~"hill90dev-.*"}`.

**Routers from another project appear in the dashboard.** Traefik's Docker
provider sees every container on the socket. The local static config constrains
it to three compose projects — `hill90-local-edge`, `hill90-local-observability`
and `hill90-local`, the last being the
[hill90-app](https://github.com/jonhill90/hill90-app) stack, which attaches to
these networks through its own opt-in overlay. Production has no such
neighbours and does not need the constraint.

## See Also

- [Deployment runbook](./deployment.md) — the VPS path
- [Deployment reference](../reference/deployment.md) — compose files and stacks
- [Architecture overview](../architecture/overview.md)
