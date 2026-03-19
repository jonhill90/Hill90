import crypto from 'node:crypto';
import { Request, Response, NextFunction } from 'express';

const HEADER = 'x-correlation-id';

/**
 * Ensures every request has a correlation ID.
 * Reads from the X-Correlation-ID header if present, otherwise generates a UUID.
 * Attaches to req and echoes in the response header.
 */
export function correlationId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers[HEADER] as string) || crypto.randomUUID();
  (req as any).correlationId = id;
  res.setHeader('X-Correlation-ID', id);
  next();
}
