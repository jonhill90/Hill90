import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';

const router = Router();

const VALID_SCOPES = ['container_local', 'host_docker', 'vps_system'] as const;

function dbHealthCheck(_req: Request, res: Response, next: () => void) {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }
  next();
}

router.use(dbHealthCheck);

function isAdmin(req: Request): boolean {
  const user = (req as any).user;
  const roles: string[] = user?.realm_roles || [];
  return roles.includes('admin');
}

// Helper: fetch tools for a set of skill IDs via skill_tools join
async function fetchToolsForSkills(skillIds: string[]): Promise<Record<string, any[]>> {
  if (skillIds.length === 0) return {};
  const { rows } = await getPool().query(
    `SELECT st.skill_id, t.id, t.name, t.description, t.install_method
     FROM skill_tools st
     JOIN tools t ON t.id = st.tool_id
     WHERE st.skill_id = ANY($1::uuid[])
     ORDER BY t.name ASC`,
    [skillIds]
  );
  const map: Record<string, any[]> = {};
  for (const row of rows) {
    if (!map[row.skill_id]) map[row.skill_id] = [];
    map[row.skill_id].push({ id: row.id, name: row.name, description: row.description, install_method: row.install_method });
  }
  return map;
}

// Helper: validate and insert skill_tools rows
async function setSkillTools(skillId: string, toolIds: string[]): Promise<void> {
  if (!toolIds || toolIds.length === 0) return;

  // Validate all tool_ids exist
  const { rows: existingTools } = await getPool().query(
    'SELECT id FROM tools WHERE id = ANY($1::uuid[])',
    [toolIds]
  );
  if (existingTools.length !== toolIds.length) {
    const found = new Set(existingTools.map((t: any) => t.id));
    const missing = toolIds.filter(id => !found.has(id));
    throw { validationError: true, message: `Tool(s) not found: ${missing.join(', ')}` };
  }

  // Delete existing and insert new
  await getPool().query('DELETE FROM skill_tools WHERE skill_id = $1', [skillId]);
  for (const toolId of toolIds) {
    await getPool().query(
      'INSERT INTO skill_tools (skill_id, tool_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [skillId, toolId]
    );
  }
}

// List all skills — all authenticated users see all skills
router.get('/', requireRole('user'), async (_req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, tools_config, instructions_md, scope, is_platform, created_by, created_at, updated_at
       FROM skills ORDER BY is_platform DESC, name ASC`
    );

    // Fetch tools for all skills
    const toolsMap = await fetchToolsForSkills(rows.map((r: any) => r.id));
    const result = rows.map((r: any) => ({ ...r, tools: toolsMap[r.id] || [] }));

    res.json(result);
  } catch (err) {
    console.error('[skills] List error:', err);
    res.status(500).json({ error: 'Failed to list skills' });
  }
});

// Get single skill
router.get('/:id', requireRole('user'), async (req: Request, res: Response) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, description, tools_config, instructions_md, scope, is_platform, created_by, created_at, updated_at
       FROM skills WHERE id = $1`,
      [req.params.id]
    );
    if (rows.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    const toolsMap = await fetchToolsForSkills([rows[0].id]);
    res.json({ ...rows[0], tools: toolsMap[rows[0].id] || [] });
  } catch (err) {
    console.error('[skills] Get error:', err);
    res.status(500).json({ error: 'Failed to get skill' });
  }
});

// Create skill — admin only
router.post('/', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { name, description, tools_config, instructions_md, scope, tool_ids } = req.body;

    if (!name) {
      res.status(400).json({ error: 'name is required' });
      return;
    }
    if (!tools_config || typeof tools_config !== 'object') {
      res.status(400).json({ error: 'tools_config is required and must be an object' });
      return;
    }
    if (scope !== undefined && !VALID_SCOPES.includes(scope)) {
      res.status(400).json({ error: `Invalid scope. Must be one of: ${VALID_SCOPES.join(', ')}` });
      return;
    }

    if (tool_ids !== undefined && (!Array.isArray(tool_ids) || !tool_ids.every((id: unknown) => typeof id === 'string'))) {
      res.status(400).json({ error: 'tool_ids must be an array of UUIDs' });
      return;
    }

    const { rows } = await getPool().query(
      `INSERT INTO skills (name, description, tools_config, instructions_md, scope, is_platform, created_by)
       VALUES ($1, $2, $3, $4, $5, false, NULL)
       RETURNING *`,
      [name, description || '', JSON.stringify(tools_config), instructions_md || '', scope || 'container_local']
    );

    const skill = rows[0];

    // Insert skill_tools if provided
    if (tool_ids && tool_ids.length > 0) {
      await setSkillTools(skill.id, tool_ids);
    }

    const toolsMap = await fetchToolsForSkills([skill.id]);
    res.status(201).json({ ...skill, tools: toolsMap[skill.id] || [] });
  } catch (err: any) {
    if (err.validationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err.code === '23505') {
      res.status(409).json({ error: 'A skill with this name already exists' });
      return;
    }
    console.error('[skills] Create error:', err);
    res.status(500).json({ error: 'Failed to create skill' });
  }
});

// Update skill — admin only
router.put('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows: existing } = await getPool().query(
      'SELECT id FROM skills WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }

    const { name, description, tools_config, instructions_md, scope, tool_ids } = req.body;

    if (scope !== undefined && !VALID_SCOPES.includes(scope)) {
      res.status(400).json({ error: `Invalid scope. Must be one of: ${VALID_SCOPES.join(', ')}` });
      return;
    }

    if (tool_ids !== undefined && (!Array.isArray(tool_ids) || !tool_ids.every((id: unknown) => typeof id === 'string'))) {
      res.status(400).json({ error: 'tool_ids must be an array of UUIDs' });
      return;
    }

    const { rows } = await getPool().query(
      `UPDATE skills SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        tools_config = COALESCE($3, tools_config),
        instructions_md = COALESCE($4, instructions_md),
        scope = COALESCE($5, scope),
        updated_at = NOW()
       WHERE id = $6
       RETURNING *`,
      [
        name || null,
        description ?? null,
        tools_config ? JSON.stringify(tools_config) : null,
        instructions_md ?? null,
        scope || null,
        req.params.id,
      ]
    );

    // Update skill_tools if provided
    if (tool_ids !== undefined) {
      await setSkillTools(rows[0].id, tool_ids);
    }

    const toolsMap = await fetchToolsForSkills([rows[0].id]);
    res.json({ ...rows[0], tools: toolsMap[rows[0].id] || [] });
  } catch (err: any) {
    if (err.validationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err.code === '23505') {
      res.status(409).json({ error: 'A skill with this name already exists' });
      return;
    }
    console.error('[skills] Update error:', err);
    res.status(500).json({ error: 'Failed to update skill' });
  }
});

// Delete skill — admin only, platform skills undeletable, assigned skills undeletable
router.delete('/:id', requireRole('admin'), async (req: Request, res: Response) => {
  try {
    const { rows: existing } = await getPool().query(
      'SELECT id, is_platform FROM skills WHERE id = $1',
      [req.params.id]
    );
    if (existing.length === 0) {
      res.status(404).json({ error: 'Skill not found' });
      return;
    }
    if (existing[0].is_platform) {
      res.status(403).json({ error: 'Cannot delete a platform skill' });
      return;
    }

    // Check for agents using this skill via agent_skills join table
    const { rows: assignments } = await getPool().query(
      `SELECT as2.agent_id, a.agent_id AS agent_slug
       FROM agent_skills as2
       JOIN agents a ON a.id = as2.agent_id
       WHERE as2.skill_id = $1 LIMIT 1`,
      [req.params.id]
    );
    if (assignments.length > 0) {
      res.status(409).json({
        error: 'Cannot delete skill while agents are assigned to it',
        agent_id: assignments[0].agent_slug,
      });
      return;
    }

    // skill_tools rows cascade-delete via FK
    await getPool().query('DELETE FROM skills WHERE id = $1', [req.params.id]);
    res.json({ deleted: true });
  } catch (err) {
    console.error('[skills] Delete error:', err);
    res.status(500).json({ error: 'Failed to delete skill' });
  }
});

export default router;
