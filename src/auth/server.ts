import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { Pool } from 'pg'
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGitHubUser,
  refreshGitHubToken,
} from './github-oauth.js'
import { SessionStore } from './session-store.js'
import { generateCsrfState, validateCsrfState } from './csrf.js'
import type { AuthConfig } from './types.js'

const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1_000 // 24 hours

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type':   'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers['authorization']
  if (!auth?.startsWith('Bearer ')) return null
  const token = auth.slice(7).trim()
  return token.length > 0 ? token : null
}

export function createAuthServer(db: Pool, config: AuthConfig) {
  const store = new SessionStore(db)
  const ttl   = config.session_ttl_ms ?? DEFAULT_SESSION_TTL_MS

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(
      req.url ?? '/',
      `http://${req.headers.host ?? 'localhost'}`,
    )

    try {
      // ── GET /auth/github — kick off OAuth flow ──────────────────────────────
      if (req.method === 'GET' && url.pathname === '/auth/github') {
        const state       = generateCsrfState()
        const redirectUrl = buildAuthorizeUrl(
          config.github_client_id,
          config.github_redirect_uri,
          state,
        )
        res.writeHead(302, { Location: redirectUrl })
        res.end()
        return
      }

      // ── GET /auth/github/callback — exchange code, create session ───────────
      if (req.method === 'GET' && url.pathname === '/auth/github/callback') {
        const code  = url.searchParams.get('code')
        const state = url.searchParams.get('state')

        if (!state || !validateCsrfState(state)) {
          sendJson(res, 403, {
            error:   'invalid_csrf_state',
            message: 'CSRF state is missing, invalid, or has already been used',
          })
          return
        }

        if (!code) {
          sendJson(res, 400, { error: 'missing_code', message: 'OAuth code is required' })
          return
        }

        const tokenData = await exchangeCodeForToken(
          code,
          config.github_client_id,
          config.github_client_secret,
          config.github_redirect_uri,
        )

        const ghUser = await fetchGitHubUser(tokenData.access_token)
        const user   = await store.upsertUser(
          ghUser.id,
          ghUser.login,
          ghUser.email,
          ghUser.avatar_url,
        )

        const session = await store.createSession(
          user.id,
          tokenData.access_token,
          tokenData.refresh_token ?? null,
          ttl,
        )

        sendJson(res, 200, {
          session_id: session.id,
          csrf_token: session.csrf_token,
          expires_at: session.expires_at,
          user: {
            id:         user.id,
            login:      user.login,
            email:      user.email,
            avatar_url: user.avatar_url,
          },
        })
        return
      }

      // ── POST /auth/refresh — extend session with a fresh GitHub token ───────
      if (req.method === 'POST' && url.pathname === '/auth/refresh') {
        const sessionId = extractBearerToken(req)
        if (!sessionId) {
          sendJson(res, 401, { error: 'unauthenticated', message: 'Bearer token required' })
          return
        }

        const session = await store.getSession(sessionId)
        if (!session) {
          sendJson(res, 401, { error: 'session_not_found', message: 'Session does not exist' })
          return
        }
        if (session.revoked_at) {
          sendJson(res, 401, { error: 'session_revoked', message: 'Session has been revoked' })
          return
        }
        if (new Date(session.expires_at) <= new Date()) {
          sendJson(res, 401, { error: 'session_expired', message: 'Session has expired' })
          return
        }
        if (!session.refresh_token) {
          sendJson(res, 400, { error: 'no_refresh_token', message: 'No refresh token available for this session' })
          return
        }

        const tokenData = await refreshGitHubToken(
          session.refresh_token,
          config.github_client_id,
          config.github_client_secret,
        )

        const updated = await store.updateSessionToken(
          sessionId,
          tokenData.access_token,
          tokenData.refresh_token ?? null,
          ttl,
        )

        sendJson(res, 200, {
          session_id: sessionId,
          expires_at: updated?.expires_at,
        })
        return
      }

      // ── POST /auth/logout — revoke session ──────────────────────────────────
      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        const sessionId = extractBearerToken(req)
        if (!sessionId) {
          sendJson(res, 401, { error: 'unauthenticated', message: 'Bearer token required' })
          return
        }

        await store.revokeSession(sessionId)
        sendJson(res, 200, { ok: true })
        return
      }

      // ── GET /auth/me — return authenticated user ─────────────────────────────
      if (req.method === 'GET' && url.pathname === '/auth/me') {
        const sessionId = extractBearerToken(req)
        if (!sessionId) {
          sendJson(res, 401, { error: 'unauthenticated', message: 'Bearer token required' })
          return
        }

        const session = await store.getSession(sessionId)
        if (!session) {
          sendJson(res, 401, { error: 'session_not_found', message: 'Session does not exist' })
          return
        }
        if (session.revoked_at) {
          sendJson(res, 401, { error: 'session_revoked', message: 'Session has been revoked' })
          return
        }
        if (new Date(session.expires_at) <= new Date()) {
          sendJson(res, 401, { error: 'session_expired', message: 'Session has expired' })
          return
        }

        const user = await store.getUser(session.user_id)
        if (!user) {
          sendJson(res, 404, { error: 'user_not_found', message: 'User record not found' })
          return
        }

        sendJson(res, 200, {
          id:         user.id,
          login:      user.login,
          email:      user.email,
          avatar_url: user.avatar_url,
        })
        return
      }

      sendJson(res, 404, { error: 'not_found' })
    } catch (err) {
      console.error('[auth-server] Unhandled error:', err)
      sendJson(res, 500, { error: 'internal_error', message: String(err) })
    }
  })

  return { server, store }
}
