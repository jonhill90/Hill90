import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import multer from 'multer';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { scopeToOwner } from '../helpers/scope';
import { ELEVATED_SCOPES, isAdmin, getAgentElevatedScope, getAgentEffectiveScope } from '../helpers/elevated-scope';
import { auditLog } from '../helpers/audit';
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
  resolveAgentNetwork,
} from '../services/docker';
import {
  generateAgentAkmToken,
  getAkmEnvVars,
  isAkmConfigured,
} from '../services/akm-token';
import { revokeAgentAkmToken } from '../services/akm-revoke';
import { dispatchWebhooks } from '../services/webhook-dispatch';
import {
  generateAgentModelRouterToken,
  getModelRouterEnvVars,
  isModelRouterConfigured,
} from '../services/model-router-token';
import { revokeAgentModelRouterToken } from '../services/model-router-revoke';
import { getS3Client } from '../services/s3';
import {
  processAvatar,
  agentAvatarKey,
  uploadAvatar as uploadAvatarToS3,
  deleteAvatar as deleteAvatarFromS3,
  getAvatarStream,
} from '../services/avatar';

const router = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

const ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const AGENT_AVATAR_BUCKET = 'agent-avatars';

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

async function validateModelNames(modelNames: string[], ownerSub: string): Promise<string | null> {
  for (const modelName of modelNames) {
    const { rows: userRows } = await getPool().query(
      `SELECT id FROM user_models WHERE name = $1 AND (created_by = $2 OR created_by IS NULL) AND is_active = true`,
      [modelName, ownerSub]
    );
    if (userRows.length > 0) continue;

    return `Model '${modelName}' not found in user models for agent owner`;
  }
  return null;
}

async function validatePolicyEligibility(
  policyId: string,
  agentOwnerSub: string
): Promise<string | null> {
  const { rows } = await getPool().query(
    `SELECT allowed_models FROM model_policies WHERE id = $1`,
    [policyId]
  );
  if (rows.length === 0) return null;

  const allowedModels: string[] = rows[0].allowed_models || [];
  const inaccessible: string[] = [];
  for (const modelName of allowedModels) {
    const { rows: userRows } = await getPool().query(
      `SELECT id FROM user_models WHERE name = $1 AND (created_by = $2 OR created_by IS NULL) AND is_active = true`,
      [modelName, agentOwnerSub]
    );
    if (userRows.length === 0) {
      inaccessible.push(modelName);
    }
  }
  if (inaccessible.length > 0) {
    return `Policy contains models not accessible to agent owner: ${inaccessible.join(', ')}`;
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
// Templates (static, no DB)
// ---------------------------------------------------------------------------

const AGENT_TEMPLATES = [
  {
    id: 'code-assistant',
    name: 'Code Assistant',
    agent_id: 'code-assistant',
    description: 'General-purpose coding agent. Reads, writes, and refactors code in a sandboxed workspace.',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['node', 'npm', 'npx', 'git', 'python3', 'pip3'], denied_patterns: ['rm -rf /'], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/home/agentuser'], denied_paths: [] },
      health: { enabled: true },
    },
    soul_md: 'You are a skilled software engineer. Write clean, well-tested code. Prefer simple solutions over clever ones.',
    rules_md: 'Always run tests before declaring a task complete. Never commit secrets or credentials.',
    cpus: '1.0',
    mem_limit: '1g',
    pids_limit: 200,
    skill_names: [],
    model_names: [],
  },
  {
    id: 'research-agent',
    name: 'Research Agent',
    agent_id: 'research-agent',
    description: 'Investigates topics, summarises findings, and produces structured reports with citations.',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['curl', 'node', 'python3'], denied_patterns: [], max_timeout: 300 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/home/agentuser'], denied_paths: [] },
      health: { enabled: true },
    },
    soul_md: 'You are a thorough researcher. Gather information from multiple sources, cross-reference claims, and present findings with clear citations.',
    rules_md: 'Always cite sources. Flag uncertain or contradictory information. Prefer primary sources over summaries.',
    cpus: '0.5',
    mem_limit: '512m',
    pids_limit: 100,
    skill_names: [],
    model_names: [],
  },
  {
    id: 'devops-bot',
    name: 'DevOps Bot',
    agent_id: 'devops-bot',
    description: 'Infrastructure automation agent for deployments, monitoring, and incident response.',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['docker', 'git', 'curl', 'ssh', 'scp', 'bash', 'node', 'npm'], denied_patterns: ['rm -rf /'], max_timeout: 600 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/home/agentuser'], denied_paths: [] },
      health: { enabled: true },
    },
    soul_md: 'You are an experienced DevOps engineer. Prioritise reliability, observability, and minimal-downtime changes.',
    rules_md: 'Always verify health checks after deployments. Never bypass branch protections. Use rollback procedures when failures are detected.',
    cpus: '1.0',
    mem_limit: '1g',
    pids_limit: 200,
    skill_names: [],
    model_names: [],
  },
  {
    id: 'data-analyst',
    name: 'Data Analyst',
    agent_id: 'data-analyst',
    description: 'Analyses datasets, produces visualisations, and generates summary statistics.',
    tools_config: {
      shell: { enabled: true, allowed_binaries: ['python3', 'pip3', 'node', 'npm'], denied_patterns: [], max_timeout: 600 },
      filesystem: { enabled: true, read_only: false, allowed_paths: ['/workspace', '/home/agentuser'], denied_paths: [] },
      health: { enabled: true },
    },
    soul_md: 'You are a data analyst. Clean data methodically, choose appropriate visualisations, and explain statistical findings in plain language.',
    rules_md: 'Always validate data quality before analysis. Document assumptions and limitations. Use reproducible methods.',
    cpus: '1.0',
    mem_limit: '2g',
    pids_limit: 200,
    skill_names: [],
    model_names: [],
  },
];

router.get('/templates', requireRole('user'), (_req: Request, res: Response) => {
  res.json(AGENT_TEMPLATES);
});

// ---------------------------------------------------------------------------
// CRUD (user role)
// ---------------------------------------------------------------------------

// List agents
router.get('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const { rows } = await getPool().query(
      `SELECT a.id, a.agent_id, a.name, a.description, a.status, a.tools_config,
              a.cpus, a.mem_limit, a.pids_limit, a.model_policy_id, a.autonomy_level,
              a.avatar_key,
              COALESCE(mp.allowed_models, '[]'::jsonb) AS models,
              a.created_at, a.updated_at, a.created_by,
              a.container_profile_id,
              cp.name AS cp_name, cp.docker_image AS cp_docker_image,
              COALESCE(
                json_agg(json_build_object('id', s.id, 'name', s.name, 'scope', s.scope))
                FILTER (WHERE s.id IS NOT NULL), '[]'
              ) AS skills
       FROM agents a
       LEFT JOIN model_policies mp ON mp.id = a.model_policy_id
       LEFT JOIN container_profiles cp ON cp.id = a.container_profile_id
       LEFT JOIN agent_skills asks ON asks.agent_id = a.id
       LEFT JOIN skills s ON s.id = asks.skill_id
       WHERE ${scope.where.replace(/created_by/g, 'a.created_by')}
       GROUP BY a.id, mp.allowed_models, cp.name, cp.docker_image
       ORDER BY a.created_at DESC`,
      scope.params
    );
    // Attach container_profile object and principal identity fields
    for (const row of rows) {
      // AI-115: Add principal identity fields
      row.principal_id = row.id;
      row.principal_type = row.principal_type || 'agent';

      row.hasAvatar = !!row.avatar_key;
      delete row.avatar_key;

      row.container_profile = row.container_profile_id
        ? { id: row.container_profile_id, name: row.cp_name, docker_image: row.cp_docker_image }
        : null;
      delete row.cp_name;
      delete row.cp_docker_image;
    }
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
    const { agent_id, name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, model_policy_id, model_names, skill_ids, container_profile_id, autonomy_level } = req.body;

    // Validate autonomy_level if provided
    if (autonomy_level !== undefined) {
      const validLevels = ['ask_before_acting', 'act_within_scope', 'full_autonomy'];
      if (!validLevels.includes(autonomy_level)) {
        res.status(400).json({ error: `autonomy_level must be one of: ${validLevels.join(', ')}` });
        return;
      }
    }

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

    // Validate model_policy_id ownership + eligibility
    let validatedPolicyId: string | null = null;
    if (model_policy_id) {
      const { rows: policyRows } = await getPool().query(
        'SELECT id, created_by, allowed_models FROM model_policies WHERE id = $1',
        [model_policy_id]
      );
      if (policyRows.length === 0) {
        res.status(400).json({ error: 'Model policy not found' });
        return;
      }
      const policyOwner = policyRows[0].created_by;
      if (policyOwner !== null && policyOwner !== user.sub) {
        res.status(403).json({ error: "Cannot assign another user's policy" });
        return;
      }
      // AI-120: validate all models in policy are accessible to agent owner
      const eligibilityError = await validatePolicyEligibility(model_policy_id, user.sub);
      if (eligibilityError) {
        res.status(400).json({ error: eligibilityError });
        return;
      }
      validatedPolicyId = model_policy_id;
    }

    // Direct model assignment (preferred user-facing path)
    let normalizedModelNames: string[] | undefined = undefined;
    if (model_names !== undefined) {
      normalizedModelNames = [...new Set((model_names as string[]).filter(Boolean))];
      const modelError = await validateModelNames(normalizedModelNames, user.sub);
      if (modelError) {
        res.status(400).json({ error: modelError });
        return;
      }
      // Policy id is derived after insert via auto policy upsert.
      validatedPolicyId = null;
    }

    // Validate container_profile_id if provided
    if (container_profile_id !== undefined && container_profile_id !== null) {
      const { rows: profileRows } = await getPool().query(
        'SELECT id FROM container_profiles WHERE id = $1',
        [container_profile_id]
      );
      if (profileRows.length === 0) {
        res.status(400).json({ error: 'Container profile not found' });
        return;
      }
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
        auditLog('skill_assign_denied', agent_id, user.sub, 'human', { skill_scope: elevatedScope, endpoint: 'POST /agents' });
        res.status(403).json({ error: `Assigning ${elevatedScope} skills requires admin role` });
        return;
      }
      const configs = skillRows.map((r: any) => r.tools_config);
      resolvedToolsConfig = mergeToolsConfigs(configs);
      validatedSkillIds = skill_ids;
    }

    const { rows } = await getPool().query(
      `INSERT INTO agents (agent_id, name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, model_policy_id, container_profile_id, autonomy_level, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               COALESCE($10::uuid, (SELECT id FROM model_policies WHERE name = 'default' AND created_by IS NULL LIMIT 1)),
               $11, $12, $13)
       RETURNING id, agent_id, name, description, status, tools_config,
                 cpus, mem_limit, pids_limit, soul_md, rules_md, container_id,
                 model_policy_id, container_profile_id, autonomy_level, error_message, created_at, updated_at, created_by`,
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
        container_profile_id || null,
        autonomy_level || 'act_within_scope',
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
              model_policy_id, a.autonomy_level, a.avatar_key, a.container_profile_id,
              cp.name AS cp_name, cp.docker_image AS cp_docker_image,
              COALESCE(mp.allowed_models, '[]'::jsonb) AS models,
              error_message, a.created_at, a.updated_at, a.created_by
       FROM agents a
       LEFT JOIN model_policies mp ON mp.id = a.model_policy_id
       LEFT JOIN container_profiles cp ON cp.id = a.container_profile_id
       WHERE a.id = $${paramOffset} AND ${scope.where.replace(/created_by/g, 'a.created_by')}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const agent = rows[0];
    agent.hasAvatar = !!agent.avatar_key;
    delete agent.avatar_key;

    // AI-115: Add principal identity fields
    agent.principal_id = agent.id;
    agent.principal_type = agent.principal_type || 'agent';

    agent.container_profile = agent.container_profile_id
      ? { id: agent.container_profile_id, name: agent.cp_name, docker_image: agent.cp_docker_image }
      : null;
    delete agent.cp_name;
    delete agent.cp_docker_image;

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

// Export agent config
router.get('/:id/export', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT a.id, a.agent_id, a.name, a.description, a.tools_config,
              a.cpus, a.mem_limit, a.pids_limit, a.soul_md, a.rules_md,
              a.autonomy_level, a.container_profile_id,
              COALESCE(mp.allowed_models, '[]'::jsonb) AS models
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

    const { rows: skillRows } = await getPool().query(
      `SELECT s.name, s.scope FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [agent.id]
    );

    const exportData = {
      _version: 1,
      _exported_at: new Date().toISOString(),
      agent_id: agent.agent_id,
      name: agent.name,
      description: agent.description,
      tools_config: agent.tools_config,
      cpus: agent.cpus,
      mem_limit: agent.mem_limit,
      pids_limit: agent.pids_limit,
      soul_md: agent.soul_md,
      rules_md: agent.rules_md,
      autonomy_level: agent.autonomy_level,
      model_names: agent.models || [],
      skill_names: skillRows.map((s: any) => s.name),
      container_profile_id: agent.container_profile_id,
    };

    res.setHeader('Content-Disposition', `attachment; filename="${agent.agent_id}.json"`);
    res.json(exportData);
  } catch (err) {
    console.error('[agents] Export error:', err);
    res.status(500).json({ error: 'Failed to export agent' });
  }
});

// Import agent from exported config
router.post('/import', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const config = req.body;

    if (!config.agent_id || !config.name) {
      res.status(400).json({ error: 'Exported config must include agent_id and name' });
      return;
    }

    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(config.agent_id) && !/^[a-z0-9]$/.test(config.agent_id)) {
      res.status(400).json({ error: 'agent_id must be a lowercase slug (a-z, 0-9, hyphens, 1-63 chars)' });
      return;
    }

    const validLevels = ['ask_before_acting', 'act_within_scope', 'full_autonomy'];
    const autonomyLevel = config.autonomy_level && validLevels.includes(config.autonomy_level)
      ? config.autonomy_level
      : 'act_within_scope';

    // Resolve skill_ids from skill_names
    let validatedSkillIds: string[] = [];
    let resolvedToolsConfig = config.tools_config || DEFAULT_TOOLS_CONFIG;
    if (config.skill_names && Array.isArray(config.skill_names) && config.skill_names.length > 0) {
      const { rows: skillRows } = await getPool().query(
        'SELECT id, tools_config, scope FROM skills WHERE name = ANY($1::text[])',
        [config.skill_names]
      );
      if (skillRows.some((s: any) => ELEVATED_SCOPES.includes(s.scope)) && !isAdmin(req)) {
        res.status(403).json({ error: 'Importing agents with elevated-scope skills requires admin role' });
        return;
      }
      validatedSkillIds = skillRows.map((r: any) => r.id);
      if (skillRows.length > 0) {
        resolvedToolsConfig = mergeToolsConfigs(skillRows.map((r: any) => r.tools_config));
      }
    }

    // Validate model_names
    const modelNames: string[] = config.model_names && Array.isArray(config.model_names) ? config.model_names : [];
    if (modelNames.length > 0) {
      const modelError = await validateModelNames(modelNames, user.sub);
      if (modelError) {
        res.status(400).json({ error: modelError });
        return;
      }
    }

    // Validate container_profile_id
    let profileId = null;
    if (config.container_profile_id) {
      const { rows: profileRows } = await getPool().query(
        'SELECT id FROM container_profiles WHERE id = $1',
        [config.container_profile_id]
      );
      if (profileRows.length > 0) {
        profileId = config.container_profile_id;
      }
    }

    const { rows } = await getPool().query(
      `INSERT INTO agents (agent_id, name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, model_policy_id, container_profile_id, autonomy_level, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               (SELECT id FROM model_policies WHERE name = 'default' AND created_by IS NULL LIMIT 1),
               $10, $11, $12)
       RETURNING id, agent_id, name, description, status, tools_config,
                 cpus, mem_limit, pids_limit, soul_md, rules_md, container_id,
                 model_policy_id, container_profile_id, autonomy_level, error_message, created_at, updated_at, created_by`,
      [
        config.agent_id,
        config.name,
        config.description || '',
        JSON.stringify(resolvedToolsConfig),
        config.cpus || '1.0',
        config.mem_limit || '1g',
        config.pids_limit || 200,
        config.soul_md || '',
        config.rules_md || '',
        profileId,
        autonomyLevel,
        user.sub,
      ]
    );

    const createdAgent = rows[0];

    if (modelNames.length > 0) {
      const autoPolicyId = await upsertAutoAgentModelsPolicy(
        createdAgent.id,
        createdAgent.agent_id,
        user.sub,
        user.sub,
        modelNames
      );
      await getPool().query(
        `UPDATE agents SET model_policy_id = $1, updated_at = NOW() WHERE id = $2`,
        [autoPolicyId, createdAgent.id]
      );
      createdAgent.model_policy_id = autoPolicyId;
      createdAgent.models = modelNames;
    } else {
      createdAgent.models = await resolveAgentModels(createdAgent.model_policy_id);
    }

    for (const skillId of validatedSkillIds) {
      await getPool().query(
        'INSERT INTO agent_skills (agent_id, skill_id, assigned_by) VALUES ($1, $2, $3)',
        [createdAgent.id, skillId, user.sub]
      );
    }

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
    console.error('[agents] Import error:', err);
    res.status(500).json({ error: 'Failed to import agent' });
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
    const { name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, model_policy_id, model_names, skill_ids, container_profile_id, autonomy_level } = req.body;

    // Validate autonomy_level if provided
    if (autonomy_level !== undefined) {
      const validLevels = ['ask_before_acting', 'act_within_scope', 'full_autonomy'];
      if (!validLevels.includes(autonomy_level)) {
        res.status(400).json({ error: `autonomy_level must be one of: ${validLevels.join(', ')}` });
        return;
      }
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

    // model_policy_id assignment: all callers subject to ownership + eligibility check
    if (model_policy_id !== undefined) {
      // Validate FK if non-null
      if (model_policy_id !== null) {
        const { rows: policyRows } = await getPool().query(
          'SELECT id, created_by, allowed_models FROM model_policies WHERE id = $1',
          [model_policy_id]
        );
        if (policyRows.length === 0) {
          res.status(400).json({ error: 'Model policy not found' });
          return;
        }

        const policyOwner = policyRows[0].created_by;
        if (policyOwner !== null && policyOwner !== user.sub) {
          res.status(403).json({ error: "Cannot assign another user's policy" });
          return;
        }
        // AI-120: validate all models in policy are accessible to agent owner
        const eligibilityError = await validatePolicyEligibility(model_policy_id, existing[0].created_by);
        if (eligibilityError) {
          res.status(400).json({ error: eligibilityError });
          return;
        }
      }
    }

    // Validate container_profile_id if provided (non-null)
    if (container_profile_id !== undefined && container_profile_id !== null) {
      const { rows: cpRows } = await getPool().query(
        'SELECT id FROM container_profiles WHERE id = $1',
        [container_profile_id]
      );
      if (cpRows.length === 0) {
        res.status(400).json({ error: 'Container profile not found' });
        return;
      }
    }

    let resolvedModelPolicyId: string | null | undefined = undefined;
    if (model_names !== undefined) {
      const normalizedModelNames = [...new Set((model_names as string[]).filter(Boolean))];
      const modelError = await validateModelNames(normalizedModelNames, existing[0].created_by);
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
          auditLog('skill_assign_denied', existing[0].agent_id, user.sub, 'human', { skill_scope: elevatedScope, endpoint: 'PUT /agents/:id' });
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
          auditLog('skill_remove_denied', existing[0].agent_id, user.sub, 'human', { skill_scope: removedIds[0].scope, endpoint: 'PUT /agents/:id' });
          res.status(403).json({ error: `Cannot remove ${removedIds[0].scope} skills without admin role` });
          return;
        }
      }
    }

    // Build SET clause: model_policy_id uses explicit flag to allow clearing to NULL
    const modelPolicyProvided = model_policy_id !== undefined || model_names !== undefined;
    const effectiveModelPolicyId = model_names !== undefined ? resolvedModelPolicyId : model_policy_id;
    const containerProfileProvided = container_profile_id !== undefined;
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
        container_profile_id = CASE WHEN $11::boolean THEN $12::uuid ELSE container_profile_id END,
        autonomy_level = COALESCE($13, autonomy_level),
        updated_at = NOW()
       WHERE id = $14
       RETURNING id, agent_id, name, description, status, tools_config,
                 cpus, mem_limit, pids_limit, soul_md, rules_md, container_id,
                 model_policy_id, container_profile_id, autonomy_level, error_message, created_at, updated_at, created_by`,
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
        containerProfileProvided,
        containerProfileProvided ? (container_profile_id ?? null) : null,
        autonomy_level || null,
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
      auditLog('purge_volumes', agent.agent_id, user.sub, 'human');
    }

    // Remove avatar from S3
    if (agent.avatar_key) {
      try {
        await deleteAvatarFromS3(getS3Client(), agent.avatar_key, AGENT_AVATAR_BUCKET);
      } catch (err) {
        console.error('[agents] Failed to delete avatar:', err);
      }
    }

    // Remove config files
    removeAgentFiles(agent.agent_id);

    // Delete from DB
    await getPool().query('DELETE FROM agents WHERE id = $1', [req.params.id]);

    auditLog('delete', agent.agent_id, user.sub, 'human');
    res.json({ deleted: true });
  } catch (err) {
    console.error('[agents] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete agent' });
  }
});


// ---------------------------------------------------------------------------
// Avatar (user role)
// ---------------------------------------------------------------------------

router.post('/:id/avatar', requireRole('user'), avatarUpload.single('avatar'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT id, agent_id, avatar_key FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
    const file = req.file;
    if (!file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    if (!ALLOWED_MIMES.includes(file.mimetype)) { res.status(400).json({ error: 'Invalid file type' }); return; }
    const agent = rows[0];
    const processed = await processAvatar(file.buffer);
    const key = agentAvatarKey(agent.id);
    const s3 = getS3Client();
    const oldKey = agent.avatar_key;
    await uploadAvatarToS3(s3, key, processed, AGENT_AVATAR_BUCKET);
    await getPool().query('UPDATE agents SET avatar_key = $1, updated_at = NOW() WHERE id = $2', [key, agent.id]);
    if (oldKey) { try { await deleteAvatarFromS3(s3, oldKey, AGENT_AVATAR_BUCKET); } catch (e) { console.error('[agents] old avatar delete failed:', e); } }
    res.json({ message: 'Avatar uploaded' });
  } catch (err) { console.error('[agents] POST avatar error:', err); res.status(500).json({ error: 'Failed to upload avatar' }); }
});

router.get('/:id/avatar', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT avatar_key FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
    if (!rows[0].avatar_key) { res.status(404).json({ error: 'No avatar found' }); return; }
    const s3 = getS3Client();
    const { stream, etag } = await getAvatarStream(s3, rows[0].avatar_key, AGENT_AVATAR_BUCKET);
    if (etag && req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, no-cache');
    if (etag) res.setHeader('ETag', etag);
    (stream as any).pipe(res);
  } catch (err: any) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) { res.status(404).json({ error: 'No avatar found' }); return; }
    console.error('[agents] GET avatar error:', err); res.status(500).json({ error: 'Failed to fetch avatar' });
  }
});

router.delete('/:id/avatar', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT id, avatar_key FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Agent not found' }); return; }
    if (!rows[0].avatar_key) { res.status(404).json({ error: 'No avatar found' }); return; }
    const s3 = getS3Client();
    await deleteAvatarFromS3(s3, rows[0].avatar_key, AGENT_AVATAR_BUCKET);
    await getPool().query('UPDATE agents SET avatar_key = NULL, updated_at = NOW() WHERE id = $1', [rows[0].id]);
    res.json({ message: 'Avatar deleted' });
  } catch (err) { console.error('[agents] DELETE avatar error:', err); res.status(500).json({ error: 'Failed to delete avatar' }); }
});

// ---------------------------------------------------------------------------
// Lifecycle (admin role)
// ---------------------------------------------------------------------------

// Start agent
router.post('/:id/start', requireRole('admin'), async (req: Request, res: Response) => {
  let agentSlug = 'unknown';
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
    agentSlug = agent.agent_id;
    const correlationId = (req as any).correlationId;

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

    // AI-115: Owner role ceiling enforcement — re-derive at start time.
    // Placed after skill instructions query to preserve mock call order in tests.
    const elevatedScope = await getAgentElevatedScope(agent.id);
    if (elevatedScope) {
      const ownerRoles: string[] = user.sub === agent.created_by
        ? (user.realm_roles || [])
        : [];
      if (user.sub === agent.created_by && !ownerRoles.includes('admin')) {
        auditLog('principal_ceiling_denied', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id,
          owner_sub: agent.created_by,
          denied_scope: elevatedScope,
          correlation_id: correlationId,
        });
        res.status(403).json({
          error: 'Owner role ceiling exceeded',
          detail: `Agent has elevated scope '${elevatedScope}' but owner lacks admin role`,
        });
        return;
      }
    }

    // Generate AKM token if configured (AI-115: WorkloadClaims)
    let akmEnv: string[] = [];
    let akmJti: string | null = null;
    let akmExp: number | null = null;
    if (isAkmConfigured()) {
      try {
        const akmToken = await generateAgentAkmToken({
          agentSlug: agent.agent_id,
          agentUuid: agent.id,
          scopes: ['akm:read', 'akm:write'],
          owner: agent.created_by,
          correlationId,
        });
        akmEnv = getAkmEnvVars(akmToken);
        akmJti = akmToken.jti;
        akmExp = akmToken.expiresAt;
        auditLog('token_issued', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id, principal_type: 'agent',
          jti: akmToken.jti, owner_sub: agent.created_by,
          scopes: ['akm:read', 'akm:write'], aud: 'hill90-akm',
          correlation_id: correlationId,
        });
      } catch (err) {
        console.error('[agents] AKM token generation failed (continuing without AKM):', err);
      }
    }

    // Generate model-router token if configured (AI-115: WorkloadClaims)
    let modelRouterEnv: string[] = [];
    let modelRouterJti: string | null = null;
    let modelRouterExp: number | null = null;
    let modelRouterRefreshSecret: string | null = null;
    if (isModelRouterConfigured()) {
      try {
        const mrToken = await generateAgentModelRouterToken({
          agentSlug: agent.agent_id,
          agentUuid: agent.id,
          owner: agent.created_by,
          scopes: [],
          correlationId,
        });
        modelRouterEnv = getModelRouterEnvVars(mrToken);
        modelRouterJti = mrToken.jti;
        modelRouterExp = mrToken.expiresAt;
        modelRouterRefreshSecret = mrToken.refreshSecret;
        auditLog('token_issued', agent.agent_id, user.sub, 'human', {
          principal_id: agent.id, principal_type: 'agent',
          jti: mrToken.jti, owner_sub: agent.created_by,
          scopes: [], aud: 'hill90-model-router',
          correlation_id: correlationId,
        });
      } catch (err) {
        console.error('[agents] Model-router token generation failed (continuing without model-router):', err);
      }
    }

    // Generate work token and chat callback env
    const workToken = crypto.randomUUID();
    const chatEnv: string[] = [];
    if (process.env.CHAT_CALLBACK_TOKEN) {
      chatEnv.push(`CHAT_CALLBACK_TOKEN=${process.env.CHAT_CALLBACK_TOKEN}`);
    }

    // Resolve agent scope for network assignment
    const effectiveScope = await getAgentEffectiveScope(agent.id);
    const network = resolveAgentNetwork(effectiveScope);

    // Resolve container profile image + metadata
    let profileImage: string | undefined;
    let profileMetadata: Record<string, any> | undefined;
    if (agent.container_profile_id) {
      const { rows: profileRows } = await getPool().query(
        'SELECT docker_image, metadata FROM container_profiles WHERE id = $1',
        [agent.container_profile_id]
      );
      if (profileRows.length > 0) {
        profileImage = profileRows[0].docker_image;
        const meta = profileRows[0].metadata;
        if (meta && typeof meta === 'object' && Object.keys(meta).length > 0) {
          profileMetadata = meta;
        }
      }
    }

    // Create and start container
    const containerId = await createAndStartContainer({
      agentId: agent.agent_id,
      hostConfigPath: process.env.AGENTBOX_CONFIG_HOST_PATH!,
      cpus: agent.cpus,
      memLimit: agent.mem_limit,
      pidsLimit: agent.pids_limit,
      env: [...akmEnv, ...modelRouterEnv, ...chatEnv, `WORK_TOKEN=${workToken}`, 'AGENT_USE_TERMINAL=1'],
      network,
      image: profileImage,
      metadata: profileMetadata,
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

    // Store model-router JTI + exp + refresh hash for revocation on stop and token refresh
    if (modelRouterJti) {
      const mrRefreshHash = modelRouterRefreshSecret
        ? crypto.createHash('sha256').update(modelRouterRefreshSecret).digest('hex')
        : null;
      await getPool().query(
        `UPDATE agents SET model_router_jti = $1, model_router_exp = $2, model_router_refresh_hash = $3, updated_at = NOW() WHERE id = $4`,
        [modelRouterJti, modelRouterExp, mrRefreshHash, req.params.id]
      );
    }

    // Update DB (store work_token for chat dispatch verification)
    await getPool().query(
      `UPDATE agents SET status = 'running', container_id = $1, work_token = $2, error_message = NULL, updated_at = NOW() WHERE id = $3`,
      [containerId, workToken, req.params.id]
    );

    // Track session for uptime progression
    try {
      await getPool().query(
        `INSERT INTO agent_sessions (agent_id, started_at) VALUES ($1, NOW())`,
        [agent.id]
      );
    } catch (err) {
      console.error(`[agents] Session tracking insert failed for ${agent.agent_id}:`, err);
    }

    auditLog('start', agent.agent_id, user.sub, 'human', {
      principal_id: agent.id, owner_sub: agent.created_by, correlation_id: correlationId,
      container_id: containerId, network, profile_image: profileImage || 'hill90/agentbox:latest',
      akm_jti: akmJti, model_router_jti: modelRouterJti,
    });
    dispatchWebhooks(agent.agent_id, agent.id, 'start', { container_id: containerId });
    res.json({ status: 'running', container_id: containerId, principal_id: agent.id });
  } catch (err: any) {
    console.error('[agents] Start error:', err);

    // Update DB with error
    try {
      await getPool().query(
        `UPDATE agents SET status = 'error', error_message = $1, updated_at = NOW() WHERE id = $2`,
        [err.message, req.params.id]
      );
    } catch { /* best effort */ }

    dispatchWebhooks(agentSlug, req.params.id, 'error', { error: err.message });
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

    // Mark any pending chat messages from this agent as error (stale cleanup).
    // Contract: chat-dispatch uses agent UUID (agents.id) as author_id, not the slug.
    // Bump seq so SSE cursor-based consumers pick up the status transition.
    try {
      const { rowCount } = await getPool().query(
        `UPDATE chat_messages
         SET status = 'error', error_message = 'Agent stopped',
             seq = nextval('chat_messages_seq')
         WHERE author_id = $1 AND author_type = 'agent' AND status = 'pending'`,
        [agent.id]
      );
      if (rowCount && rowCount > 0) {
        console.log(`[agents] Marked ${rowCount} pending chat message(s) as error for ${agent.agent_id}`);
      }
    } catch (err) {
      console.error(`[agents] Stale chat message cleanup failed for ${agent.agent_id}:`, err);
      // Continue with stop — clearing agent state is more important
    }

    // Close open session for uptime tracking
    try {
      await getPool().query(
        `UPDATE agent_sessions SET stopped_at = NOW()
         WHERE agent_id = $1 AND stopped_at IS NULL`,
        [agent.id]
      );
    } catch (err) {
      console.error(`[agents] Session tracking update failed for ${agent.agent_id}:`, err);
    }

    await getPool().query(
      `UPDATE agents SET status = 'stopped', container_id = NULL, work_token = NULL, akm_jti = NULL, akm_exp = NULL, model_router_jti = NULL, model_router_exp = NULL, model_router_refresh_hash = NULL, error_message = NULL, updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    const stopCorrelationId = (req as any).correlationId;
    // AI-115: token_revoked audit events
    if (agent.akm_jti) {
      auditLog('token_revoked', agent.agent_id, user.sub, 'human', {
        principal_id: agent.id, jti: agent.akm_jti, reason: 'stop',
        owner_sub: agent.created_by, correlation_id: stopCorrelationId,
      });
    }
    if (agent.model_router_jti) {
      auditLog('token_revoked', agent.agent_id, user.sub, 'human', {
        principal_id: agent.id, jti: agent.model_router_jti, reason: 'stop',
        owner_sub: agent.created_by, correlation_id: stopCorrelationId,
      });
    }
    auditLog('stop', agent.agent_id, user.sub, 'human', {
      principal_id: agent.id, owner_sub: agent.created_by, correlation_id: stopCorrelationId,
    });
    dispatchWebhooks(agent.agent_id, agent.id, 'stop', {});
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
    auditLog('reconcile_tools', agent.agent_id, user.sub, 'human', result);
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
  requested_model: string | null;
  provider_model_id: string | null;
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
      requested_model: row.requested_model,
      provider_model_id: row.provider_model_id,
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
              input_tokens, output_tokens, cost_usd,
              requested_model, provider_model_id, created_at
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
            input_tokens, output_tokens, cost_usd,
            requested_model, provider_model_id, created_at
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
      auditLog('skill_assign_denied', req.params.id, user.sub, 'human', { skill_id, skill_scope: skillScope, endpoint: 'POST /agents/:id/skills' });
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

    auditLog('skill_assign', req.params.id, user.sub, 'human', { skill_id, skill_scope: skillScope, endpoint: 'POST /agents/:id/skills' });
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
      const user = (req as any).user;
      auditLog('skill_remove_denied', req.params.id, user.sub, 'human', { skill_id: req.params.skillId, skill_scope: skillScope, endpoint: 'DELETE /agents/:id/skills/:skillId' });
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

    const user = (req as any).user;
    auditLog('skill_remove', req.params.id, user.sub, 'human', { skill_id: req.params.skillId, skill_scope: skillScope, endpoint: 'DELETE /agents/:id/skills/:skillId' });
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

// Agent progression — stats (computed from existing data)
router.get('/:id/stats', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT * FROM agents WHERE id = $${paramOffset}${scope.where !== '1=1' ? ` AND ${scope.where}` : ''}`,
      [...scope.params, req.params.id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const agent = rows[0];

    // Parallel queries for stats
    const [inferenceResult, chatResult, sessionResult, skillResult] = await Promise.all([
      getPool().query(
        `SELECT COUNT(*) AS total_inferences,
                COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                COALESCE(SUM(cost_usd), 0) AS estimated_cost,
                COUNT(DISTINCT model) AS distinct_models
         FROM model_usage WHERE agent_id = $1`,
        [agent.agent_id],
      ),
      getPool().query(
        `SELECT COUNT(*) AS total_messages
         FROM chat_messages WHERE author_id = $1 AND author_type = 'agent'`,
        [agent.id],
      ),
      getPool().query(
        `SELECT COALESCE(SUM(
           EXTRACT(EPOCH FROM (COALESCE(stopped_at, NOW()) - started_at))
         ), 0) AS total_uptime_seconds
         FROM agent_sessions WHERE agent_id = $1`,
        [agent.id],
      ),
      getPool().query(
        `SELECT COUNT(*) AS skill_count FROM agent_skills WHERE agent_id = $1`,
        [agent.id],
      ),
    ]);

    const inf = inferenceResult.rows[0];
    const chat = chatResult.rows[0];
    const sess = sessionResult.rows[0];
    const skill = skillResult.rows[0];

    // Knowledge entries via AKM proxy (best-effort)
    let knowledgeEntries = 0;
    try {
      const akmProxy = await import('../services/akm-proxy');
      const akmResult = await akmProxy.listEntries(agent.agent_id);
      if (akmResult.status === 200 && Array.isArray(akmResult.data)) {
        knowledgeEntries = akmResult.data.length;
      }
    } catch { /* AKM unavailable */ }

    res.json({
      total_inferences: Number(inf.total_inferences),
      total_tokens: Number(inf.total_tokens),
      estimated_cost: Number(Number(inf.estimated_cost).toFixed(4)),
      distinct_models: Number(inf.distinct_models),
      knowledge_entries: knowledgeEntries,
      chat_messages: Number(chat.total_messages),
      total_uptime_seconds: Math.floor(Number(sess.total_uptime_seconds)),
      skills_assigned: Number(skill.skill_count),
      first_started: agent.created_at,
    });
  } catch (err: any) {
    console.error('[agents] Stats error:', err);
    res.status(500).json({ error: 'Failed to compute stats' });
  }
});

// Agent progression — artifacts (computed on-demand from stats)
const ARTIFACT_CATALOG = [
  { id: 'first_light', name: 'First Light', icon: '⚡', description: 'Completed first model inference', check: (s: any) => s.total_inferences >= 1 },
  { id: 'thousand_calls', name: 'Thousand Calls', icon: '🔥', description: '1,000 inferences completed', check: (s: any) => s.total_inferences >= 1000 },
  { id: 'ten_thousand', name: 'Ten Thousand', icon: '💫', description: '10,000 inferences completed', check: (s: any) => s.total_inferences >= 10000 },
  { id: 'first_plan', name: 'First Plan', icon: '🏗', description: 'Created first plan document', check: (s: any) => s.plan_entries >= 1 },
  { id: 'decision_maker', name: 'Decision Maker', icon: '⚖️', description: 'Recorded first architecture decision', check: (s: any) => s.decision_entries >= 1 },
  { id: 'deep_research', name: 'Deep Research', icon: '🔬', description: 'Conducted first research investigation', check: (s: any) => s.research_entries >= 1 },
  { id: 'memory_keeper', name: 'Memory Keeper', icon: '🧠', description: 'Accumulated 100 knowledge entries', check: (s: any) => s.knowledge_entries >= 100 },
  { id: 'chat_veteran', name: 'Chat Veteran', icon: '💬', description: 'Sent 100 chat messages', check: (s: any) => s.chat_messages >= 100 },
  { id: 'polyglot', name: 'Polyglot', icon: '🌐', description: 'Used 2+ different models', check: (s: any) => s.distinct_models >= 2 },
  { id: 'week_runner', name: 'Week Runner', icon: '⏱', description: '7 days cumulative uptime', check: (s: any) => s.total_uptime_seconds >= 7 * 86400 },
  { id: 'month_runner', name: 'Month Runner', icon: '🏃', description: '30 days cumulative uptime', check: (s: any) => s.total_uptime_seconds >= 30 * 86400 },
];

router.get('/:id/artifacts', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length + 1;
    const { rows } = await getPool().query(
      `SELECT * FROM agents WHERE id = $${paramOffset}${scope.where !== '1=1' ? ` AND ${scope.where}` : ''}`,
      [...scope.params, req.params.id],
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const agent = rows[0];

    // Gather signal data
    const [infResult, chatResult, sessResult] = await Promise.all([
      getPool().query(
        `SELECT COUNT(*) AS total_inferences, COUNT(DISTINCT model) AS distinct_models
         FROM model_usage WHERE agent_id = $1`,
        [agent.agent_id],
      ),
      getPool().query(
        `SELECT COUNT(*) AS total_messages
         FROM chat_messages WHERE author_id = $1 AND author_type = 'agent'`,
        [agent.id],
      ),
      getPool().query(
        `SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(stopped_at, NOW()) - started_at))), 0) AS total_uptime_seconds
         FROM agent_sessions WHERE agent_id = $1`,
        [agent.id],
      ),
    ]);

    // Knowledge entry type counts via AKM proxy
    let knowledgeEntries = 0;
    let planEntries = 0;
    let decisionEntries = 0;
    let researchEntries = 0;
    try {
      const akmProxy = await import('../services/akm-proxy');
      const akmResult = await akmProxy.listEntries(agent.agent_id);
      if (akmResult.status === 200 && Array.isArray(akmResult.data)) {
        knowledgeEntries = akmResult.data.length;
        planEntries = (akmResult.data as any[]).filter((e: any) => e.entry_type === 'plan').length;
        decisionEntries = (akmResult.data as any[]).filter((e: any) => e.entry_type === 'decision').length;
        researchEntries = (akmResult.data as any[]).filter((e: any) => e.entry_type === 'research').length;
      }
    } catch { /* AKM unavailable */ }

    const signalData = {
      total_inferences: Number(infResult.rows[0].total_inferences),
      distinct_models: Number(infResult.rows[0].distinct_models),
      chat_messages: Number(chatResult.rows[0].total_messages),
      total_uptime_seconds: Math.floor(Number(sessResult.rows[0].total_uptime_seconds)),
      knowledge_entries: knowledgeEntries,
      plan_entries: planEntries,
      decision_entries: decisionEntries,
      research_entries: researchEntries,
    };

    const artifacts = ARTIFACT_CATALOG.map(a => ({
      id: a.id,
      name: a.name,
      icon: a.icon,
      description: a.description,
      earned: a.check(signalData),
    }));

    res.json({ artifacts, earned_count: artifacts.filter(a => a.earned).length });
  } catch (err: any) {
    console.error('[agents] Artifacts error:', err);
    res.status(500).json({ error: 'Failed to compute artifacts' });
  }
});

// ───────────────────────────────────────────────────────────────────
// POST /agents/:id/clone — clone an agent with a new name and ID
// ───────────────────────────────────────────────────────────────────

router.post('/:id/clone', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const pool = getPool();

    // Fetch the source agent
    const { rows: srcRows } = await pool.query(
      `SELECT agent_id, name, description, tools_config, cpus, mem_limit, pids_limit,
              soul_md, rules_md, model_policy_id, container_profile_id, autonomy_level
       FROM agents WHERE id = $1`,
      [req.params.id]
    );
    if (srcRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    const src = srcRows[0];

    // Generate a unique slug: original-clone or original-clone-N
    let cloneSlug = `${src.agent_id}-clone`;
    const { rows: existing } = await pool.query(
      `SELECT agent_id FROM agents WHERE agent_id LIKE $1 ORDER BY agent_id`,
      [`${src.agent_id}-clone%`]
    );
    if (existing.length > 0) {
      const taken = new Set(existing.map((r: any) => r.agent_id));
      if (taken.has(cloneSlug)) {
        let n = 2;
        while (taken.has(`${src.agent_id}-clone-${n}`)) n++;
        cloneSlug = `${src.agent_id}-clone-${n}`;
      }
    }

    const cloneName = req.body.name || `${src.name} (Clone)`;

    // Validate model_policy ownership if present
    let policyId = src.model_policy_id;
    if (policyId) {
      const { rows: policyRows } = await pool.query(
        'SELECT id, created_by, description FROM model_policies WHERE id = $1',
        [policyId]
      );
      if (policyRows.length > 0) {
        const pol = policyRows[0];
        // Auto-agent policies are per-agent — don't copy, let the new agent get its own
        if (isAutoAgentModelsPolicy(pol.description)) {
          policyId = null;
        } else if (pol.created_by !== null && pol.created_by !== user.sub) {
          policyId = null; // Can't assign another user's policy
        }
      } else {
        policyId = null;
      }
    }

    // Insert the cloned agent
    const { rows: cloneRows } = await pool.query(
      `INSERT INTO agents (agent_id, name, description, tools_config, cpus, mem_limit, pids_limit,
                           soul_md, rules_md, model_policy_id, container_profile_id, autonomy_level, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               COALESCE($10::uuid, (SELECT id FROM model_policies WHERE name = 'default' AND created_by IS NULL LIMIT 1)),
               $11, $12, $13)
       RETURNING id, agent_id, name, description, status, tools_config,
                 cpus, mem_limit, pids_limit, soul_md, rules_md, container_id,
                 model_policy_id, container_profile_id, autonomy_level, error_message, created_at, updated_at, created_by`,
      [
        cloneSlug,
        cloneName,
        src.description || '',
        JSON.stringify(src.tools_config),
        src.cpus,
        src.mem_limit,
        src.pids_limit,
        src.soul_md || '',
        src.rules_md || '',
        policyId,
        src.container_profile_id || null,
        src.autonomy_level || 'act_within_scope',
        user.sub,
      ]
    );
    const cloned = cloneRows[0];

    // Clone skill assignments
    const { rows: srcSkills } = await pool.query(
      `SELECT skill_id FROM agent_skills WHERE agent_id = $1`,
      [req.params.id]
    );
    for (const { skill_id } of srcSkills) {
      await pool.query(
        'INSERT INTO agent_skills (agent_id, skill_id, assigned_by) VALUES ($1, $2, $3)',
        [cloned.id, skill_id, user.sub]
      );
    }

    // If source had auto-agent models, create one for the clone too
    if (src.model_policy_id && !policyId) {
      const models = await resolveAgentModels(src.model_policy_id);
      if (models.length > 0) {
        const autoPolicyId = await upsertAutoAgentModelsPolicy(
          cloned.id, cloned.agent_id, user.sub, user.sub, models
        );
        await pool.query(
          `UPDATE agents SET model_policy_id = $1, updated_at = NOW() WHERE id = $2`,
          [autoPolicyId, cloned.id]
        );
        cloned.model_policy_id = autoPolicyId;
        cloned.models = models;
      }
    }

    if (!cloned.models) {
      cloned.models = await resolveAgentModels(cloned.model_policy_id);
    }

    // Fetch skills for response
    const { rows: skillRows } = await pool.query(
      `SELECT s.id, s.name, s.scope FROM agent_skills asks
       JOIN skills s ON s.id = asks.skill_id
       WHERE asks.agent_id = $1`,
      [cloned.id]
    );
    cloned.skills = skillRows;

    res.status(201).json(cloned);
  } catch (err: any) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'Clone slug already exists — try again' });
      return;
    }
    console.error('[agents] Clone error:', err);
    res.status(500).json({ error: 'Failed to clone agent' });
  }
});

// ───────────────────────────────────────────────────────────────────
// Webhooks CRUD
// ───────────────────────────────────────────────────────────────────

const VALID_WEBHOOK_EVENTS = ['start', 'stop', 'error'] as const;

// GET /agents/:id/webhooks — list webhooks for an agent
router.get('/:id/webhooks', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, agent_id, url, events, active, created_by, created_at, updated_at
       FROM agent_webhooks WHERE agent_id = $1 ORDER BY created_at`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[agents] List webhooks error:', err);
    res.status(500).json({ error: 'Failed to list webhooks' });
  }
});

// POST /agents/:id/webhooks — register a webhook
router.post('/:id/webhooks', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const user = (req as any).user;
    const { url, events, secret } = req.body;

    if (!url || typeof url !== 'string') {
      res.status(400).json({ error: 'url is required' });
      return;
    }

    // Validate URL format
    try {
      new URL(url);
    } catch {
      res.status(400).json({ error: 'Invalid URL format' });
      return;
    }

    // Validate events array
    const eventList: string[] = Array.isArray(events) ? events : ['start', 'stop', 'error'];
    for (const e of eventList) {
      if (!VALID_WEBHOOK_EVENTS.includes(e as any)) {
        res.status(400).json({ error: `Invalid event: ${e}. Valid: ${VALID_WEBHOOK_EVENTS.join(', ')}` });
        return;
      }
    }

    // Verify agent exists
    const { rows: agentRows } = await getPool().query(
      'SELECT id FROM agents WHERE id = $1', [req.params.id]
    );
    if (agentRows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO agent_webhooks (agent_id, url, events, secret, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, agent_id, url, events, active, created_by, created_at, updated_at`,
      [req.params.id, url, eventList, secret || null, user.sub]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[agents] Create webhook error:', err);
    res.status(500).json({ error: 'Failed to create webhook' });
  }
});

// DELETE /agents/:id/webhooks/:webhookId — remove a webhook
router.delete('/:id/webhooks/:webhookId', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rowCount } = await getPool().query(
      'DELETE FROM agent_webhooks WHERE id = $1 AND agent_id = $2',
      [req.params.webhookId, req.params.id]
    );
    if (!rowCount) {
      res.status(404).json({ error: 'Webhook not found' });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    console.error('[agents] Delete webhook error:', err);
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

export default router;
