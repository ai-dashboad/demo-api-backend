import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifyToken, JwtError, type VerifiedToken, type VerifyOptions } from './jwt.js';

export interface AuthenticatedRequest extends IncomingMessage {
  /** Decoded and verified JWT, attached by createAuthMiddleware */
  auth: VerifiedToken;
}

/** Express / Node http compatible next() signature */
export type NextFn = (err?: Error) => void;

export type AuthMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next: NextFn,
) => void;

export interface AuthMiddlewareOptions extends VerifyOptions {
  /**
   * Override how the raw JWT string is extracted from a request.
   * Defaults to the Authorization: Bearer <token> header.
   */
  tokenExtractor?: (req: IncomingMessage) => string | null;
}

function bearerTokenExtractor(req: IncomingMessage): string | null {
  const header = req.headers['authorization'];
  if (!header) return null;

  // Must be exactly "Bearer <token>" — no other scheme accepted
  const spaceIndex = header.indexOf(' ');
  if (spaceIndex === -1) return null;

  const scheme = header.slice(0, spaceIndex);
  if (scheme.toLowerCase() !== 'bearer') return null;

  const token = header.slice(spaceIndex + 1).trim();
  return token.length > 0 ? token : null;
}

function rejectUnauthorized(res: ServerResponse, reason: string): void {
  const body = JSON.stringify({ error: 'Unauthorized', reason });
  res.writeHead(401, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    // Tell clients this endpoint requires Bearer tokens
    'WWW-Authenticate': 'Bearer realm="opendev"',
  });
  res.end(body);
}

/**
 * Creates HTTP middleware that enforces RS256 JWT authentication.
 *
 * On success: attaches the decoded token to req.auth and calls next().
 * On failure: responds with 401 JSON and does NOT call next().
 *
 * @param publicKey PEM-encoded RSA public key used to verify signatures.
 * @param options   Optional issuer/audience validation and token extraction.
 */
export function createAuthMiddleware(
  publicKey: string,
  options: AuthMiddlewareOptions = {},
): AuthMiddleware {
  const { tokenExtractor = bearerTokenExtractor, ...verifyOptions } = options;

  return function authMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: NextFn,
  ): void {
    const token = tokenExtractor(req);

    if (!token) {
      rejectUnauthorized(res, 'Missing or malformed Authorization header');
      return;
    }

    try {
      const verified = verifyToken(token, publicKey, verifyOptions);
      (req as AuthenticatedRequest).auth = verified;
      next();
    } catch (err) {
      if (err instanceof JwtError) {
        rejectUnauthorized(res, err.message);
      } else {
        // Unexpected error — pass to Express/Node error handler
        next(err instanceof Error ? err : new Error(String(err)));
      }
    }
  };
}
