import type { SecretsManager } from './manager.js';

// Secret key names — treated as stable identifiers; do not rename after first write.
export const SECRET_GITHUB_OAUTH_CLIENT_ID = 'github.oauth.client_id';
export const SECRET_GITHUB_OAUTH_CLIENT_SECRET = 'github.oauth.client_secret';

export interface GitHubOAuthCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * Stores GitHub OAuth app credentials in the encrypted secrets store.
 *
 * === How to register the GitHub OAuth app ===
 *
 * 1. Go to https://github.com/settings/developers → "OAuth Apps" → "New OAuth App"
 * 2. Fill in:
 *    - Application name: OpenDev (or your deployment name)
 *    - Homepage URL: https://<your-domain>
 *    - Authorization callback URL (REQUIRED):
 *        https://<your-domain>/api/auth/github/callback
 *      For local development:
 *        http://localhost:8080/api/auth/github/callback
 *      The path must exactly match what the API server handles — any mismatch
 *      causes GitHub to reject the OAuth flow with a redirect_uri_mismatch error.
 * 3. Click "Register application".
 * 4. Copy the Client ID shown on the app page.
 * 5. Click "Generate a new client secret" and copy it immediately — it is
 *    shown only once.
 * 6. Call storeGitHubOAuthCredentials() with those values.
 *
 * The redirect URI is validated by GitHub on every OAuth request. If you add
 * additional deployment environments, register a separate OAuth app per
 * environment rather than registering multiple callback URLs — GitHub only
 * supports one callback URL per OAuth app registration.
 */
export async function storeGitHubOAuthCredentials(
  secrets: SecretsManager,
  credentials: GitHubOAuthCredentials,
): Promise<void> {
  if (!credentials.clientId.trim()) {
    throw new Error('GitHub OAuth client ID must not be empty');
  }
  if (!credentials.clientSecret.trim()) {
    throw new Error('GitHub OAuth client secret must not be empty');
  }
  await secrets.set(SECRET_GITHUB_OAUTH_CLIENT_ID, credentials.clientId.trim());
  await secrets.set(SECRET_GITHUB_OAUTH_CLIENT_SECRET, credentials.clientSecret.trim());
}

/**
 * Loads GitHub OAuth app credentials from the encrypted secrets store.
 * Throws if either credential has not been stored yet.
 */
export async function loadGitHubOAuthCredentials(
  secrets: SecretsManager,
): Promise<GitHubOAuthCredentials> {
  const [clientId, clientSecret] = await Promise.all([
    secrets.get(SECRET_GITHUB_OAUTH_CLIENT_ID),
    secrets.get(SECRET_GITHUB_OAUTH_CLIENT_SECRET),
  ]);

  if (!clientId || !clientSecret) {
    const missing = [
      !clientId && SECRET_GITHUB_OAUTH_CLIENT_ID,
      !clientSecret && SECRET_GITHUB_OAUTH_CLIENT_SECRET,
    ]
      .filter(Boolean)
      .join(', ');
    throw new Error(
      `GitHub OAuth credentials not configured (missing: ${missing}). ` +
      'Store them with storeGitHubOAuthCredentials() before starting the OAuth flow.',
    );
  }

  return { clientId, clientSecret };
}

/**
 * Returns true if GitHub OAuth credentials are present in the store.
 * Use this for health-check or setup-wizard flows.
 */
export async function hasGitHubOAuthCredentials(
  secrets: SecretsManager,
): Promise<boolean> {
  const [clientId, clientSecret] = await Promise.all([
    secrets.get(SECRET_GITHUB_OAUTH_CLIENT_ID),
    secrets.get(SECRET_GITHUB_OAUTH_CLIENT_SECRET),
  ]);
  return Boolean(clientId && clientSecret);
}
