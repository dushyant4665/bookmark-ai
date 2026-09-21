import { Router } from 'express';
import authRoutes from './auth.js';
import bookRoutes from './books.js';
import conversationRoutes from './conversations.js';
import chatRoutes from './chat.js';
import { requireAuth } from '../middleware/auth.js';
import { healthSnapshot } from '../services/healthService.js';

const router = Router();

router.get('/health', async (req, res) => {
  // Always 200: this is a liveness/observability probe. The body reports the
  // honest per-dependency state; a hard readiness gate is `verify:production`.
  const h = await healthSnapshot();
  res.status(200).json(h);
});

router.use('/auth', authRoutes);
router.use('/books', requireAuth, bookRoutes);
router.use('/conversations', conversationRoutes);
router.use('/chat', chatRoutes);

export default router;
