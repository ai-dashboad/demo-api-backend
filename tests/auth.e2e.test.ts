import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Pool } from 'pg'
import type { AddressInfo } from 'net'
import { createAuthServer } from '../src/auth/server.js'
import { clearPendingStates } from '../src/auth/csrf.js'
import type { SessionStore } from '../src/auth/session-store.js'

// ---------------------------------------------------------------------------
// Test database — separate DB from dev to allow destructive DDL
// ---------------------------------------------------------------------------
const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgres://opendev:opendev_secret@localhost:5432/opendev_test'

// ---------------------------------------------------------------------------
// GitHub OAuth stub constants
// ---------------------------------------------------------------------------
const STUB_ACCESS_TOKEN  = 'ghs_stub_access_token_abc123'
const STUB_REFRESH_TOKEN = 'ghr_stub_refresh_token_xyz789'
const STUB_CLIENT_ID     = 'test_github_client_id'
const STUB_CLIENT_SECRET = 'test_github_client_secret'
const STUB_REDIRECT_URI  = 'http://localhost:3000/auth/github/callback'

const STUB_GITHUB_USER = {
  id:         123456,
  login:      'testuser',
  email:      'test@example.com',
  avatar_url: 'https://avatars.githubusercontent.com/u/123456',
  name:       'Test User',
}

// ---------------------------------------------------------------------------
// Fetch stubbing
//
// Both the test client and the server share the same process, so stubbing
// globalThis.fetch intercepts all fetch calls.  We capture the real fetch
// before any stub is installed and use it to pass through calls to the local
// test server, while returning canned responses for github.com URLs.
// ---------------------------------------------------------------------------
let realFetch: typeof fetch

type StubMap = Record<string, { status: number; body: unknown }>

const DEFAULT_GITHUB_STUBS: StubMap = {
  'https://github.com/login/oauth/access_token': {
    status: 200,
    body: {
      access_token:  STUB_ACCESS_TOKEN,
      refresh_token: STUB_REFRESH_TOKEN,
      token_type:    'bearer',
      scope:         'read:user,user:email',
      expires_in:    28800,
    },
  },
  'https://api.github.com/user': {
    status: 200,
    body: STUB_GITHUB_USER,
  },
}

function installFetchStub(overrides: StubMap = {}): void {
  const stubs = { ...DEFAULT_GITHUB_STUBS, ...overrides }

  vi.stubGlobal('fetch', async (url: RequestInfo | URL, opts?: RequestInit) => {
    const urlStr = url instanceof Request ? url.url : String(url)

    // Pass local test-server calls through to the real network stack
    if (urlStr.startsWith('http://127.0.0.1') || urlStr.startsWith('http://localhost')) {
      return realFetch(url as RequestInfo, opts)
    }

    // Match against stub keys by prefix so query strings are ignored
    const matchKey = Object.keys(stubs).find(k => urlStr.startsWith(k))
    if (!matchKey) {
      throw new Error(`[fetch-stub] Unexpected external fetch to: ${urlStr}`)
    }

    const { status, body } = stubs[matchKey]
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  })
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

describe('GitHub OAuth E2E auth flow', () => {
  let db: Pool
  let baseUrl: string
  let closeServer: () => Promise<void>
  let store: SessionStore

  beforeAll(async () => {
    // Must capture before any vi.stubGlobal call replaces it
    realFetch = globalThis.fetch

    db = new Pool({ connectionString: TEST_DB_URL })

    // Ensure tables exist — SessionStore.migrate() is idempotent
    const { store: s, server } = createAuthServer(db, {
      github_client_id:     STUB_CLIENT_ID,
      github_client_secret: STUB_CLIENT_SECRET,
      github_redirect_uri:  STUB_REDIRECT_URI,
      session_ttl_ms:       60 * 60 * 1_000, // 1 hour
    })
    store = s
    await store.migrate()

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`

    closeServer = () =>
      new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve()))
      )
  })

  afterAll(async () => {
    // Drop test tables in dependency order
    await db.query('DROP TABLE IF EXISTS auth_sessions')
    await db.query('DROP TABLE IF EXISTS auth_users')
    await closeServer()
    await db.end()
  })

  beforeEach(async () => {
    // Isolate every test: clean data, reset CSRF state, restore fetch
    await db.query('DELETE FROM auth_sessions')
    await db.query('DELETE FROM auth_users')
    clearPendingStates()
    vi.restoreAllMocks()
  })

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Hits GET /auth/github and returns the CSRF state embedded in the redirect. */
  async function startOAuthFlow(): Promise<string> {
    // Do NOT use the stubbed fetch here — this call is to the local server
    const res      = await realFetch(`${baseUrl}/auth/github`, { redirect: 'manual' })
    const location = res.headers.get('location') ?? ''
    const state    = new URL(location).searchParams.get('state')
    if (!state) throw new Error('No state in GitHub redirect URL')
    return state
  }

  /** Completes the OAuth callback with a stubbed GitHub API and returns the session payload. */
  async function completeOAuthCallback(
    state: string,
    overrides: StubMap = {},
  ): Promise<{ session_id: string; csrf_token: string; user: { id: string; login: string; email: string } }> {
    installFetchStub(overrides)
    const res = await fetch(`${baseUrl}/auth/github/callback?code=valid_code&state=${state}`)
    vi.restoreAllMocks()
    if (res.status !== 200) {
      const body = await res.json()
      throw new Error(`OAuth callback failed ${res.status}: ${JSON.stringify(body)}`)
    }
    return res.json()
  }

  // ── Happy path ────────────────────────────────────────────────────────────

  describe('happy path: GitHub OAuth login', () => {
    it('should redirect to GitHub authorize URL', async () => {
      const res      = await realFetch(`${baseUrl}/auth/github`, { redirect: 'manual' })
      const location = res.headers.get('location') ?? ''

      expect(res.status).toBe(302)
      expect(location).toContain('https://github.com/login/oauth/authorize')
      expect(location).toContain(`client_id=${STUB_CLIENT_ID}`)
    })

    it('should include scopes and a CSRF state in the redirect URL', async () => {
      const res      = await realFetch(`${baseUrl}/auth/github`, { redirect: 'manual' })
      const location = decodeURIComponent(res.headers.get('location') ?? '')

      expect(location).toContain('read:user')
      expect(location).toMatch(/state=[a-f0-9]{64}/)
    })

    it('should return session_id, csrf_token, and user on successful callback', async () => {
      const state = await startOAuthFlow()
      installFetchStub()
      const res  = await fetch(`${baseUrl}/auth/github/callback?code=valid_code&state=${state}`)
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.session_id).toMatch(/^[a-f0-9]{64}$/)
      expect(body.csrf_token).toMatch(/^[a-f0-9]{64}$/)
      expect(body.user.login).toBe('testuser')
      expect(body.user.email).toBe('test@example.com')
    })

    it('should persist the session in the database', async () => {
      const state      = await startOAuthFlow()
      const { session_id } = await completeOAuthCallback(state)

      const row = await db.query(
        'SELECT * FROM auth_sessions WHERE id = $1',
        [session_id],
      )
      expect(row.rows).toHaveLength(1)
      expect(row.rows[0].github_access_token).toBe(STUB_ACCESS_TOKEN)
      expect(row.rows[0].revoked_at).toBeNull()
    })

    it('should upsert the GitHub user into the database', async () => {
      const state = await startOAuthFlow()
      await completeOAuthCallback(state)

      const row = await db.query(
        `SELECT * FROM auth_users WHERE github_id = '123456'`,
      )
      expect(row.rows).toHaveLength(1)
      expect(row.rows[0].login).toBe('testuser')
    })

    it('should return the current user from GET /auth/me with a valid session', async () => {
      const state          = await startOAuthFlow()
      const { session_id } = await completeOAuthCallback(state)

      const res  = await fetch(`${baseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${session_id}` },
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.login).toBe('testuser')
      expect(body.email).toBe('test@example.com')
    })

    it('should re-use the same user record when the same GitHub account logs in twice', async () => {
      const state1 = await startOAuthFlow()
      await completeOAuthCallback(state1)

      const state2 = await startOAuthFlow()
      await completeOAuthCallback(state2)

      const rows = await db.query(`SELECT * FROM auth_users WHERE github_id = '123456'`)
      expect(rows.rows).toHaveLength(1) // upsert, not double-insert
    })
  })

  // ── Token refresh ─────────────────────────────────────────────────────────

  describe('token refresh', () => {
    it('should issue a refreshed access token and extend the session expiry', async () => {
      const state          = await startOAuthFlow()
      const { session_id } = await completeOAuthCallback(state)

      installFetchStub({
        'https://github.com/login/oauth/access_token': {
          status: 200,
          body: {
            access_token:  'ghs_refreshed_new_token',
            refresh_token: 'ghr_new_refresh_token',
            token_type:    'bearer',
            scope:         'read:user',
          },
        },
      })

      const res  = await fetch(`${baseUrl}/auth/refresh`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${session_id}` },
      })
      const body = await res.json()

      expect(res.status).toBe(200)
      expect(body.session_id).toBe(session_id)
      expect(body.expires_at).toBeTruthy()
    })

    it('should update the stored access token after refresh', async () => {
      const state          = await startOAuthFlow()
      const { session_id } = await completeOAuthCallback(state)

      installFetchStub({
        'https://github.com/login/oauth/access_token': {
          status: 200,
          body: { access_token: 'ghs_updated', refresh_token: 'ghr_updated', token_type: 'bearer', scope: '' },
        },
      })
      await fetch(`${baseUrl}/auth/refresh`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${session_id}` },
      })
      vi.restoreAllMocks()

      const row = await db.query(
        'SELECT github_access_token FROM auth_sessions WHERE id = $1',
        [session_id],
      )
      expect(row.rows[0].github_access_token).toBe('ghs_updated')
    })

    it('should return 401 when no Authorization header is provided to refresh', async () => {
      const res = await fetch(`${baseUrl}/auth/refresh`, { method: 'POST' })
      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('unauthenticated')
    })

    it('should return 401 when the session does not exist', async () => {
      const res = await fetch(`${baseUrl}/auth/refresh`, {
        method:  'POST',
        headers: { Authorization: 'Bearer completely_unknown_session_id' },
      })
      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('session_not_found')
    })
  })

  // ── Logout ────────────────────────────────────────────────────────────────

  describe('logout', () => {
    it('should return { ok: true } on successful logout', async () => {
      const state          = await startOAuthFlow()
      const { session_id } = await completeOAuthCallback(state)

      const res = await fetch(`${baseUrl}/auth/logout`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${session_id}` },
      })
      expect(res.status).toBe(200)
      expect((await res.json()).ok).toBe(true)
    })

    it('should mark the session as revoked in the database', async () => {
      const state          = await startOAuthFlow()
      const { session_id } = await completeOAuthCallback(state)

      await fetch(`${baseUrl}/auth/logout`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${session_id}` },
      })

      const row = await db.query(
        'SELECT revoked_at FROM auth_sessions WHERE id = $1',
        [session_id],
      )
      expect(row.rows[0].revoked_at).not.toBeNull()
    })

    it('should reject /auth/me with 401 session_revoked after logout', async () => {
      const state          = await startOAuthFlow()
      const { session_id } = await completeOAuthCallback(state)

      await fetch(`${baseUrl}/auth/logout`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${session_id}` },
      })

      const me = await fetch(`${baseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${session_id}` },
      })
      expect(me.status).toBe(401)
      expect((await me.json()).error).toBe('session_revoked')
    })

    it('should reject /auth/refresh with 401 session_revoked after logout', async () => {
      const state          = await startOAuthFlow()
      const { session_id } = await completeOAuthCallback(state)

      await fetch(`${baseUrl}/auth/logout`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${session_id}` },
      })

      const refresh = await fetch(`${baseUrl}/auth/refresh`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${session_id}` },
      })
      expect(refresh.status).toBe(401)
      expect((await refresh.json()).error).toBe('session_revoked')
    })

    it('should return 401 when logging out without Authorization header', async () => {
      const res = await fetch(`${baseUrl}/auth/logout`, { method: 'POST' })
      expect(res.status).toBe(401)
    })
  })

  // ── Expired token rejection ───────────────────────────────────────────────

  describe('expired token rejection', () => {
    async function insertExpiredSession(userId: string, sessionId: string): Promise<void> {
      const pastDate = new Date(Date.now() - 1_000) // 1 second in the past
      await db.query(
        `INSERT INTO auth_sessions
           (id, user_id, github_access_token, refresh_token, expires_at, csrf_token)
         VALUES ($1, $2, 'tok', 'ref', $3, 'csrf')`,
        [sessionId, userId, pastDate],
      )
    }

    it('should return 401 session_expired on GET /auth/me with an expired session', async () => {
      const user = await store.upsertUser(77001, 'expireduser', null, '')
      await insertExpiredSession(user.id, 'expired_me_session')

      const res = await fetch(`${baseUrl}/auth/me`, {
        headers: { Authorization: 'Bearer expired_me_session' },
      })
      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('session_expired')
    })

    it('should return 401 session_expired on POST /auth/refresh with an expired session', async () => {
      const user = await store.upsertUser(77002, 'expireduser2', null, '')
      await insertExpiredSession(user.id, 'expired_refresh_session')

      const res = await fetch(`${baseUrl}/auth/refresh`, {
        method:  'POST',
        headers: { Authorization: 'Bearer expired_refresh_session' },
      })
      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('session_expired')
    })

    it('should allow logout of an expired session (clean-up is always permitted)', async () => {
      const user = await store.upsertUser(77003, 'expireduser3', null, '')
      await insertExpiredSession(user.id, 'expired_logout_session')

      // Logout is a fire-and-forget revocation — we do not check expiry
      const res = await fetch(`${baseUrl}/auth/logout`, {
        method:  'POST',
        headers: { Authorization: 'Bearer expired_logout_session' },
      })
      expect(res.status).toBe(200)
    })
  })

  // ── Revoked token rejection ───────────────────────────────────────────────

  describe('revoked token rejection', () => {
    it('should return 401 session_revoked on GET /auth/me when token was revoked server-side', async () => {
      const state          = await startOAuthFlow()
      const { session_id } = await completeOAuthCallback(state)

      // Simulate server-side revocation (e.g. admin action, security event)
      await db.query(
        'UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1',
        [session_id],
      )

      const res = await fetch(`${baseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${session_id}` },
      })
      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('session_revoked')
    })

    it('should return 401 session_revoked on POST /auth/refresh when token was revoked server-side', async () => {
      const state          = await startOAuthFlow()
      const { session_id } = await completeOAuthCallback(state)

      await db.query(
        'UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1',
        [session_id],
      )

      const res = await fetch(`${baseUrl}/auth/refresh`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${session_id}` },
      })
      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('session_revoked')
    })

    it('should return 401 for a bearer token that was never issued', async () => {
      const res = await fetch(`${baseUrl}/auth/me`, {
        headers: { Authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      })
      expect(res.status).toBe(401)
      expect((await res.json()).error).toBe('session_not_found')
    })
  })

  // ── CSRF rejection ────────────────────────────────────────────────────────

  describe('CSRF rejection', () => {
    it('should return 403 invalid_csrf_state when state param is missing', async () => {
      const res = await fetch(`${baseUrl}/auth/github/callback?code=valid_code`)
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe('invalid_csrf_state')
    })

    it('should return 403 invalid_csrf_state when state is not in pending store', async () => {
      const res = await fetch(
        `${baseUrl}/auth/github/callback?code=valid_code&state=totally_fabricated_state_value`,
      )
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe('invalid_csrf_state')
    })

    it('should return 403 invalid_csrf_state when a valid state is replayed a second time', async () => {
      const state = await startOAuthFlow()
      // First use — consumes the state
      await completeOAuthCallback(state)

      // Second use with the same state — must be rejected even though first succeeded
      installFetchStub()
      const res = await fetch(
        `${baseUrl}/auth/github/callback?code=valid_code&state=${state}`,
      )
      expect(res.status).toBe(403)
      expect((await res.json()).error).toBe('invalid_csrf_state')
    })

    it('should generate a unique CSRF state for every OAuth flow initiation', async () => {
      const res1   = await realFetch(`${baseUrl}/auth/github`, { redirect: 'manual' })
      const res2   = await realFetch(`${baseUrl}/auth/github`, { redirect: 'manual' })
      const state1 = new URL(res1.headers.get('location')!).searchParams.get('state')
      const state2 = new URL(res2.headers.get('location')!).searchParams.get('state')

      expect(state1).toBeTruthy()
      expect(state2).toBeTruthy()
      expect(state1).not.toBe(state2)
    })

    it('should return 403 when a state looks valid but has expired (cleared from store)', async () => {
      // Simulate expiry by clearing all pending states after generation
      const res   = await realFetch(`${baseUrl}/auth/github`, { redirect: 'manual' })
      const state = new URL(res.headers.get('location')!).searchParams.get('state')!

      clearPendingStates() // evict the state, mimicking TTL expiry

      const callback = await fetch(
        `${baseUrl}/auth/github/callback?code=valid_code&state=${state}`,
      )
      expect(callback.status).toBe(403)
      expect((await callback.json()).error).toBe('invalid_csrf_state')
    })
  })
})
