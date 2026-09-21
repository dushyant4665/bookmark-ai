import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { query } from '../db/pool.js';

const ROUNDS = 12;

function sign(userId) {
  return jwt.sign({ sub: userId }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });
}

function publicUser(row) {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

export async function register({ email, password }) {
  const normalized = String(email).trim().toLowerCase();
  const hash = await bcrypt.hash(password, ROUNDS);
  const { rows } = await query(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, email, created_at`,
    [normalized, hash]
  );
  if (!rows[0]) {
    const e = new Error('EMAIL_TAKEN');
    e.status = 409;
    throw e;
  }
  return { user: publicUser(rows[0]), token: sign(rows[0].id) };
}

export async function login({ email, password }) {
  const normalized = String(email).trim().toLowerCase();
  const { rows } = await query(
    `SELECT id, email, password_hash, created_at FROM users WHERE email = $1`,
    [normalized]
  );
  const row = rows[0];
  const ok = row && (await bcrypt.compare(password, row.password_hash));
  if (!ok) {
    const e = new Error('INVALID_CREDENTIALS');
    e.status = 401;
    throw e;
  }
  return { user: publicUser(row), token: sign(row.id) };
}

export async function getUserById(id) {
  const { rows } = await query(`SELECT id, email, created_at FROM users WHERE id = $1`, [id]);
  return rows[0] ? publicUser(rows[0]) : null;
}

export function verifyToken(token) {
  return jwt.verify(token, env.jwtSecret);
}
