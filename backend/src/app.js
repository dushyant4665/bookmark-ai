import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import apiRoutes from './routes/index.js';
import { notFound, errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');

  app.use(
    cors({
      origin(origin, cb) {
        // Allow non-browser tools (no Origin) and whitelisted origins.
        // For the rest, omit the header and let the browser block the response.
        if (!origin || env.corsOrigins.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
    })
  );

  app.use(express.json({ limit: '1mb' }));
  app.use('/api', apiRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
