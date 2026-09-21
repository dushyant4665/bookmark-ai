import { Router } from 'express';
import * as authService from '../services/authService.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter, loginLimiter } from '../middleware/rateLimit.js';

const router = Router();

function validEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!validEmail(email)) return res.status(400).json({ error: 'VALIDATION_ERROR', field: 'email' });
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', field: 'password' });
    }
    res.status(201).json(await authService.register({ email, password }));
  } catch (err) {
    next(err);
  }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!validEmail(email) || typeof password !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR' });
    }
    res.json(await authService.login({ email, password }));
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await authService.getUserById(req.userId);
    if (!user) return res.status(404).json({ error: 'NOT_FOUND' });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

export default router;
