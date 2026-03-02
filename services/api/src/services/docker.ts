import Docker from 'dockerode';

function createDockerClient(): Docker {
  const dockerHost = process.env.DOCKER_HOST;
  if (!dockerHost) {
    return new Docker({ socketPath: '/var/run/docker.sock' });
  }
  try {
    const url = new URL(dockerHost);
    return new Docker({ host: url.hostname, port: Number(url.port) });
  } catch {
    throw new Error(`Invalid DOCKER_HOST: "${dockerHost}" — expected format: tcp://host:port`);
  }
}

const docker = createDockerClient();

const CONTAINER_PREFIX = 'agentbox-';
const MANAGED_LABEL = 'managed-by';
const MANAGED_VALUE = 'hill90-api';
const AGENT_NETWORK = 'hill90_agent_internal';
const VOLUME_SUFFIXES = ['workspace', 'logs', 'data'];

function assertAgentboxName(name: string): void {
  if (!name.startsWith(CONTAINER_PREFIX)) {
    throw new Error(`Refused: container name "${name}" does not start with "${CONTAINER_PREFIX}"`);
  }
}

function assertManagedLabel(labels: Record<string, string> | undefined): void {
  if (!labels || labels[MANAGED_LABEL] !== MANAGED_VALUE) {
    throw new Error(`Refused: container missing label ${MANAGED_LABEL}=${MANAGED_VALUE}`);
  }
}

function assertAgentboxVolume(volumeName: string, agentId: string): void {
  const allowedPattern = `${CONTAINER_PREFIX}${agentId}-`;
  if (!volumeName.startsWith(allowedPattern)) {
    throw new Error(`Refused: volume "${volumeName}" does not match pattern ${allowedPattern}*`);
  }
  const suffix = volumeName.slice(allowedPattern.length);
  if (!VOLUME_SUFFIXES.includes(suffix)) {
    throw new Error(`Refused: volume suffix "${suffix}" not in allowed list [${VOLUME_SUFFIXES.join(', ')}]`);
  }
}

export interface CreateAgentContainerOpts {
  agentId: string;
  hostConfigPath: string;
  cpus: string;
  memLimit: string;
  pidsLimit: number;
  env?: string[];
}

export async function createAndStartContainer(opts: CreateAgentContainerOpts): Promise<string> {
  const containerName = `${CONTAINER_PREFIX}${opts.agentId}`;
  assertAgentboxName(containerName);

  // Environment guard
  const hostPath = process.env.AGENTBOX_CONFIG_HOST_PATH;
  if (!hostPath) {
    throw new Error('AGENTBOX_CONFIG_HOST_PATH not set — refusing to create agent container');
  }

  // Collision check: remove existing container with same name
  try {
    const existing = docker.getContainer(containerName);
    const info = await existing.inspect();
    console.log(`[docker] Collision: container ${containerName} already exists (status: ${info.State.Status}), removing`);
    try { await existing.stop(); } catch { /* may already be stopped */ }
    await existing.remove({ force: true });
  } catch (err: any) {
    if (err.statusCode !== 404) throw err;
  }

  const configMount = `${hostPath}/${opts.agentId}`;
  const nanoCpus = Math.round(parseFloat(opts.cpus) * 1e9);
  const memoryBytes = parseMemLimit(opts.memLimit);

  const container = await docker.createContainer({
    Image: 'hill90/agentbox:latest',
    name: containerName,
    Env: [
      `AGENT_ID=${opts.agentId}`,
      `AGENT_CONFIG=/etc/agentbox/agent.yml`,
      ...(opts.env || []),
    ],
    Labels: {
      [MANAGED_LABEL]: MANAGED_VALUE,
      'traefik.enable': 'false',
    },
    HostConfig: {
      Binds: [
        `${configMount}:/etc/agentbox:ro`,
      ],
      Mounts: VOLUME_SUFFIXES.map(suffix => ({
        Type: 'volume' as const,
        Source: `${CONTAINER_PREFIX}${opts.agentId}-${suffix}`,
        Target: suffix === 'workspace' ? '/workspace'
          : suffix === 'logs' ? '/var/log/agentbox'
          : '/data',
        ReadOnly: false,
      })),
      NanoCpus: nanoCpus,
      Memory: memoryBytes,
      PidsLimit: opts.pidsLimit,
      RestartPolicy: { Name: 'unless-stopped' },
      NetworkMode: AGENT_NETWORK,
    },
  });

  await container.start();
  const info = await container.inspect();
  return info.Id;
}

export async function stopAndRemoveContainer(agentId: string): Promise<void> {
  const containerName = `${CONTAINER_PREFIX}${agentId}`;
  assertAgentboxName(containerName);

  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  assertManagedLabel(info.Config.Labels);

  try { await container.stop(); } catch { /* may already be stopped */ }
  await container.remove({ force: true });
}

export async function inspectContainer(agentId: string): Promise<{
  status: string;
  containerId: string;
  health?: string;
} | null> {
  const containerName = `${CONTAINER_PREFIX}${agentId}`;
  assertAgentboxName(containerName);

  try {
    const container = docker.getContainer(containerName);
    const info = await container.inspect();
    assertManagedLabel(info.Config.Labels);

    return {
      status: info.State.Status,
      containerId: info.Id,
      health: info.State.Health?.Status,
    };
  } catch (err: any) {
    if (err.statusCode === 404) return null;
    throw err;
  }
}

export async function getContainerLogs(
  agentId: string,
  opts: { tail?: number; follow?: boolean } = {}
): Promise<NodeJS.ReadableStream> {
  const containerName = `${CONTAINER_PREFIX}${agentId}`;
  assertAgentboxName(containerName);

  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  assertManagedLabel(info.Config.Labels);

  if (opts.follow) {
    return container.logs({
      stdout: true,
      stderr: true,
      tail: opts.tail ?? 200,
      follow: true,
      timestamps: true,
    });
  }

  const buf = await container.logs({
    stdout: true,
    stderr: true,
    tail: opts.tail ?? 200,
    timestamps: true,
  });

  // Buffer case: wrap in a readable stream
  const { Readable } = require('stream');
  const stream = new Readable();
  stream.push(buf);
  stream.push(null);
  return stream;
}

export async function execInContainer(
  agentId: string,
  cmd: string[],
): Promise<NodeJS.ReadableStream> {
  const containerName = `${CONTAINER_PREFIX}${agentId}`;
  assertAgentboxName(containerName);

  const container = docker.getContainer(containerName);
  const info = await container.inspect();
  assertManagedLabel(info.Config.Labels);

  // Tty: true allocates a pseudo-TTY, giving plain UTF-8 text output
  // without Docker's multiplexed stream framing (8-byte headers per frame).
  // This is appropriate for read-only text commands like `tail`.
  const exec = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: false,
    Tty: true,
  });

  const stream = await exec.start({ hijack: true, stdin: false });
  return stream;
}

export async function removeAgentVolumes(agentId: string): Promise<void> {
  for (const suffix of VOLUME_SUFFIXES) {
    const volumeName = `${CONTAINER_PREFIX}${agentId}-${suffix}`;
    assertAgentboxVolume(volumeName, agentId);
    try {
      const volume = docker.getVolume(volumeName);
      await volume.remove();
      console.log(`[docker] Removed volume ${volumeName}`);
    } catch (err: any) {
      if (err.statusCode !== 404) throw err;
    }
  }
}

export async function reconcileAgentStatuses(
  getRunningAgents: () => Promise<Array<{ id: string; agent_id: string }>>,
  updateStatus: (id: string, status: string, containerId: string | null, error: string | null) => Promise<void>
): Promise<void> {
  const agents = await getRunningAgents();
  for (const agent of agents) {
    const state = await inspectContainer(agent.agent_id);
    if (!state || state.status !== 'running') {
      console.log(`[reconcile] Agent ${agent.agent_id} marked running but container is ${state?.status || 'missing'}`);
      await updateStatus(agent.id, 'stopped', null, state ? `Container ${state.status}` : 'Container not found');
    }
  }
}

function parseMemLimit(limit: string): number {
  const match = limit.match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i);
  if (!match) throw new Error(`Invalid mem_limit: ${limit}`);
  const value = parseFloat(match[1]);
  const unit = (match[2] || '').toLowerCase();
  switch (unit) {
    case 'k': return value * 1024;
    case 'm': return value * 1024 * 1024;
    case 'g': return value * 1024 * 1024 * 1024;
    default: return value;
  }
}
