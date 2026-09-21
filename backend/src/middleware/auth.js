import { env } from '../config/env.js';
import { verifyToken } from '../services/authService.js';

// Requires a valid `Authorization: Bearer <jwt>`. Populates req.userId.
export function requireAuth(req, res, next) {
  if (!env.jwtSecret) {
    return res.status(503).json({ error: 'AUTH_NOT_CONFIGURED' });
  }
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'AUTHENTICATION_REQUIRED' });
  }
  try {
    const payload = verifyToken(token);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: 'INVALID_OR_EXPIRED_TOKEN' });
  }
}
