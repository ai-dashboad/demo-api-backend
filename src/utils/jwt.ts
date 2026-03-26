import {
  SignJWT,
  jwtVerify,
  decodeJwt as joseDecodeJwt,
  importPKCS8,
  importSPKI,
  errors as joseErrors,
  type JWTPayload,
  type KeyLike,
} from 'jose'

export type Algorithm = 'HS256' | 'RS256'

export interface HS256Config {
  algorithm: 'HS256'
  secret: string | Uint8Array
}

export interface RS256Config {
  algorithm: 'RS256'
  /** PEM-encoded PKCS8 private key — used only for signing */
  privateKey: string
  /** PEM-encoded SPKI public key — used only for verification */
  publicKey: string
}

export type AlgorithmConfig = HS256Config | RS256Config

export interface SignOptions {
  issuer?: string
  audience?: string | string[]
  subject?: string
  /** Lifetime in seconds. Defaults to 3600 (1 hour). */
  expiresIn?: number
  jwtId?: string
  /** Seconds from now before which the token must not be accepted. */
  notBefore?: number
}

export interface VerifyOptions {
  issuer?: string
  audience?: string | string[]
}

export class JwtExpiredError extends Error {
  constructor(message = 'JWT has expired') {
    super(message)
    this.name = 'JwtExpiredError'
  }
}

export class JwtInvalidError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JwtInvalidError'
  }
}

async function resolveSigningKey(
  config: AlgorithmConfig
): Promise<KeyLike | Uint8Array> {
  if (config.algorithm === 'HS256') {
    return typeof config.secret === 'string'
      ? new TextEncoder().encode(config.secret)
      : config.secret
  }
  return importPKCS8(config.privateKey, 'RS256')
}

async function resolveVerificationKey(
  config: AlgorithmConfig
): Promise<KeyLike | Uint8Array> {
  if (config.algorithm === 'HS256') {
    return typeof config.secret === 'string'
      ? new TextEncoder().encode(config.secret)
      : config.secret
  }
  return importSPKI(config.publicKey, 'RS256')
}

/**
 * Signs a JWT with the given payload and config.
 * Includes iat automatically; exp defaults to 1 hour.
 */
export async function signJwt(
  payload: Record<string, unknown>,
  config: AlgorithmConfig,
  options: SignOptions = {}
): Promise<string> {
  const { issuer, audience, subject, expiresIn = 3600, jwtId, notBefore } = options

  const key = await resolveSigningKey(config)

  let builder = new SignJWT(payload)
    .setProtectedHeader({ alg: config.algorithm })
    .setIssuedAt()
    .setExpirationTime(`${expiresIn}s`)

  if (issuer !== undefined) builder = builder.setIssuer(issuer)
  if (audience !== undefined)
    builder = builder.setAudience(Array.isArray(audience) ? audience : [audience])
  if (subject !== undefined) builder = builder.setSubject(subject)
  if (jwtId !== undefined) builder = builder.setJti(jwtId)
  if (notBefore !== undefined) builder = builder.setNotBefore(`${notBefore}s`)

  return builder.sign(key)
}

/**
 * Verifies a JWT and returns its payload.
 * Throws JwtExpiredError if the token has expired.
 * Throws JwtInvalidError for any other verification failure.
 */
export async function verifyJwt(
  token: string,
  config: AlgorithmConfig,
  options: VerifyOptions = {}
): Promise<JWTPayload> {
  const key = await resolveVerificationKey(config)

  const joseOptions: Parameters<typeof jwtVerify>[2] = {
    algorithms: [config.algorithm],
  }

  if (options.issuer !== undefined) joseOptions.issuer = options.issuer
  if (options.audience !== undefined) {
    joseOptions.audience = Array.isArray(options.audience)
      ? options.audience
      : [options.audience]
  }

  try {
    const { payload } = await jwtVerify(token, key, joseOptions)
    return payload
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw new JwtExpiredError()
    }
    throw new JwtInvalidError(
      err instanceof Error ? err.message : 'Token verification failed'
    )
  }
}

/**
 * Decodes a JWT without verifying its signature.
 * Useful for extracting claims from a trusted internal token or for debugging.
 * Throws JwtInvalidError if the token is malformed.
 */
export function decodeJwt(token: string): JWTPayload {
  try {
    return joseDecodeJwt(token)
  } catch (err) {
    throw new JwtInvalidError(
      err instanceof Error ? err.message : 'Token decoding failed'
    )
  }
}
