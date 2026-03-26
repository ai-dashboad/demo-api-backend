import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  GitHubOAuthClient,
  GitHubOAuthError,
  loadGitHubOAuthConfig,
} from '../src/github-oauth.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function setValidEnv() {
  process.env.GITHUB_CLIENT_ID     = 'Iv1.abc123'
  process.env.GITHUB_CLIENT_SECRET = 'super_secret_value'
  process.env.GITHUB_CALLBACK_URL  = 'http://localhost:8080/api/auth/github/callback'
}

function clearOAuthEnv() {
  delete process.env.GITHUB_CLIENT_ID
  delete process.env.GITHUB_CLIENT_SECRET
  delete process.env.GITHUB_CALLBACK_URL
}

// ── loadGitHubOAuthConfig ─────────────────────────────────────────────────────

describe('loadGitHubOAuthConfig', () => {
  afterEach(clearOAuthEnv)

  it('should return parsed config when all env vars are present', () => {
    setValidEnv()
    const config = loadGitHubOAuthConfig()
    expect(config.clientId).toBe('Iv1.abc123')
    expect(config.clientSecret).toBe('super_secret_value')
    expect(config.callbackUrl).toBe('http://localhost:8080/api/auth/github/callback')
  })

  it('should throw GitHubOAuthError when GITHUB_CLIENT_ID is missing', () => {
    setValidEnv()
    delete process.env.GITHUB_CLIENT_ID
    expect(() => loadGitHubOAuthConfig()).toThrow(GitHubOAuthError)
    expect(() => loadGitHubOAuthConfig()).toThrow('GITHUB_CLIENT_ID is required')
  })

  it('should throw GitHubOAuthError when GITHUB_CLIENT_SECRET is missing', () => {
    setValidEnv()
    delete process.env.GITHUB_CLIENT_SECRET
    expect(() => loadGitHubOAuthConfig()).toThrow(GitHubOAuthError)
    expect(() => loadGitHubOAuthConfig()).toThrow('GITHUB_CLIENT_SECRET is required')
  })

  it('should throw GitHubOAuthError when GITHUB_CALLBACK_URL is not a valid URL', () => {
    setValidEnv()
    process.env.GITHUB_CALLBACK_URL = 'not-a-url'
    expect(() => loadGitHubOAuthConfig()).toThrow(GitHubOAuthError)
    expect(() => loadGitHubOAuthConfig()).toThrow('valid URL')
  })
})

// ── GitHubOAuthClient.buildAuthorizationUrl ───────────────────────────────────

describe('GitHubOAuthClient.buildAuthorizationUrl', () => {
  const client = new GitHubOAuthClient({
    clientId:     'Iv1.testclient',
    clientSecret: 'secret',
    callbackUrl:  'http://localhost:8080/api/auth/github/callback',
  })

  it('should include client_id, redirect_uri, state, and default scopes', () => {
    const url = new URL(client.buildAuthorizationUrl('csrf-state-token'))
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
    expect(url.searchParams.get('client_id')).toBe('Iv1.testclient')
    expect(url.searchParams.get('state')).toBe('csrf-state-token')
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:8080/api/auth/github/callback')
    expect(url.searchParams.get('scope')).toContain('repo')
  })

  it('should use custom scopes when provided', () => {
    const url = new URL(client.buildAuthorizationUrl('state', ['read:user']))
    expect(url.searchParams.get('scope')).toBe('read:user')
  })
})

// ── GitHubOAuthClient.exchangeCode ────────────────────────────────────────────

describe('GitHubOAuthClient.exchangeCode', () => {
  const client = new GitHubOAuthClient({
    clientId:     'Iv1.testclient',
    clientSecret: 'secret',
    callbackUrl:  'http://localhost:8080/api/auth/github/callback',
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should return access token on successful exchange', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(new Response(
      JSON.stringify({ access_token: 'ghs_abc123', token_type: 'bearer', scope: 'repo' }),
      { status: 200 },
    ))

    const result = await client.exchangeCode('temp-code')
    expect(result.access_token).toBe('ghs_abc123')
    expect(result.token_type).toBe('bearer')
  })

  it('should throw GitHubOAuthError when GitHub returns an error envelope', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(new Response(
      JSON.stringify({
        error:             'bad_verification_code',
        error_description: 'The code passed is incorrect or expired.',
      }),
      { status: 200 },
    ))

    await expect(client.exchangeCode('invalid-code')).rejects.toThrow(
      'The code passed is incorrect or expired.'
    )
  })

  it('should throw GitHubOAuthError on non-2xx HTTP response', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }))

    await expect(client.exchangeCode('some-code')).rejects.toThrow(
      'Token exchange failed with HTTP 503'
    )
  })
})

// ── GitHubOAuthClient.fetchAuthenticatedUser ──────────────────────────────────

describe('GitHubOAuthClient.fetchAuthenticatedUser', () => {
  const client = new GitHubOAuthClient({
    clientId:     'Iv1.testclient',
    clientSecret: 'secret',
    callbackUrl:  'http://localhost:8080/api/auth/github/callback',
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should return user profile on success', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(new Response(
      JSON.stringify({ id: 42, login: 'octocat', name: 'The Octocat', email: null }),
      { status: 200 },
    ))

    const user = await client.fetchAuthenticatedUser('ghs_token')
    expect(user.login).toBe('octocat')
    expect(user.id).toBe(42)
  })

  it('should throw GitHubOAuthError when the token is invalid (401)', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }))

    await expect(client.fetchAuthenticatedUser('bad-token')).rejects.toThrow(
      'Failed to fetch GitHub user: HTTP 401'
    )
  })
})

// ── GitHubOAuthClient.revokeToken ─────────────────────────────────────────────

describe('GitHubOAuthClient.revokeToken', () => {
  const client = new GitHubOAuthClient({
    clientId:     'Iv1.testclient',
    clientSecret: 'secret',
    callbackUrl:  'http://localhost:8080/api/auth/github/callback',
  })

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should resolve without error on 204 (successful revocation)', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }))

    await expect(client.revokeToken('ghs_token')).resolves.toBeUndefined()
  })

  it('should resolve without error on 404 (token already gone)', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(new Response('Not Found', { status: 404 }))

    await expect(client.revokeToken('stale-token')).resolves.toBeUndefined()
  })

  it('should throw GitHubOAuthError on unexpected failure status', async () => {
    const mockFetch = vi.mocked(fetch)
    mockFetch.mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }))

    await expect(client.revokeToken('ghs_token')).rejects.toThrow(
      'Token revocation failed: HTTP 500'
    )
  })
})
