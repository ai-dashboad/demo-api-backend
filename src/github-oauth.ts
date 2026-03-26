import { z } from 'zod'

// ── Config schema ─────────────────────────────────────────────────────────────

const GitHubOAuthConfigSchema = z.object({
  clientId:     z.string().min(1, 'GITHUB_CLIENT_ID is required'),
  clientSecret: z.string().min(1, 'GITHUB_CLIENT_SECRET is required'),
  callbackUrl:  z.string().url('GITHUB_CALLBACK_URL must be a valid URL'),
})

export type GitHubOAuthConfig = z.infer<typeof GitHubOAuthConfigSchema>

// ── Token exchange response ────────────────────────────────────────────────────

const AccessTokenResponseSchema = z.object({
  access_token: z.string(),
  token_type:   z.string(),
  scope:        z.string().optional(),
})

export type AccessTokenResponse = z.infer<typeof AccessTokenResponseSchema>

// ── GitHub user returned after token exchange ─────────────────────────────────

const GitHubUserSchema = z.object({
  id:         z.number(),
  login:      z.string(),
  name:       z.string().nullable().optional(),
  email:      z.string().nullable().optional(),
  avatar_url: z.string().optional(),
})

export type GitHubUser = z.infer<typeof GitHubUserSchema>

// ── OAuth error ───────────────────────────────────────────────────────────────

export class GitHubOAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message)
    this.name = 'GitHubOAuthError'
  }
}

// ── Config loader ─────────────────────────────────────────────────────────────

export function loadGitHubOAuthConfig(): GitHubOAuthConfig {
  const result = GitHubOAuthConfigSchema.safeParse({
    clientId:     process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    callbackUrl:  process.env.GITHUB_CALLBACK_URL,
  })

  if (!result.success) {
    const issues = result.error.issues.map(i => `  • ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new GitHubOAuthError(
      `GitHub OAuth misconfigured:\n${issues}`,
      'CONFIG_INVALID',
    )
  }

  return result.data
}

// ── OAuth client ──────────────────────────────────────────────────────────────

export class GitHubOAuthClient {
  private readonly config: GitHubOAuthConfig

  constructor(config?: GitHubOAuthConfig) {
    this.config = config ?? loadGitHubOAuthConfig()
  }

  /**
   * Builds the GitHub authorization URL that the frontend redirects users to.
   * State should be a cryptographically random value stored in the session to
   * prevent CSRF attacks.
   */
  buildAuthorizationUrl(state: string, scopes: string[] = ['repo', 'read:org', 'workflow']): string {
    const params = new URLSearchParams({
      client_id:    this.config.clientId,
      redirect_uri: this.config.callbackUrl,
      scope:        scopes.join(' '),
      state,
    })
    return `https://github.com/login/oauth/authorize?${params.toString()}`
  }

  /**
   * Exchanges the short-lived authorization code for a long-lived access token.
   * Called server-side after GitHub redirects back to GITHUB_CALLBACK_URL.
   */
  async exchangeCode(code: string): Promise<AccessTokenResponse> {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept':       'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id:     this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri:  this.config.callbackUrl,
      }),
    })

    if (!res.ok) {
      throw new GitHubOAuthError(
        `Token exchange failed with HTTP ${res.status}`,
        'EXCHANGE_HTTP_ERROR',
      )
    }

    const body = await res.json() as Record<string, unknown>

    // GitHub returns 200 with an error field on invalid codes
    if (body.error) {
      throw new GitHubOAuthError(
        `Token exchange rejected: ${body.error_description ?? body.error}`,
        String(body.error),
      )
    }

    const parsed = AccessTokenResponseSchema.safeParse(body)
    if (!parsed.success) {
      throw new GitHubOAuthError(
        'Unexpected token exchange response shape',
        'EXCHANGE_PARSE_ERROR',
      )
    }

    return parsed.data
  }

  /**
   * Fetches the authenticated GitHub user's profile using their access token.
   * Use this to resolve the token to a workspace/user identity after exchange.
   */
  async fetchAuthenticatedUser(accessToken: string): Promise<GitHubUser> {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization:        `Bearer ${accessToken}`,
        Accept:               'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    })

    if (!res.ok) {
      throw new GitHubOAuthError(
        `Failed to fetch GitHub user: HTTP ${res.status}`,
        'USER_FETCH_ERROR',
      )
    }

    const body = await res.json() as Record<string, unknown>
    const parsed = GitHubUserSchema.safeParse(body)
    if (!parsed.success) {
      throw new GitHubOAuthError(
        'Unexpected GitHub user response shape',
        'USER_PARSE_ERROR',
      )
    }

    return parsed.data
  }

  /**
   * Revokes an OAuth access token so it can no longer be used.
   * Call this on workspace disconnect or user sign-out.
   */
  async revokeToken(accessToken: string): Promise<void> {
    const credentials = Buffer.from(
      `${this.config.clientId}:${this.config.clientSecret}`,
    ).toString('base64')

    const res = await fetch(
      `https://api.github.com/applications/${this.config.clientId}/token`,
      {
        method: 'DELETE',
        headers: {
          Authorization:        `Basic ${credentials}`,
          Accept:               'application/vnd.github+json',
          'Content-Type':       'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ access_token: accessToken }),
      },
    )

    // 204 = success, 404 = token already gone — both are acceptable
    if (!res.ok && res.status !== 404) {
      throw new GitHubOAuthError(
        `Token revocation failed: HTTP ${res.status}`,
        'REVOKE_ERROR',
      )
    }
  }
}
