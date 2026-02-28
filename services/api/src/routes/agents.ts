import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';
import { scopeToOwner } from '../helpers/scope';
import { writeAgentFiles, removeAgentFiles } from '../services/agent-files';
import {
  createAndStartContainer,
  stopAndRemoveContainer,
  inspectContainer,
  getContainerLogs,
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

// ---------------------------------------------------------------------------
// CRUD (user role)
// ---------------------------------------------------------------------------

// List agents
router.get('/', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const scope = scopeToOwner(req);
    const paramOffset = scope.params.length;
    const { rows } = await getPool().query(
      `SELECT id, agent_id, name, description, status, cpus, mem_limit, pids_limit, model_policy_id, created_at, updated_at, created_by
       FROM agents WHERE ${scope.where} ORDER BY created_at DESC`,
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
    const { agent_id, name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md } = req.body;

    if (!agent_id || !name) {
      res.status(400).json({ error: 'agent_id and name are required' });
      return;
    }

    // Validate agent_id format (slug: lowercase, alphanumeric, hyphens)
    if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(agent_id) && !/^[a-z0-9]$/.test(agent_id)) {
      res.status(400).json({ error: 'agent_id must be a lowercase slug (a-z, 0-9, hyphens, 1-63 chars)' });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO agents (agent_id, name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        agent_id,
        name,
        description || '',
        JSON.stringify(tools_config || { shell: { enabled: false }, filesystem: { enabled: false }, health: { enabled: true } }),
        cpus || '1.0',
        mem_limit || '1g',
        pids_limit || 200,
        soul_md || '',
        rules_md || '',
        user.sub,
      ]
    );

    res.status(201).json(rows[0]);
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
      `SELECT * FROM agents WHERE id = $${paramOffset} AND ${scope.where}`,
      [...scope.params, req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    res.json(rows[0]);
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

    const { name, description, tools_config, cpus, mem_limit, pids_limit, soul_md, rules_md, model_policy_id } = req.body;

    // model_policy_id requires admin role
    if (model_policy_id !== undefined) {
      const user = (req as any).user;
      const roles: string[] = user.realm_roles || [];
      if (!roles.includes('admin')) {
        res.status(403).json({ error: 'Setting model_policy_id requires admin role' });
        return;
      }

      // Validate FK if non-null
      if (model_policy_id !== null) {
        const { rows: policyRows } = await getPool().query(
          'SELECT id FROM model_policies WHERE id = $1',
          [model_policy_id]
        );
        if (policyRows.length === 0) {
          res.status(400).json({ error: 'Model policy not found' });
          return;
        }
      }
    }

    // Build SET clause: model_policy_id uses explicit flag to allow clearing to NULL
    const modelPolicyProvided = model_policy_id !== undefined;
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
       RETURNING *`,
      [
        name || null,
        description ?? null,
        tools_config ? JSON.stringify(tools_config) : null,
        cpus || null,
        mem_limit || null,
        pids_limit ?? null,
        soul_md ?? null,
        rules_md ?? null,
        modelPolicyProvided,
        modelPolicyProvided ? (model_policy_id ?? null) : null,
        req.params.id,
      ]
    );

    res.json(rows[0]);
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

    // Write config files to disk
    writeAgentFiles(agent);

    // Generate AKM token if configured
    let akmEnv: string[] = [];
    let akmJti: string | null = null;
    let akmExp: number | null = null;
    if (isAkmConfigured()) {
      try {
        const akmToken = await generateAgentAkmToken(agent.agent_id);
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
      env: [...akmEnv, ...modelRouterEnv],
    });

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
