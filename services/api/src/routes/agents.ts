import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { scopeToOwner } from '../helpers/scope';
import { writeAgentFiles, removeAgentFiles } from '../services/agent-files';
import { mergeToolsConfigs, DEFAULT_TOOLS_CONFIG } from '../services/merge-tools-config';
import { ensureRequiredToolsInstalled, reconcileToolInstalls } from '../services/tool-installer';
import {
  createAndStartContainer,
  stopAndRemoveContainer,
  inspectContainer,
  getContainerLogs,
  execInContainer,
  removeAgentVolumes,
} from '../services/docker';
import {
  generateAgentAkmToken,
  getAkmEnvVars,
  isAkmConfigured,
} from '../services/akm-token';
import { revokeAgentAkmToken } from '../services/akm-revoke';
import {
  generateAgentModelRouterToken,
  getModelRouterEnvVars,
  isModelRouterConfigured,
} from '../services/model-router-token';
import { revokeAgentModelRouterToken } from '../services/model-router-revoke';

const router = Router();

function auditLog(action: string, agentId: string, userSub: string, extra?: Record<string, unknown>) {
  console.log(JSON.stringify({
    type: 'audit',
    action,
    agent_id: agentId,
    user_sub: userSub,
    timestamp: new Date().toISOString(),
    ...extra,
  }));
}

function dbHealthCheck(_req: Request, res: Response, next: () => void) {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }
  next();
}

router.use(dbHealthCheck);

function isAutoAgentModelsPolicy(description: string | null): boolean {
  return (description || '').startsWith('[auto-agent-models]');
}

async function validateModelNames(modelNames: string[], userSub: string, admin: boolean): Promise<string | null> {
  if (admin) return null;
  for (const modelName of modelNames) {
    const { rows: userRows } = await getPool().query(
      `SELECT id FROM user_models WHERE name = $1 AND created_by = $2`,
      [modelName, userSub]
    );
    if (userRows.length > 0) continue;

    const { rows: platformRows } = await getPool().query(
      `SELECT name FROM model_catalog WHERE name = $1 AND is_active = true`,
      [modelName]
    );
    if (platformRows.length > 0) continue;

    return `Model '${modelName}' not found`;
  }
  return null;
}

async function upsertAutoAgentModelsPolicy(
  agentDbId: string,
  agentSlug: string,
  ownerSub: string,
  updatedBy: string,
  modelNames: string[]
): Promise<string> {
  const name = `agent-models-${agentDbId}`;
  const description = `[auto-agent-models] ${agentSlug}`;
  const existing = await getPool().query(
    `SELECT id FROM model_policies WHERE name = $1 AND created_by = $2`,
    [name, ownerSub]
  );
  if (existing.rows.length > 0) {
    await getPool().query(
      `UPDATE model_policies
       SET description = $1,
           allowed_models = $2,
           model_aliases = $3,
           updated_by = $4,
           updated_at = NOW()
       WHERE id = $5`,
      [description, JSON.stringify(modelNames), JSON.stringify({}), updatedBy, existing.rows[0].id]
    );
    return existing.rows[0].id;
  }

  const inserted = await getPool().query(
    `INSERT INTO model_policies (name, description, allowed_models, model_aliases, updated_by, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [name, description, JSON.stringify(modelNames), JSON.stringify({}), updatedBy, ownerSub]
  );
  return inserted.rows[0].id;
}

async function resolveAgentModels(policyId: string | null): Promise<string[]> {
  if (!policyId) return [];
  const { rows } = await getPool().query(
    `SELECT allowed_models FROM model_policies WHERE id = $1`,
    [policyId]
  );
  return rows[0]?.allowed_models || [];
}

// ---------------------------------------------------------------------------
// CRUD (user role)
// ---------------------------------------------------------------------------

// List agents
router.get('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const { rows } = await getPool().query(
      `SELECT a.id, a.agent_id, a.name, a.description, a.status, a.tools_config,
              a.cpus, a.mem_limit, a.pids_limit, a.model_policy_id,
              COALESCE(mp.allowed_models, '[]'::jsonb) AS models,
              a.created_at, a.updated_at, a.created_by,
              COALESCE(
                json_agg(json_build_object('id', s.id, 'name', s.name, 'scope', s.scope))
                FILTER (WHERE s.id IS NOT NULL), '[]'
              ) AS skills
       FROM agents a
       LEFT JOIN model_policies mp ON mp.id = a.model_policy_id
       LEFT JOIN agent_skills asks ON asks.agent_id = a.id
       LEFT JOIN skills s ON s.id = asks.skill_id
       WHERE ${scope.where.replace(/created_by/g, 'a.created_by')}
       GROUP BY a.id, mp.allowed_models
       ORDER BY a.created_at DESC`,
      scope.params
    );
    res.json(rows);
  } catch (err) {
    console.error('[agents] List error:', err);
    res.status(500).json({ error: 'Failed to list agents' });
  }
});

// Create agent
router.post('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { agent_id, name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, model_policy_id, model_names, skill_ids } = req.body;

    // Reject legacy field
    if (req.body.tool_preset_id !== undefined) {
      res.status(400).json({ error: 'tool_preset_id is deprecated. Use skill_ids instead.' });
      return;
    }

    if (!agent_id || !name) {
      res.status(400).json({ error: 'agent_id and name are required' });
      return;
    }

    // Validate agent_id format (slug: lowercase, alphanumeric, hyphens)
    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(agent_id) && !/^[a-z0-9]$/.test(agent_id)) {
      res.status(400).json({ error: 'agent_id must be a lowercase slug (a-z, 0-9, hyphens, 1-63 chars)' });
      return;
    }

    // Validate skill_ids
    if (skill_ids !== undefined) {
      if (!Array.isArray(skill_ids)) {
        res.status(400).json({ error: 'skill_ids must be an array' });
        return;
      }
    }
    if (model_names !== undefined && !Array.isArray(model_names)) {
      res.status(400).json({ error: 'model_names must be an array' });
      return;
    }
    if (model_names !== undefined && model_policy_id !== undefined) {
      res.status(400).json({ error: 'Use either model_names or model_policy_id, not both' });
      return;
    }

    // Validate model_policy_id ownership (legacy/internal path)
    let validatedPolicyId: string | null = null;
    if (model_policy_id) {
      const { rows: policyRows } = await getPool().query(
        'SELECT id, created_by FROM model_policies WHERE id = $1',
        [model_policy_id]
      );
      if (policyRows.length === 0) {
        res.status(400).json({ error: 'Model policy not found' });
        return;
      }
      const roles: string[] = user.realm_roles || [];
      const admin = roles.includes('admin');
      if (!admin) {
        const policyOwner = policyRows[0].created_by;
        if (policyOwner !== null && policyOwner !== user.sub) {
          res.status(403).json({ error: "Cannot assign another user's policy" });
          return;
        }
      }
      validatedPolicyId = model_policy_id;
    }

    // Direct model assignment (preferred user-facing path)
    let normalizedModelNames: string[] | undefined = undefined;
    if (model_names !== undefined) {
      normalizedModelNames = [...new Set((model_names as string[]).filter(Boolean))];
      const roles: string[] = user.realm_roles || [];
      const admin = roles.includes('admin');
      const modelError = await validateModelNames(normalizedModelNames, user.sub, admin);
      if (modelError) {
        res.status(400).json({ error: modelError });
        return;
      }
      // Policy id is derived after insert via auto policy upsert.
      validatedPolicyId = null;
    }

    // Resolve tools_config from explicit payload or assigned skills
    let resolvedToolsConfig = tools_config || DEFAULT_TOOLS_CONFIG;
    let validatedSkillIds: string[] = [];
    if (skill_ids && skill_ids.length > 0) {
      const { rows: skillRows } = await getPool().query(
        'SELECT id, tools_config, scope FROM skills WHERE id = ANY($1::uuid[])',
        [skill_ids]
      );
      if (skillRows.length !== skill_ids.length) {
        res.status(400).json({ error: 'One or more skills not found' });
        return;
      }
      if (skillRows.some((s: any) => ELEVATED_SCOPES.includes(s.scope)) && !isAdmin(req)) {
        const elevatedScope = skillRows.find((s: any) => ELEVATED_SCOPES.includes(s.scope))!.scope;
        res.status(403).json({ error: `Assigning ${elevatedScope} skills requires admin role` });
        return;
      }
      const configs = skillRows.map((r: any) => r.tools_config);
      resolvedToolsConfig = mergeToolsConfigs(configs);
      validatedSkillIds = skill_ids;
    }

    const { rows } = await getPool().query(
      `INSERT INTO agents (agent_id, name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, model_policy_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, agent_id, name, description, status, tools_config,
                 cpus, mem_limit, pids_limit, soul_md, rules_md, container_id,
                 model_policy_id, error_message, created_at, updated_at, created_by`,
      [
        agent_id,
        name,
        description || '',
        JSON.stringify(resolvedToolsConfig),
        cpus || '1.0',
        mem_limit || '1g',
        pids_limit || 200,
        soul_md || '',
        rules_md || '',
        validatedPolicyId,
        user.sub,
      ]
    );

    const createdAgent = rows[0];

    if (normalizedModelNames !== undefined) {
      if (normalizedModelNames.length > 0) {
        const autoPolicyId = await upsertAutoAgentModelsPolicy(
          createdAgent.id,
          createdAgent.agent_id,
          user.sub,
          user.sub,
          normalizedModelNames
        );
        await getPool().query(
          `UPDATE agents SET model_policy_id = $1, updated_at = NOW() WHERE id = $2`,
          [autoPolicyId, createdAgent.id]
        );
        createdAgent.model_policy_id = autoPolicyId;
        createdAgent.models = normalizedModelNames;
      } else {
        createdAgent.models = [];
      }
    } else {
      createdAgent.models = await resolveAgentModels(createdAgent.model_policy_id);
    }

    // Insert skill assignments into agent_skills
    for (const skillId of validatedSkillIds) {
      await getPool().query(
        'INSERT INTO agent_skills (agent_id, skill_id, assigned_by) VALUES ($1, $2, $3)',
        [createdAgent.id, skillId, user.sub]
      );
    }

    // Fetch the skills array for response
    const { rows: skillRows2 } = await getPool().query(
      `SELECT s.id, s.name, s.scope FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [createdAgent.id]
    );
    createdAgent.skills = skillRows2;

    res.status(201).json(createdAgent);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'An agent with this agent_id already exists' });
      return;
    }
    console.error('[agents] Create error:', err);
    res.status(500).json({ error: 'Failed to create agent' });
  }
});

// Get agent detail
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT a.id, a.agent_id, a.name, a.description, a.status, a.tools_config,
              cpus, mem_limit, pids_limit, soul_md, rules_md, container_id,
              model_policy_id, COALESCE(mp.allowed_models, '[]'::jsonb) AS models,
              error_message, a.created_at, a.updated_at, a.created_by
       FROM agents a
       LEFT JOIN model_policies mp ON mp.id = a.model_policy_id
       WHERE a.id = $${paramOffset} AND ${scope.where.replace(/created_by/g, 'a.created_by')}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];

    // Fetch skills for this agent
    const { rows: skillRows } = await getPool().query(
      `SELECT s.id, s.name, s.scope FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [agent.id]
    );
    agent.skills = skillRows;

    res.json(agent);
  } catch (err) {
    console.error('[agents] Get error:', err);
    res.status(500).json({ error: 'Failed to get agent' });
  }
});

// Update agent
router.put('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;

    // Reject legacy field
    if (req.body.tool_preset_id !== undefined) {
      res.status(400).json({ error: 'tool_preset_id is deprecated. Use skill_ids instead.' });
      return;
    }

    // Check agent exists and is owned
    const { rows: existing } = await getPool().query(
      `SELECT * FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    if (existing[0].status === 'running') {
      res.status(409).json({ error: 'Cannot update a running agent. Stop it first.' });
      return;
    }

    const user = (req as any).user;
    const { name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, model_policy_id, model_names, skill_ids } = req.body;

    // Validate skill_ids
    if (skill_ids !== undefined) {
      if (!Array.isArray(skill_ids)) {
        res.status(400).json({ error: 'skill_ids must be an array' });
        return;
      }
    }
    if (model_names !== undefined && !Array.isArray(model_names)) {
      res.status(400).json({ error: 'model_names must be an array' });
      return;
    }
    if (model_names !== undefined && model_policy_id !== undefined) {
      res.status(400).json({ error: 'Use either model_names or model_policy_id, not both' });
      return;
    }

    // model_policy_id assignment: admins can assign any, users can assign own or platform
    if (model_policy_id !== undefined) {
      const roles: string[] = user.realm_roles || [];
      const admin = roles.includes('admin');

      // Validate FK if non-null
      if (model_policy_id !== null) {
        const { rows: policyRows } = await getPool().query(
          'SELECT id, created_by FROM model_policies WHERE id = $1',
          [model_policy_id]
        );
        if (policyRows.length === 0) {
          res.status(400).json({ error: 'Model policy not found' });
          return;
        }

        // Non-admin users can only assign their own policies or platform policies
        if (!admin) {
          const policyOwner = policyRows[0].created_by;
          if (policyOwner !== null && policyOwner !== user.sub) {
            res.status(403).json({ error: "Cannot assign another user's policy" });
            return;
          }
        }
      }
    }

    const userRoles: string[] = user.realm_roles || [];
    const admin = userRoles.includes('admin');
    let resolvedModelPolicyId: string | null | undefined = undefined;
    if (model_names !== undefined) {
      const normalizedModelNames = [...new Set((model_names as string[]).filter(Boolean))];
      const modelError = await validateModelNames(normalizedModelNames, existing[0].created_by, admin);
      if (modelError) {
        res.status(400).json({ error: modelError });
        return;
      }

      if (normalizedModelNames.length === 0) {
        resolvedModelPolicyId = null;
      } else {
        let reusePolicyId: string | null = null;
        if (existing[0].model_policy_id) {
          const { rows: policyRows } = await getPool().query(
            `SELECT id, description FROM model_policies WHERE id = $1`,
            [existing[0].model_policy_id]
          );
          if (policyRows.length > 0 && isAutoAgentModelsPolicy(policyRows[0].description)) {
            reusePolicyId = policyRows[0].id;
          }
        }

        if (reusePolicyId) {
          await getPool().query(
            `UPDATE model_policies
             SET allowed_models = $1, model_aliases = $2, updated_by = $3, updated_at = NOW()
             WHERE id = $4`,
            [JSON.stringify(normalizedModelNames), JSON.stringify({}), user.sub, reusePolicyId]
          );
          resolvedModelPolicyId = reusePolicyId;
        } else {
          resolvedModelPolicyId = await upsertAutoAgentModelsPolicy(
            existing[0].id,
            existing[0].agent_id,
            existing[0].created_by,
            user.sub,
            normalizedModelNames
          );
        }
      }
    }

    // Resolve tools_config from explicit payload or assigned skills
    let resolvedToolsConfig = tools_config ? JSON.stringify(tools_config) : null;
    if (skill_ids !== undefined) {
      if (skill_ids.length > 0) {
        const { rows: skillRows } = await getPool().query(
          'SELECT id, tools_config, scope FROM skills WHERE id = ANY($1::uuid[])',
          [skill_ids]
        );
        if (skillRows.length !== skill_ids.length) {
          res.status(400).json({ error: 'One or more skills not found' });
          return;
        }
        if (skillRows.some((s: any) => ELEVATED_SCOPES.includes(s.scope)) && !isAdmin(req)) {
          const elevatedScope = skillRows.find((s: any) => ELEVATED_SCOPES.includes(s.scope))!.scope;
          res.status(403).json({ error: `Assigning ${elevatedScope} skills requires admin role` });
          return;
        }
        const configs = skillRows.map((r: any) => r.tools_config);
        resolvedToolsConfig = JSON.stringify(mergeToolsConfigs(configs));
      }

      // Check for implicit elevated-skill removal (non-admin removing elevated skills via PUT)
      if (!isAdmin(req)) {
        const { rows: currentSkills } = await getPool().query(
          `SELECT asks.skill_id, s.scope FROM agent_skills asks
           JOIN skills s ON s.id = asks.skill_id
           WHERE asks.agent_id = $1`,
          [req.params.id]
        );
        const removedIds = currentSkills
          .filter((cs: any) => !skill_ids.includes(cs.skill_id))
          .filter((cs: any) => ELEVATED_SCOPES.includes(cs.scope));
        if (removedIds.length > 0) {
          res.status(403).json({ error: `Cannot remove ${removedIds[0].scope} skills without admin role` });
          return;
        }
      }
    }

    // Build SET clause: model_policy_id uses explicit flag to allow clearing to NULL
    const modelPolicyProvided = model_policy_id !== undefined || model_names !== undefined;
    const effectiveModelPolicyId = model_names !== undefined ? resolvedModelPolicyId : model_policy_id;
    const { rows } = await getPool().query(
      `UPDATE agents SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        tools_config = COALESCE($3, tools_config),
        cpus = COALESCE($4, cpus),
        mem_limit = COALESCE($5, mem_limit),
        pids_limit = COALESCE($6, pids_limit),
        soul_md = COALESCE($7, soul_md),
        rules_md = COALESCE($8, rules_md),
        model_policy_id = CASE WHEN $9::boolean THEN $10::uuid ELSE model_policy_id END,
        updated_at = NOW()
       WHERE id = $11
       RETURNING id, agent_id, name, description, status, tools_config,
                 cpus, mem_limit, pids_limit, soul_md, rules_md, container_id,
                 model_policy_id, error_message, created_at, updated_at, created_by`,
      [
        name || null,
        description ?? null,
        resolvedToolsConfig,
        cpus || null,
        mem_limit || null,
        pids_limit ?? null,
        soul_md ?? null,
        rules_md ?? null,
        modelPolicyProvided,
        modelPolicyProvided ? (effectiveModelPolicyId ?? null) : null,
        req.params.id,
      ]
    );

    const updatedAgent = rows[0];

    // Update agent_skills if skill_ids provided
    if (skill_ids !== undefined) {
      // Clear existing assignments
      await getPool().query('DELETE FROM agent_skills WHERE agent_id = $1', [req.params.id]);
      // Insert new assignments
      for (const skillId of skill_ids) {
        await getPool().query(
          'INSERT INTO agent_skills (agent_id, skill_id, assigned_by) VALUES ($1, $2, $3)',
          [req.params.id, skillId, user.sub]
        );
      }
    }

    // Fetch skills for response
    const { rows: agentSkills } = await getPool().query(
      `SELECT s.id, s.name, s.scope FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [req.params.id]
    );
    updatedAgent.skills = agentSkills;
    updatedAgent.models = await resolveAgentModels(updatedAgent.model_policy_id);

    res.json(updatedAgent);
  } catch (err) {
    console.error('[agents] Update error:', err);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});

// Delete agent (admin only)
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await getPool().query('SELECT * FROM agents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];

    // Stop container if running
    if (agent.status === 'running') {
      try {
        await stopAndRemoveContainer(agent.agent_id);
      } catch (err) {
        console.error(`[agents] Failed to stop container for ${agent.agent_id}:`, err);
      }
    }

    // Purge volumes if requested
    if (req.query.purge === 'true') {
      await removeAgentVolumes(agent.agent_id);
      auditLog('purge_volumes', agent.agent_id, user.sub);
    }

    // Remove config files
    removeAgentFiles(agent.agent_id);

    // Delete from DB
    await getPool().query('DELETE FROM agents WHERE id = $1', [req.params.id]);

    auditLog('delete', agent.agent_id, user.sub);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[agents] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});

// ---------------------------------------------------------------------------
// Lifecycle (admin role)
// ---------------------------------------------------------------------------

// Start agent
router.post('/:id/start', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;

    // Environment guard
    if (!process.env.AGENTBOX_CONFIG_HOST_PATH) {
      res.status(503).json({ error: 'AGENTBOX_CONFIG_HOST_PATH not configured' });
      return;
    }

    const { rows } = await getPool().query('SELECT * FROM agents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];

    // Fetch skill instructions at start time (fresh-at-start, not resolve-on-save)
    // Multi-skill: compose all skill instructions with per-skill headers, ordered by assigned_at
    let skillInstructions: string | undefined;
    const { rows: skillRows } = await getPool().query(
      `SELECT s.name, s.instructions_md FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1
       ORDER BY asks.assigned_at ASC`,
      [agent.id]
    );
    const instructionParts = skillRows
      .filter((r: any) => r.instructions_md)
      .map((r: any) => `## Skill: ${r.name}\n\n${r.instructions_md}`);
    if (instructionParts.length > 0) {
      skillInstructions = instructionParts.join('\n\n---\n\n');
    }

    // Write config files to disk
    writeAgentFiles(agent, skillInstructions);

    // Generate AKM token if configured
    let akmEnv: string[] = [];
    let akmJti: string | null = null;
    let akmExp: number | null = null;
    if (isAkmConfigured()) {
      try {
        const akmToken = await generateAgentAkmToken(agent.agent_id, ['akm:read', 'akm:write'], agent.created_by);
        akmEnv = getAkmEnvVars(akmToken);
        akmJti = akmToken.jti;
        akmExp = akmToken.expiresAt;
      } catch (err) {
        console.error('[agents] AKM token generation failed (continuing without AKM):', err);
      }
    }

    // Generate model-router token if configured
    let modelRouterEnv: string[] = [];
    let modelRouterJti: string | null = null;
    let modelRouterExp: number | null = null;
    if (isModelRouterConfigured()) {
      try {
        const mrToken = await generateAgentModelRouterToken(agent.agent_id);
        modelRouterEnv = getModelRouterEnvVars(mrToken);
        modelRouterJti = mrToken.jti;
        modelRouterExp = mrToken.expiresAt;
      } catch (err) {
        console.error('[agents] Model-router token generation failed (continuing without model-router):', err);
      }
    }

    // Create and start container
    const containerId = await createAndStartContainer({
      agentId: agent.agent_id,
      hostConfigPath: process.env.AGENTBOX_CONFIG_HOST_PATH!,
      cpus: agent.cpus,
      memLimit: agent.mem_limit,
      pidsLimit: agent.pids_limit,
      env: [...akmEnv, ...modelRouterEnv, `WORK_TOKEN=${crypto.randomUUID()}`],
    });

    // Phase 6B: ensure required tools are installed for assigned skills.
    // Installation writes persistent status to agent_tool_installs.
    try {
      await ensureRequiredToolsInstalled(agent.id, agent.agent_id);
    } catch (installErr: any) {
      try {
        await stopAndRemoveContainer(agent.agent_id);
      } catch (cleanupErr) {
        console.error('[agents] Cleanup failed after tool install error:', cleanupErr);
      }
      throw new Error(`Tool installation failed: ${installErr?.message || installErr}`);
    }

    // Store AKM JTI + exp for revocation on stop
    if (akmJti) {
      await getPool().query(
        `UPDATE agents SET akm_jti = $1, akm_exp = $2, updated_at = NOW() WHERE id = $3`,
        [akmJti, akmExp, req.params.id]
      );
    }

    // Store model-router JTI + exp for revocation on stop
    if (modelRouterJti) {
      await getPool().query(
        `UPDATE agents SET model_router_jti = $1, model_router_exp = $2, updated_at = NOW() WHERE id = $3`,
        [modelRouterJti, modelRouterExp, req.params.id]
      );
    }

    // Update DB
    await getPool().query(
      `UPDATE agents SET status = 'running', container_id = $1, error_message = NULL, updated_at = NOW() WHERE id = $2`,
      [containerId, req.params.id]
    );

    auditLog('start', agent.agent_id, user.sub, { container_id: containerId, akm_jti: akmJti, model_router_jti: modelRouterJti });
    res.json({ status: 'running', container_id: containerId });
  } catch (err: any) {
    console.error('[agents] Start error:', err);

    // Update DB with error
    try {
      await getPool().query(
        `UPDATE agents SET status = 'error', error_message = $1, updated_at = NOW() WHERE id = $2`,
        [err.message, req.params.id]
      );
    } catch { /* best effort */ }

    res.status(500).json({ error: 'Failed to start agent', detail: err.message });
  }
});

// Stop agent
router.post('/:id/stop', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await getPool().query('SELECT * FROM agents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];

    // Revoke AKM token first (idempotent ordered sequence: revoke, then stop container)
    if (agent.akm_jti && isAkmConfigured()) {
      try {
        await revokeAgentAkmToken(agent.agent_id, agent.akm_jti, agent.akm_exp ?? undefined);
      } catch (err) {
        console.error(`[agents] AKM token revocation failed for ${agent.agent_id}:`, err);
        // Continue with stop — container removal is more important
      }
    }

    // Revoke model-router token
    if (agent.model_router_jti && isModelRouterConfigured()) {
      try {
        await revokeAgentModelRouterToken(agent.agent_id, agent.model_router_jti, agent.model_router_exp ?? undefined);
      } catch (err) {
        console.error(`[agents] Model-router token revocation failed for ${agent.agent_id}:`, err);
        // Continue with stop — container removal is more important
      }
    }

    await stopAndRemoveContainer(agent.agent_id);

    await getPool().query(
      `UPDATE agents SET status = 'stopped', container_id = NULL, akm_jti = NULL, akm_exp = NULL, model_router_jti = NULL, model_router_exp = NULL, error_message = NULL, updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    auditLog('stop', agent.agent_id, user.sub);
    res.json({ status: 'stopped' });
  } catch (err: any) {
    console.error('[agents] Stop error:', err);
    res.status(500).json({ error: 'Failed to stop agent', detail: err.message });
  }
});

// Get live container status
router.get('/:id/status', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT agent_id, status, container_id, error_message FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];
    let containerStatus = null;

    if (agent.container_id) {
      containerStatus = await inspectContainer(agent.agent_id);
    }

    res.json({
      db_status: agent.status,
      container: containerStatus,
      error_message: agent.error_message,
    });
  } catch (err) {
    console.error('[agents] Status error:', err);
    res.status(500).json({ error: 'Failed to get status' });
  }
});

// Get per-agent tool installation statuses
router.get('/:id/tool-installs', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows: agentRows } = await getPool().query(
      `SELECT id FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const { rows } = await getPool().query(
      `SELECT ati.tool_id, t.name AS tool_name, t.description AS tool_description,
              ati.status, ati.install_message, ati.installed_at, ati.updated_at
       FROM agent_tool_installs ati
       JOIN tools t ON t.id = ati.tool_id
       WHERE ati.agent_id = $1
       ORDER BY t.name ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[agents] Tool install status error:', err);
    res.status(500).json({ error: 'Failed to get tool install status' });
  }
});

// Reconcile tool installations for a running agent
router.post('/:id/reconcile-tools', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { rows } = await getPool().query('SELECT id, agent_id, status FROM agents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];
    if (agent.status !== 'running') {
      res.status(409).json({ error: 'Agent must be running to reconcile tools. Use start instead.' });
      return;
    }

    const result = await reconcileToolInstalls(agent.id, agent.agent_id);
    auditLog('reconcile_tools', agent.agent_id, user.sub, result);
    res.json(result);
  } catch (err: any) {
    console.error('[agents] Reconcile tools error:', err);
    res.status(500).json({ error: 'Failed to reconcile tools', detail: err.message });
  }
});

// ---------------------------------------------------------------------------
// Inference event helpers (model_usage → AgentEvent merge)
// ---------------------------------------------------------------------------

interface InferenceRow {
  id: string;
  agent_id: string;
  model_name: string;
  request_type: string;
  status: string;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: string | null; // Postgres numeric serializes as string
  created_at: Date;
}

function mapInferenceToEvent(row: InferenceRow): Record<string, unknown> {
  const cost = Number(row.cost_usd ?? 0);
  return {
    id: `inference-${row.id}`,
    timestamp: row.created_at.toISOString(),
    type: row.status === 'success' ? 'inference_complete' : `inference_${row.status}`,
    tool: 'inference',
    input_summary: `${row.model_name} (${row.request_type})`,
    output_summary: `${row.input_tokens ?? 0}+${row.output_tokens ?? 0} tokens, $${cost.toFixed(4)}, ${row.latency_ms ?? 0}ms`,
    duration_ms: row.latency_ms ?? null,
    success: row.status === 'success',
    metadata: {
      model_name: row.model_name,
      request_type: row.request_type,
      status: row.status,
      input_tokens: row.input_tokens ?? 0,
      output_tokens: row.output_tokens ?? 0,
      cost_usd: cost,
    },
  };
}

async function getRecentInference(
  agentId: string,
  limit: number,
  userSub: string,
  admin: boolean,
  cursor?: { createdAt: string; id: string },
): Promise<InferenceRow[]> {
  if (cursor) {
    // Incremental: rows after cursor, oldest-first
    const conditions = [`agent_id = $1`, `(created_at, id) > ($2, $3)`];
    const params: unknown[] = [agentId, cursor.createdAt, cursor.id];
    let paramIdx = 4;
    if (!admin) {
      conditions.push(`owner = $${paramIdx++}`);
      params.push(userSub);
    }
    params.push(limit);
    const { rows } = await getPool().query(
      `SELECT id, agent_id, model_name, request_type, status, latency_ms,
              input_tokens, output_tokens, cost_usd, created_at
       FROM model_usage
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at ASC, id ASC
       LIMIT $${paramIdx}`,
      params,
    );
    return rows;
  }

  // Backfill: N most recent rows (newest-first), reversed in caller for chronological emission
  const conditions = [`agent_id = $1`];
  const params: unknown[] = [agentId];
  let paramIdx = 2;
  if (!admin) {
    conditions.push(`owner = $${paramIdx++}`);
    params.push(userSub);
  }
  params.push(limit);
  const { rows } = await getPool().query(
    `SELECT id, agent_id, model_name, request_type, status, latency_ms,
            input_tokens, output_tokens, cost_usd, created_at
     FROM model_usage
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${paramIdx}`,
    params,
  );
  return rows.reverse(); // Oldest first
}

// Get agent events (structured activity timeline)
router.get('/:id/events', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const roles: string[] = user?.realm_roles || [];
    const admin = roles.includes('admin');

    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT agent_id, status FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];
    if (agent.status !== 'running') {
      res.status(409).json({ error: 'Agent is not running. Event history is not available for stopped agents.' });
      return;
    }

    const parsedTail = parseInt(req.query.tail as string);
    const tail = Number.isNaN(parsedTail) ? 100 : Math.max(0, parsedTail);
    const follow = req.query.follow === 'true';

    if (follow) {
      // SSE streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Phase 1: Initial inference backfill
      let cursorCreatedAt = new Date().toISOString();
      let cursorId = '';
      try {
        const backfillRows = await getRecentInference(agent.agent_id, tail, user.sub, admin);
        for (const row of backfillRows) {
          res.write(`data: ${JSON.stringify(mapInferenceToEvent(row))}\n\n`);
        }
        if (backfillRows.length > 0) {
          const last = backfillRows[backfillRows.length - 1];
          cursorCreatedAt = last.created_at.toISOString();
          cursorId = last.id;
        }
      } catch (err) {
        console.error('[agents] SSE inference backfill failed (continuing):', err);
      }

      // Phase 2: tail -f for container events
      try {
        const stream = await execInContainer(agent.agent_id, [
          'tail', '-f', '-n', String(tail), '/var/log/agentbox/events.jsonl',
        ]);

        // Phase 3: inference poll
        const INFERENCE_POLL_MS = 3000;
        const pollInterval = setInterval(async () => {
          if (res.writableEnded || res.destroyed) return;
          try {
            const newRows = await getRecentInference(
              agent.agent_id, 50, user.sub, admin,
              { createdAt: cursorCreatedAt, id: cursorId },
            );
            for (const row of newRows) {
              if (res.writableEnded || res.destroyed) return;
              res.write(`data: ${JSON.stringify(mapInferenceToEvent(row))}\n\n`);
            }
            if (newRows.length > 0) {
              const last = newRows[newRows.length - 1];
              cursorCreatedAt = last.created_at.toISOString();
              cursorId = last.id;
            }
          } catch (err) {
            console.error('[agents] SSE inference poll failed (continuing):', err);
          }
        }, INFERENCE_POLL_MS);

        let buffer = '';
        stream.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // keep incomplete line in buffer
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            // Validate JSON — skip any non-JSON lines (e.g. tail errors)
            try { JSON.parse(trimmed); } catch { continue; }
            res.write(`data: ${trimmed}\n\n`);
          }
        });

        stream.on('end', () => {
          clearInterval(pollInterval);
          if (buffer.trim()) {
            try { JSON.parse(buffer.trim()); res.write(`data: ${buffer.trim()}\n\n`); } catch { /* skip */ }
          }
          res.write('event: end\ndata: stream closed\n\n');
          res.end();
        });

        stream.on('error', (err: Error) => {
          clearInterval(pollInterval);
          res.write(`event: error\ndata: ${err.message}\n\n`);
          res.end();
        });

        req.on('close', () => {
          clearInterval(pollInterval);
          (stream as any).destroy?.();
        });
      } catch (err: any) {
        res.write(`event: error\ndata: ${err.message}\n\n`);
        res.end();
      }
      return;
    }

    // One-shot: return events as JSON array, merged with inference events
    try {
      const stream = await execInContainer(agent.agent_id, [
        'tail', '-n', String(tail), '/var/log/agentbox/events.jsonl',
      ]);

      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', async () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf-8');
          const containerEvents = raw
            .split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0)
            .map(line => {
              try { return JSON.parse(line); } catch { return null; }
            })
            .filter(e => e !== null);

          // Merge inference events from DB
          let inferenceEvents: Record<string, unknown>[] = [];
          try {
            const inferenceRows = await getRecentInference(agent.agent_id, tail, user.sub, admin);
            inferenceEvents = inferenceRows.map(mapInferenceToEvent);
          } catch (err) {
            console.error('[agents] One-shot inference query failed (continuing):', err);
          }

          // Merge and sort by (timestamp, id)
          const merged = [...containerEvents, ...inferenceEvents].sort((a: any, b: any) => {
            const tsCmp = (a.timestamp || '').localeCompare(b.timestamp || '');
            if (tsCmp !== 0) return tsCmp;
            return (a.id || '').localeCompare(b.id || '');
          });

          res.json(merged);
        } catch (err: any) {
          console.error('[agents] One-shot merge failed:', err);
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to merge events', detail: err.message });
          }
        }
      });
      stream.on('error', (err: Error) => {
        res.status(500).json({ error: 'Failed to read events', detail: err.message });
      });
    } catch (err: any) {
      res.status(500).json({ error: 'Failed to read events', detail: err.message });
    }
  } catch (err) {
    console.error('[agents] Events error:', err);
    res.status(500).json({ error: 'Failed to get events' });
  }
});

// Get container logs
router.get('/:id/logs', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query('SELECT agent_id, status FROM agents WHERE id = $1', [req.params.id]);
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];
    const tail = parseInt(req.query.tail as string) || 200;
    const follow = req.query.follow === 'true';

    if (follow) {
      // SSE streaming
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      try {
        const stream = await getContainerLogs(agent.agent_id, { tail, follow: true });

        stream.on('data', (chunk: Buffer) => {
          // Docker stream has 8-byte header per frame; strip it
          const lines = stripDockerHeader(chunk);
          for (const line of lines) {
            res.write(`data: ${line}\n\n`);
          }
        });

        stream.on('end', () => {
          res.write('event: end\ndata: stream closed\n\n');
          res.end();
        });

        stream.on('error', (err: Error) => {
          res.write(`event: error\ndata: ${err.message}\n\n`);
          res.end();
        });

        req.on('close', () => {
          (stream as any).destroy?.();
        });
      } catch (err: any) {
        res.write(`event: error\ndata: ${err.message}\n\n`);
        res.end();
      }
      return;
    }

    // Non-streaming: return log text
    const stream = await getContainerLogs(agent.agent_id, { tail, follow: false });
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const raw = Buffer.concat(chunks);
      const lines = stripDockerHeader(raw);
      res.json({ logs: lines.join('\n') });
    });
    stream.on('error', (err: Error) => {
      res.status(500).json({ error: 'Failed to read logs', detail: err.message });
    });
  } catch (err) {
    console.error('[agents] Logs error:', err);
    res.status(500).json({ error: 'Failed to get logs' });
  }
});

// ---------------------------------------------------------------------------
// Skill assignment (user role, RBAC on scope)
// ---------------------------------------------------------------------------

const ELEVATED_SCOPES = ['host_docker', 'vps_system'];

function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  const roles: string[] = user?.realm_roles || [];
  return roles.includes('admin');
}

// Assign skill to agent
router.post('/:id/skills', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { skill_id } = req.body;

    if (!skill_id) {
      res.status(400).json({ error: 'skill_id is required' });
      return;
    }

    // Check agent exists and user has access
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows: agentRows } = await getPool().query(
      `SELECT id, status FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    if (agentRows[0].status === 'running') {
      res.status(409).json({ error: 'Cannot modify skills on a running agent. Stop it first.' });
      return;
    }

    // Look up skill and check scope-based RBAC
    const { rows: skillRows } = await getPool().query(
      'SELECT id, scope, tools_config FROM skills WHERE id = $1',
      [skill_id]
    );
    if (skillRows.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    const skillScope = skillRows[0].scope;
    if (ELEVATED_SCOPES.includes(skillScope) && !isAdmin(req)) {
      res.status(403).json({ error: `Assigning ${skillScope} skills requires admin role` });
      return;
    }

    // Additive: INSERT only, catch PK violation as 409
    let assignmentRow;
    try {
      const { rows } = await getPool().query(
        `INSERT INTO agent_skills (agent_id, skill_id, assigned_by)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [req.params.id, skill_id, user.sub]
      );
      assignmentRow = rows[0];
    } catch (insertErr: any) {
      if (insertErr.code === '23505') {
        res.status(409).json({ error: 'Skill already assigned to this agent' });
        return;
      }
      throw insertErr;
    }

    // Resolve-on-save: merge tools_config from all skills for this agent
    const { rows: allSkillConfigs } = await getPool().query(
      `SELECT s.tools_config FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [req.params.id]
    );
    const allConfigs = allSkillConfigs.map((r: any) => r.tools_config);
    const mergedConfig = mergeToolsConfigs(allConfigs);
    await getPool().query(
      'UPDATE agents SET tools_config = $1 WHERE id = $2',
      [JSON.stringify(mergedConfig), req.params.id]
    );

    res.status(201).json(assignmentRow);
  } catch (err: any) {
    console.error('[agents] Assign skill error:', err);
    res.status(500).json({ error: 'Failed to assign skill' });
  }
});

// Remove skill from agent
router.delete('/:id/skills/:skillId', requireRole('user'), async (req: Request, res: Response) => {
  try {
    // Check agent exists and user has access
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows: agentRows } = await getPool().query(
      `SELECT id, status FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    if (agentRows[0].status === 'running') {
      res.status(409).json({ error: 'Cannot modify skills on a running agent. Stop it first.' });
      return;
    }

    // Look up skill to check scope-based RBAC
    const { rows: skillRows } = await getPool().query(
      'SELECT id, scope FROM skills WHERE id = $1',
      [req.params.skillId]
    );
    if (skillRows.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    const skillScope = skillRows[0].scope;
    if (ELEVATED_SCOPES.includes(skillScope) && !isAdmin(req)) {
      res.status(403).json({ error: `Removing ${skillScope} skills requires admin role` });
      return;
    }

    const { rowCount } = await getPool().query(
      'DELETE FROM agent_skills WHERE agent_id = $1 AND skill_id = $2',
      [req.params.id, req.params.skillId]
    );

    if (rowCount === 0) {
      res.status(404).json({ error: 'Skill assignment not found' });
      return;
    }

    // Recompute tools_config from remaining skills
    const { rows: remainingConfigs } = await getPool().query(
      `SELECT s.tools_config FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [req.params.id]
    );
    const removeConfigs = remainingConfigs.map((r: any) => r.tools_config);
    const removeMerged = removeConfigs.length > 0
      ? mergeToolsConfigs(removeConfigs)
      : DEFAULT_TOOLS_CONFIG;
    await getPool().query(
      'UPDATE agents SET tools_config = $1 WHERE id = $2',
      [JSON.stringify(removeMerged), req.params.id]
    );

    res.json({ removed: true });
  } catch (err) {
    console.error('[agents] Remove skill error:', err);
    res.status(500).json({ error: 'Failed to remove skill' });
  }
});

function stripDockerHeader(buf: Buffer): string[] {
  const lines: string[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 8 > buf.length) {
      // Remaining data without header
      lines.push(buf.subarray(offset).toString('utf-8').trimEnd());
      break;
    }
    const size = buf.readUInt32BE(offset + 4);
    if (size === 0 || offset + 8 + size > buf.length) {
      lines.push(buf.subarray(offset + 8).toString('utf-8').trimEnd());
      break;
    }
    const line = buf.subarray(offset + 8, offset + 8 + size).toString('utf-8').trimEnd();
    if (line) lines.push(line);
    offset += 8 + size;
  }
  return lines;
}

export default router;
