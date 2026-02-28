import { Router, Request, Response } from 'express';
import { getPool } from '../db/pool';
import { requireRole } from '../middleware/role';

const router = Router();

function dbHealthCheck(_req: Request, res: Response, next: () => void) {
  if (!process.env.DATABASE_URL) {
    res.status(503).json({ error: 'Database not configured' });
    return;
  }
  next();
}

router.use(dbHealthCheck);
router.use(requireRole('admin'));

// Query usage with optional filtering and aggregation
router.get('/', async (req: Request, res: Response) => {
  try {
    const { agent_id, model_name, request_type, status, delegation_id, from, to, group_by } = req.query;

    const conditions: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    if (agent_id) {
      conditions.push(`agent_id = $${paramIdx++}`);
      params.push(agent_id);
    }
    if (model_name) {
      conditions.push(`model_name = $${paramIdx++}`);
      params.push(model_name);
    }
    if (request_type) {
      conditions.push(`request_type = $${paramIdx++}`);
      params.push(request_type);
    }
    if (status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(status);
    }
    if (delegation_id) {
      conditions.push(`delegation_id = $${paramIdx++}::uuid`);
      params.push(delegation_id);
    }

    // Date range defaults to today — explicit UTC offset so the cast is
    // unambiguous regardless of the DB session timezone setting.
    const fromDate = (from as string) || new Date().toISOString().slice(0, 10);
    conditions.push(`created_at >= $${paramIdx++}::timestamptz`);
    params.push(`${fromDate}T00:00:00+00:00`);

    if (to) {
      conditions.push(`created_at < $${paramIdx++}::timestamptz + interval '1 day'`);
      params.push(`${to as string}T00:00:00+00:00`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    if (group_by === 'agent' || group_by === 'model' || group_by === 'day' || group_by === 'request_type' || group_by === 'delegation') {
      const groupCol = group_by === 'agent' ? 'agent_id'
        : group_by === 'model' ? 'model_name'
        : group_by === 'request_type' ? 'request_type'
        : group_by === 'delegation' ? 'delegation_id'
        : "date_trunc('day', created_at)::date";
      const selectAlias = group_by === 'day' ? `${groupCol} AS day` : groupCol;

      const { rows } = await getPool().query(
        `SELECT ${selectAlias},
                COUNT(*) AS total_requests,
                COUNT(*) FILTER (WHERE status = 'success') AS successful_requests,
                COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
                COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
                COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
                COALESCE(SUM(cost_usd), 0)::numeric(10,6) AS total_cost_usd
         FROM model_usage ${whereClause}
         GROUP BY ${groupCol}
         ORDER BY ${groupCol}`,
        params
      );
      res.json({ data: rows, group_by });
    } else {
      // Summary (no grouping)
      const { rows } = await getPool().query(
        `SELECT
           COUNT(*) AS total_requests,
           COUNT(*) FILTER (WHERE status = 'success') AS successful_requests,
           COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
           COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
           COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
           COALESCE(SUM(cost_usd), 0)::numeric(10,6) AS total_cost_usd
         FROM model_usage ${whereClause}`,
        params
      );
      res.json(rows[0]);
    }
  } catch (err) {
    console.error('[usage] Query error:', err);
    res.status(500).json({ error: 'Failed to query usage' });
  }
});

export default router;
