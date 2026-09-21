import { logger } from '../utils/logger.js';

// Maps error codes to clean, non-leaky HTTP responses. Technical detail stays
// in the server log; the client gets a short code it can translate to UI copy.
const STATUS = {
  DATABASE_UNAVAILABLE: 503,
  STORAGE_BACKEND_NOT_READY: 501,
  STORAGE_PATH_ESCAPE: 400,
  RETRIEVAL_NOT_IMPLEMENTED: 501,
  EMBEDDING_NOT_CONFIGURED: 503,
  GROQ_NOT_CONFIGURED: 503,
  AUTH_NOT_CONFIGURED: 503,
  INVALID_CREDENTIALS: 401,
  EMAIL_TAKEN: 409,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
};

export function notFound(req, res) {
  res.status(404).json({ error: 'NOT_FOUND' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const code = err.code || err.message || 'INTERNAL_ERROR';
  if (!STATUS[code]) {
    logger.error(req.method, req.originalUrl, err.message);
  }
  const status = STATUS[code] || err.status || 500;
  res.status(status).json({ error: STATUS[code] ? code : 'INTERNAL_ERROR' });
}
