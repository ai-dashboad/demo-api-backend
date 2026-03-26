import type { GitHubTokenResponse, GitHubUser } from './types.js'

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
export const GITHUB_TOKEN_URL     = 'https://github.com/login/oauth/access_token'
export const GITHUB_API_BASE      = 'https://api.github.com'

export function buildAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  scopes = 'read:user user:email',
): string {
  const params = new URLSearchParams({
    client_id:    clientId,
    redirect_uri: redirectUri,
    scope:        scopes,
    state,
  })
  return `${GITHUB_AUTHORIZE_URL}?${params}`
}

export async function exchangeCodeForToken(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<GitHubTokenResponse> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept:         'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id:     clientId,
      client_secret: clientSecret,
      code,
      redirect_uri:  redirectUri,
    }),
  })

  if (!res.ok) {
    throw new Error(`GitHub token exchange failed: HTTP ${res.status}`)
  }

  const data = await res.json() as GitHubTokenResponse
  if (data.error) {
    throw new Error(`GitHub OAuth error: ${data.error} — ${data.error_description ?? ''}`)
  }

  return data
}

export async function refreshGitHubToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<GitHubTokenResponse> {
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: 'POST',
    headers: {
      Accept:         'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id:     clientId,
      client_secret: clientSecret,
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
    }),
  })

  if (!res.ok) {
    throw new Error(`GitHub token refresh failed: HTTP ${res.status}`)
  }

  const data = await res.json() as GitHubTokenResponse
  if (data.error) {
    throw new Error(`GitHub token refresh error: ${data.error} — ${data.error_description ?? ''}`)
  }

  return data
}

export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser> {
  const res = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization:          `Bearer ${accessToken}`,
      Accept:                 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  })

  if (res.status === 401) {
    throw new Error('GitHub token is invalid or has been revoked')
  }
  if (!res.ok) {
    throw new Error(`Failed to fetch GitHub user: HTTP ${res.status}`)
  }

  return res.json() as Promise<GitHubUser>
}

/**
 * Deletes the token via the GitHub Applications API so it can no longer be used.
 * Uses HTTP Basic auth with the OAuth app credentials (not a Bearer token).
 */
export async function revokeGitHubToken(
  accessToken: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const res = await fetch(`${GITHUB_API_BASE}/applications/${clientId}/token`, {
    method: 'DELETE',
    headers: {
      Authorization:          `Basic ${credentials}`,
      Accept:                 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type':         'application/json',
    },
    body: JSON.stringify({ access_token: accessToken }),
  })

  // 404 means the token was already invalid — acceptable outcome
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to revoke GitHub token: HTTP ${res.status}`)
  }
}
