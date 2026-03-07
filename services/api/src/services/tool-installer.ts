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

const BINARY_PATH_OVERRIDES: Record<string, (version: string) => string> = {
  gh: (v) => `gh_${v}_linux_amd64/bin/gh`,
  docker: () => `docker/docker`,
};

const INSTALL_TIMEOUTS: Record<InstallMethod, number> = {
  builtin: 30_000,
  apt: 120_000,
  binary: 300_000,
};

const MAX_INSTALL_RETRIES = (() => {
  const parsed = parseInt(process.env.HILL90_TOOL_INSTALL_RETRIES || '1', 10);
  return Number.isNaN(parsed) || parsed < 0 ? 1 : parsed;
})();

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function upsertInstallStatus(
  agentDbId: string,
  toolId: string,
  status: 'pending' | 'installing' | 'installed' | 'failed',
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
  const result = await execInContainerWithExit(agentSlug, cmd, INSTALL_TIMEOUTS.builtin);
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
  const result = await execInContainerWithExit(agentSlug, cmd, INSTALL_TIMEOUTS.apt);
  if (result.exitCode !== 0) {
    throw new Error(`APT install failed for "${tool.name}": ${result.stderr || result.stdout}`.trim());
  }
  await installBuiltin(agentSlug, tool);
}

export function binaryInstallScript(tool: ToolRow): string {
  const version = DEFAULT_BINARY_VERSIONS[tool.name];
  if (!version) {
    throw new Error(
      `No version configured for binary tool "${tool.name}". ` +
      `Set HILL90_${tool.name.toUpperCase()}_VERSION or add to DEFAULT_BINARY_VERSIONS.`
    );
  }
  const url = tool.install_ref.replaceAll('{version}', version);
  const binPath = BINARY_PATH_OVERRIDES[tool.name]
    ? BINARY_PATH_OVERRIDES[tool.name](version)
    : `${tool.name}/${tool.name}`;
  return `
set -euo pipefail
mkdir -p /data/tools/bin /tmp/hill90-tools
if [ -x /data/tools/bin/${shellQuote(tool.name)} ]; then exit 0; fi
curl -fsSL ${shellQuote(url)} -o /tmp/hill90-tools/${shellQuote(tool.name)}.tgz
tar -xzf /tmp/hill90-tools/${shellQuote(tool.name)}.tgz -C /tmp/hill90-tools
cp /tmp/hill90-tools/${binPath} /data/tools/bin/${shellQuote(tool.name)}
chmod +x /data/tools/bin/${shellQuote(tool.name)}
rm -rf /tmp/hill90-tools
`;
}

async function installBinary(agentSlug: string, tool: ToolRow): Promise<void> {
  const script = binaryInstallScript(tool);
  const result = await execInContainerWithExit(agentSlug, ['bash', '-lc', script], INSTALL_TIMEOUTS.binary);
  if (result.exitCode !== 0) {
    throw new Error(`Binary install failed for "${tool.name}": ${result.stderr || result.stdout}`.trim());
  }
}

async function installTool(agentSlug: string, tool: ToolRow): Promise<void> {
  if (tool.install_method === 'builtin') return installBuiltin(agentSlug, tool);
  if (tool.install_method === 'apt') return installApt(agentSlug, tool);
  return installBinary(agentSlug, tool);
}

const REQUIRED_TOOLS_QUERY = `
  SELECT DISTINCT t.id, t.name, t.install_method, t.install_ref
  FROM agent_skills asks
  JOIN skill_tools st ON st.skill_id = asks.skill_id
  JOIN tools t ON t.id = st.tool_id
  WHERE asks.agent_id = $1
  ORDER BY t.name ASC`;

export async function ensureRequiredToolsInstalled(agentDbId: string, agentSlug: string): Promise<void> {
  const { rows } = await getPool().query(REQUIRED_TOOLS_QUERY, [agentDbId]);

  for (const row of rows as ToolRow[]) {
    await upsertInstallStatus(agentDbId, row.id, 'installing', 'starting installation');

    const maxRetries = row.install_method === 'builtin' ? 0 : MAX_INSTALL_RETRIES;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await installTool(agentSlug, row);
        await upsertInstallStatus(agentDbId, row.id, 'installed', 'installed', true);
        lastError = null;
        break;
      } catch (err: any) {
        lastError = err;
        if (attempt < maxRetries) {
          const msg = `attempt ${attempt + 1} failed, retrying: ${err?.message || 'unknown'}`;
          await upsertInstallStatus(agentDbId, row.id, 'installing', msg);
        }
      }
    }

    if (lastError) {
      const msg = lastError.message || 'installation failed';
      await upsertInstallStatus(agentDbId, row.id, 'failed', msg);
      throw new Error(`Failed installing required tool "${row.name}": ${msg}`);
    }
  }
}

export async function reconcileToolInstalls(agentDbId: string, agentSlug: string): Promise<{
  installed: string[];
  alreadyInstalled: string[];
  failed: string[];
}> {
  const { rows: requiredTools } = await getPool().query(REQUIRED_TOOLS_QUERY, [agentDbId]);

  const { rows: existingInstalls } = await getPool().query(
    `SELECT tool_id, status FROM agent_tool_installs WHERE agent_id = $1`,
    [agentDbId]
  );
  const installedSet = new Set(
    existingInstalls
      .filter((r: any) => r.status === 'installed')
      .map((r: any) => r.tool_id)
  );

  const result = { installed: [] as string[], alreadyInstalled: [] as string[], failed: [] as string[] };

  for (const row of requiredTools as ToolRow[]) {
    if (installedSet.has(row.id)) {
      result.alreadyInstalled.push(row.name);
      continue;
    }

    await upsertInstallStatus(agentDbId, row.id, 'installing', 'reconcile: starting installation');

    const maxRetries = row.install_method === 'builtin' ? 0 : MAX_INSTALL_RETRIES;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        await installTool(agentSlug, row);
        await upsertInstallStatus(agentDbId, row.id, 'installed', 'installed', true);
        result.installed.push(row.name);
        lastError = null;
        break;
      } catch (err: any) {
        lastError = err;
        if (attempt < maxRetries) {
          await upsertInstallStatus(agentDbId, row.id, 'installing', `reconcile: attempt ${attempt + 1} failed, retrying`);
        }
      }
    }

    if (lastError) {
      await upsertInstallStatus(agentDbId, row.id, 'failed', lastError.message || 'installation failed');
      result.failed.push(row.name);
    }
  }

  // Clean up stale installs for tools no longer required
  const requiredIds = new Set((requiredTools as ToolRow[]).map(t => t.id));
  for (const existing of existingInstalls as any[]) {
    if (!requiredIds.has(existing.tool_id)) {
      await getPool().query(
        `DELETE FROM agent_tool_installs WHERE agent_id = $1 AND tool_id = $2`,
        [agentDbId, existing.tool_id]
      );
    }
  }

  return result;
}
