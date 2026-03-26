export interface GitHubUser {
  id: number
  login: string
  email: string | null
  avatar_url: string
  name: string | null
}

export interface GitHubTokenResponse {
  access_token: string
  token_type: string
  scope: string
  refresh_token?: string
  // GitHub Apps with expiring tokens populate these
  expires_in?: number
  refresh_token_expires_in?: number
  error?: string
  error_description?: string
}

export interface Session {
  id: string
  user_id: string
  github_access_token: string
  refresh_token: string | null
  expires_at: Date
  csrf_token: string
  revoked_at: Date | null
  created_at: Date
}

export interface User {
  id: string
  github_id: string
  login: string
  email: string | null
  avatar_url: string
  created_at: Date
  updated_at: Date
}

export interface AuthConfig {
  github_client_id: string
  github_client_secret: string
  github_redirect_uri: string
  /** Session lifetime in milliseconds. Defaults to 24 hours. */
  session_ttl_ms: number
}
