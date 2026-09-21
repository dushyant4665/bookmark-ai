import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as conversationService from '../services/conversationService.js';

const router = Router();
router.use(requireAuth);

router.post('/', async (req, res, next) => {
  try {
    const { bookId, editionId, title } = req.body || {};
    if (!bookId || !editionId) return res.status(400).json({ error: 'VALIDATION_ERROR' });
    const convo = await conversationService.createConversation({
      userId: req.userId,
      bookId,
      editionId,
      title,
    });
    res.status(201).json({ conversation: convo });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const { bookId, editionId } = req.query;
    if (!bookId || !editionId) return res.status(400).json({ error: 'VALIDATION_ERROR' });
    const conversations = await conversationService.listConversations({
      userId: req.userId,
      bookId,
      editionId,
    });
    res.json({ conversations });
  } catch (err) {
    next(err);
  }
});

router.get('/:conversationId/messages', async (req, res, next) => {
  try {
    const result = await conversationService.listMessages({
      userId: req.userId,
      conversationId: req.params.conversationId,
    });
    if (!result) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
