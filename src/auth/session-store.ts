import { randomBytes } from 'crypto'
import type { Pool } from 'pg'
import type { Session, User } from './types.js'

// DDL run once on startup so the service owns its own schema.
export const SESSION_SCHEMA = `
  CREATE TABLE IF NOT EXISTS auth_users (
    id          TEXT PRIMARY KEY,
    github_id   TEXT UNIQUE NOT NULL,
    login       TEXT NOT NULL,
    email       TEXT,
    avatar_url  TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    id                   TEXT PRIMARY KEY,
    user_id              TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
    github_access_token  TEXT NOT NULL,
    refresh_token        TEXT,
    expires_at           TIMESTAMPTZ NOT NULL,
    csrf_token           TEXT NOT NULL,
    revoked_at           TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`

export class SessionStore {
  constructor(private readonly db: Pool) {}

  async migrate(): Promise<void> {
    await this.db.query(SESSION_SCHEMA)
  }

  async upsertUser(
    githubId: number,
    login: string,
    email: string | null,
    avatarUrl: string,
  ): Promise<User> {
    const res = await this.db.query<User>(
      `INSERT INTO auth_users (id, github_id, login, email, avatar_url)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4)
       ON CONFLICT (github_id) DO UPDATE
         SET login      = EXCLUDED.login,
             email      = EXCLUDED.email,
             avatar_url = EXCLUDED.avatar_url,
             updated_at = NOW()
       RETURNING *`,
      [String(githubId), login, email, avatarUrl],
    )
    return res.rows[0]
  }

  async createSession(
    userId: string,
    githubAccessToken: string,
    refreshToken: string | null,
    ttlMs: number,
  ): Promise<Session> {
    const id        = randomBytes(32).toString('hex')
    const csrfToken = randomBytes(32).toString('hex')
    const expiresAt = new Date(Date.now() + ttlMs)

    const res = await this.db.query<Session>(
      `INSERT INTO auth_sessions
         (id, user_id, github_access_token, refresh_token, expires_at, csrf_token)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [id, userId, githubAccessToken, refreshToken, expiresAt, csrfToken],
    )
    return res.rows[0]
  }

  async getSession(id: string): Promise<Session | null> {
    const res = await this.db.query<Session>(
      `SELECT * FROM auth_sessions WHERE id = $1 LIMIT 1`,
      [id],
    )
    return res.rows[0] ?? null
  }

  async revokeSession(id: string): Promise<void> {
    await this.db.query(
      `UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1`,
      [id],
    )
  }

  async updateSessionToken(
    id: string,
    githubAccessToken: string,
    refreshToken: string | null,
    ttlMs: number,
  ): Promise<Session | null> {
    const expiresAt = new Date(Date.now() + ttlMs)
    const res = await this.db.query<Session>(
      `UPDATE auth_sessions
       SET github_access_token = $2,
           refresh_token       = $3,
           expires_at          = $4
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING *`,
      [id, githubAccessToken, refreshToken, expiresAt],
    )
    return res.rows[0] ?? null
  }

  async getUser(id: string): Promise<User | null> {
    const res = await this.db.query<User>(
      `SELECT * FROM auth_users WHERE id = $1 LIMIT 1`,
      [id],
    )
    return res.rows[0] ?? null
  }
}
