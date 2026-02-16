import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

interface AuthOptions {
  issuer: string;
  getSigningKey: (header: jwt.JwtHeader) => Promise<string>;
}

export function createRequireAuth(opts: AuthOptions) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const decoded = jwt.decode(token, { complete: true });
      if (!decoded || typeof decoded === 'string') {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }

      const signingKey = await opts.getSigningKey(decoded.header);

      const payload = jwt.verify(token, signingKey, {
        algorithms: ['RS256'],
        issuer: opts.issuer,
      }) as jwt.JwtPayload;

      if (typeof payload.exp !== 'number') {
        res.status(401).json({ error: 'Token missing exp claim' });
        return;
      }

      (req as any).user = payload;
      next();
    } catch {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

// Default JWKS-based key resolver for production
export function createJwksKeyResolver(jwksUri: string) {
  const client = jwksClient({
    jwksUri,
    cache: true,
    cacheMaxAge: 3600000,
  });

  return async (header: jwt.JwtHeader): Promise<string> => {
    if (!header.kid) {
      throw new Error('Token header missing kid');
    }
    const key = await client.getSigningKey(header.kid);
    return key.getPublicKey();
  };
}
