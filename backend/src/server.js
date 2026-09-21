import { createApp } from './app.js';
import { env, assertEnv } from './config/env.js';
import { dbAvailable, closePool } from './db/pool.js';
import { logger } from './utils/logger.js';

assertEnv();

const app = createApp();

const server = app.listen(env.port, () => {
  logger.info(
    `BOOKMARK backend listening on :${env.port} ` +
      `(db=${dbAvailable() ? 'configured' : 'not_configured'}, ` +
      `storage=${env.storageBackend})`
  );
});

// Graceful shutdown: stop accepting new connections, let in-flight requests
// (including SSE) drain, close the DB pool, then exit. A hard timeout keeps a
// stuck connection from blocking the recycle forever.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received — shutting down gracefully`);
  const force = setTimeout(() => {
    logger.error('shutdown timed out — forcing exit');
    process.exit(1);
  }, 10000);
  force.unref?.();
  server.close(async () => {
    try {
      await closePool();
    } catch (err) {
      logger.error('pool close error', err.message);
    }
    clearTimeout(force);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', reason instanceof Error ? reason.message : String(reason));
});
