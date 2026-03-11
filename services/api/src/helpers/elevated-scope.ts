import { Request } from 'express';
import { getPool } from '../db/pool';

/**
 * Elevated scopes that require admin role for interaction.
 * Shared between skill assignment (agents.ts) and chat dispatch (chat.ts).
 */
export const ELEVATED_SCOPES = ['host_docker', 'vps_system'];

export function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  const roles: string[] = user?.realm_roles || [];
  return roles.includes('admin');
}

/**
 * Check if an agent has any elevated-scope skills.
 * Returns the first elevated scope found, or null if none.
 */
export async function getAgentElevatedScope(agentUuid: string): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT s.scope FROM agent_skills asks
     JOIN skills s ON s.id = asks.skill_id
     WHERE asks.agent_id = $1 AND s.scope = ANY($2)
     LIMIT 1`,
    [agentUuid, ELEVATED_SCOPES]
  );
  return rows.length > 0 ? rows[0].scope : null;
}
