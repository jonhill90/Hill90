import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const CONFIG_BASE = process.env.AGENTBOX_CONFIG_LOCAL_PATH || '/data/agentbox';

interface AgentRow {
  agent_id: string;
  name: string;
  description: string;
  tools_config: Record<string, unknown>;
  cpus: string;
  mem_limit: string;
  pids_limit: number;
  soul_md: string;
  rules_md: string;
}

export function writeAgentFiles(agent: AgentRow): string {
  const dir = path.join(CONFIG_BASE, agent.agent_id);
  fs.mkdirSync(dir, { recursive: true });

  // Write agent.yml
  const config = {
    version: 1,
    id: agent.agent_id,
    name: agent.name,
    description: agent.description,
    soul_path: 'SOUL.md',
    rules_path: 'RULES.md',
    tools: agent.tools_config,
    resources: {
      cpus: agent.cpus,
      mem_limit: agent.mem_limit,
      pids_limit: agent.pids_limit,
    },
    state: {
      workspace: '/workspace',
      logs: '/var/log/agentbox',
      data: '/data',
    },
  };
  fs.writeFileSync(path.join(dir, 'agent.yml'), yaml.dump(config), 'utf-8');

  // Write identity files
  fs.writeFileSync(path.join(dir, 'SOUL.md'), agent.soul_md, 'utf-8');
  fs.writeFileSync(path.join(dir, 'RULES.md'), agent.rules_md, 'utf-8');

  return dir;
}

export function removeAgentFiles(agentId: string): void {
  const dir = path.join(CONFIG_BASE, agentId);
  fs.rmSync(dir, { recursive: true, force: true });
}
