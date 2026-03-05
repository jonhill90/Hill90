import { getPool } from '../db/pool';
import { execInContainerWithExit } from './docker';

type InstallMethod = 'builtin' | 'apt' | 'binary';

interface ToolRow {
  id: string;
  name: string;
  install_method: InstallMethod;
  install_ref: string;
}

const DEFAULT_BINARY_VERSIONS: Record<string, string> = {
  gh: process.env.HILL90_GH_VERSION || '2.74.2',
  docker: process.env.HILL90_DOCKER_CLI_VERSION || '28.0.1',
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function upsertInstallStatus(
  agentDbId: string,
  toolId: string,
  status: 'pending' | 'installed' | 'failed',
  installMessage: string,
  setInstalledAt = false
): Promise<void> {
  await getPool().query(
    `INSERT INTO agent_tool_installs (agent_id, tool_id, status, install_message, installed_at, updated_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN NOW() ELSE NULL END, NOW())
     ON CONFLICT (agent_id, tool_id)
     DO UPDATE SET
       status = EXCLUDED.status,
       install_message = EXCLUDED.install_message,
       installed_at = CASE
         WHEN EXCLUDED.status = 'installed' THEN NOW()
         ELSE agent_tool_installs.installed_at
       END,
       updated_at = NOW()`,
    [agentDbId, toolId, status, installMessage, setInstalledAt]
  );
}

async function installBuiltin(agentSlug: string, tool: ToolRow): Promise<void> {
  const cmd = ['bash', '-lc', `command -v ${tool.name}`];
  const result = await execInContainerWithExit(agentSlug, cmd);
  if (result.exitCode !== 0) {
    throw new Error(`Builtin tool "${tool.name}" not found in container PATH`);
  }
}

async function installApt(agentSlug: string, tool: ToolRow): Promise<void> {
  const pkg = tool.install_ref?.trim() || tool.name;
  const cmd = [
    'bash',
    '-lc',
    `command -v ${tool.name} >/dev/null 2>&1 || (apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${shellQuote(pkg)})`,
  ];
  const result = await execInContainerWithExit(agentSlug, cmd);
  if (result.exitCode !== 0) {
    throw new Error(`APT install failed for "${tool.name}": ${result.stderr || result.stdout}`.trim());
  }
  await installBuiltin(agentSlug, tool);
}

function binaryInstallScript(tool: ToolRow): string {
  const version = DEFAULT_BINARY_VERSIONS[tool.name];
  if (!version) {
    throw new Error(`Binary install is not supported for tool "${tool.name}"`);
  }
  const url = tool.install_ref.replaceAll('{version}', version);
  if (tool.name === 'gh') {
    return `
set -euo pipefail
mkdir -p /data/tools/bin /tmp/hill90-tools
if [ -x /data/tools/bin/gh ]; then exit 0; fi
curl -fsSL ${shellQuote(url)} -o /tmp/hill90-tools/gh.tgz
tar -xzf /tmp/hill90-tools/gh.tgz -C /tmp/hill90-tools
cp /tmp/hill90-tools/gh_${version}_linux_amd64/bin/gh /data/tools/bin/gh
chmod +x /data/tools/bin/gh
`;
  }
  if (tool.name === 'docker') {
    return `
set -euo pipefail
mkdir -p /data/tools/bin /tmp/hill90-tools
if [ -x /data/tools/bin/docker ]; then exit 0; fi
curl -fsSL ${shellQuote(url)} -o /tmp/hill90-tools/docker.tgz
tar -xzf /tmp/hill90-tools/docker.tgz -C /tmp/hill90-tools
cp /tmp/hill90-tools/docker/docker /data/tools/bin/docker
chmod +x /data/tools/bin/docker
`;
  }
  throw new Error(`No binary install script available for "${tool.name}"`);
}

async function installBinary(agentSlug: string, tool: ToolRow): Promise<void> {
  const script = binaryInstallScript(tool);
  const result = await execInContainerWithExit(agentSlug, ['bash', '-lc', script]);
  if (result.exitCode !== 0) {
    throw new Error(`Binary install failed for "${tool.name}": ${result.stderr || result.stdout}`.trim());
  }
}

async function installTool(agentSlug: string, tool: ToolRow): Promise<void> {
  if (tool.install_method === 'builtin') return installBuiltin(agentSlug, tool);
  if (tool.install_method === 'apt') return installApt(agentSlug, tool);
  return installBinary(agentSlug, tool);
}

export async function ensureRequiredToolsInstalled(agentDbId: string, agentSlug: string): Promise<void> {
  const { rows } = await getPool().query(
    `SELECT DISTINCT t.id, t.name, t.install_method, t.install_ref
     FROM agent_skills asks
     JOIN skill_tools st ON st.skill_id = asks.skill_id
     JOIN tools t ON t.id = st.tool_id
     WHERE asks.agent_id = $1
     ORDER BY t.name ASC`,
    [agentDbId]
  );

  for (const row of rows as ToolRow[]) {
    await upsertInstallStatus(agentDbId, row.id, 'pending', 'installing');
    try {
      await installTool(agentSlug, row);
      await upsertInstallStatus(agentDbId, row.id, 'installed', 'installed', true);
    } catch (err: any) {
      const msg = err?.message || 'installation failed';
      await upsertInstallStatus(agentDbId, row.id, 'failed', msg);
      throw new Error(`Failed installing required tool "${row.name}": ${msg}`);
    }
  }
}

