import { createSign, createVerify, KeyObject } from 'node:crypto';

export type JwtErrorCode =
  | 'MALFORMED'
  | 'EXPIRED'
  | 'NOT_YET_VALID'
  | 'INVALID_SIGNATURE'
  | 'INVALID_AUDIENCE'
  | 'INVALID_ISSUER';

export class JwtError extends Error {
  readonly code: JwtErrorCode;

  constructor(message: string, code: JwtErrorCode) {
    super(message);
    this.name = 'JwtError';
    this.code = code;
  }
}

export interface JwtHeader {
  alg: 'RS256';
  typ: 'JWT';
}

export interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  [key: string]: unknown;
}

export interface VerifiedToken {
  header: JwtHeader;
  payload: JwtPayload;
}

export interface SignOptions {
  /** Token lifetime in seconds */
  expiresIn?: number;
  issuer?: string;
  audience?: string | string[];
  subject?: string;
}

export interface VerifyOptions {
  issuer?: string;
  audience?: string | string[];
  /** Clock skew tolerance in seconds (default: 0) */
  clockSkew?: number;
}

function base64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function base64urlDecode(input: string): Buffer {
  // base64url → base64: replace URL-safe chars, restore padding
  const standard = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function safeJsonParse<T>(buf: Buffer, context: string): T {
  try {
    return JSON.parse(buf.toString('utf8')) as T;
  } catch {
    throw new JwtError(`Malformed token: invalid ${context} encoding`, 'MALFORMED');
  }
}

/**
 * Signs a JWT using RS256 (RSA + SHA-256).
 * The private key must be a PEM-encoded PKCS#8 or PKCS#1 RSA key, or a KeyObject.
 */
export function signToken(
  payload: JwtPayload,
  privateKey: string | KeyObject,
  options: SignOptions = {},
): string {
  const now = Math.floor(Date.now() / 1000);

  const claims: JwtPayload = { iat: now, ...payload };

  if (options.expiresIn !== undefined) claims.exp = now + options.expiresIn;
  if (options.issuer !== undefined) claims.iss = options.issuer;
  if (options.audience !== undefined) claims.aud = options.audience;
  if (options.subject !== undefined) claims.sub = options.subject;

  const header: JwtHeader = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = base64urlEncode(JSON.stringify(header));
  const encodedPayload = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = createSign('RSA-SHA256');
  signer.update(signingInput, 'utf8');
  const rawSignature = signer.sign(privateKey);

  return `${signingInput}.${base64urlEncode(rawSignature)}`;
}

/**
 * Verifies an RS256 JWT and returns the decoded header and payload.
 * Throws JwtError with a specific code for every failure mode so callers
 * can respond differently (e.g. 401 vs 403).
 */
export function verifyToken(
  token: string,
  publicKey: string | KeyObject,
  options: VerifyOptions = {},
): VerifiedToken {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new JwtError('Malformed token: expected header.payload.signature', 'MALFORMED');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const header = safeJsonParse<JwtHeader>(base64urlDecode(encodedHeader), 'header');
  if (header.alg !== 'RS256') {
    // Reject algorithm substitution attacks
    throw new JwtError(
      `Unsupported algorithm "${header.alg}": only RS256 is accepted`,
      'MALFORMED',
    );
  }

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const rawSignature = base64urlDecode(encodedSignature);

  const verifier = createVerify('RSA-SHA256');
  verifier.update(signingInput, 'utf8');

  let signatureValid: boolean;
  try {
    signatureValid = verifier.verify(publicKey, rawSignature);
  } catch {
    // createVerify throws when the key is malformed, treat as invalid sig
    signatureValid = false;
  }

  if (!signatureValid) {
    throw new JwtError('Token signature is invalid', 'INVALID_SIGNATURE');
  }

  const payload = safeJsonParse<JwtPayload>(base64urlDecode(encodedPayload), 'payload');

  const skew = options.clockSkew ?? 0;
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp === 'number' && now > payload.exp + skew) {
    throw new JwtError('Token has expired', 'EXPIRED');
  }

  if (typeof payload.nbf === 'number' && now < payload.nbf - skew) {
    throw new JwtError('Token is not yet valid', 'NOT_YET_VALID');
  }

  if (options.issuer !== undefined && payload.iss !== options.issuer) {
    throw new JwtError(
      `Invalid issuer: expected "${options.issuer}", got "${String(payload.iss)}"`,
      'INVALID_ISSUER',
    );
  }

  if (options.audience !== undefined) {
    const expected = Array.isArray(options.audience) ? options.audience : [options.audience];
    const actual = Array.isArray(payload.aud)
      ? payload.aud
      : payload.aud !== undefined
        ? [payload.aud]
        : [];
    const hasMatch = expected.some((e) => actual.includes(e));
    if (!hasMatch) {
      throw new JwtError('Token audience does not match', 'INVALID_AUDIENCE');
    }
  }

  return { header, payload };
}
