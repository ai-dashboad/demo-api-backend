import { describe, it, expect, beforeAll } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import {
  signJwt,
  verifyJwt,
  decodeJwt,
  JwtExpiredError,
  JwtInvalidError,
  type HS256Config,
  type RS256Config,
} from './jwt.js'

const HS256: HS256Config = {
  algorithm: 'HS256',
  secret: 'test-secret-at-least-32-bytes-long!!',
}

let RS256: RS256Config

beforeAll(() => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  RS256 = { algorithm: 'RS256', privateKey, publicKey }
})

describe('signJwt + verifyJwt — HS256', () => {
  it('should round-trip a custom payload', async () => {
    const token = await signJwt({ userId: '42', role: 'admin' }, HS256)
    const payload = await verifyJwt(token, HS256)
    expect(payload['userId']).toBe('42')
    expect(payload['role']).toBe('admin')
  })

  it('should embed iss, aud, sub, jti when provided', async () => {
    const token = await signJwt({}, HS256, {
      issuer: 'opendev',
      audience: 'api',
      subject: 'user-1',
      jwtId: 'abc-123',
    })
    const payload = await verifyJwt(token, HS256, {
      issuer: 'opendev',
      audience: 'api',
    })
    expect(payload.iss).toBe('opendev')
    expect(payload.aud).toContain('api')
    expect(payload.sub).toBe('user-1')
    expect(payload.jti).toBe('abc-123')
  })

  it('should accept an audience array and verify against any member', async () => {
    const token = await signJwt({}, HS256, { audience: ['api', 'dashboard'] })
    const payload = await verifyJwt(token, HS256, { audience: 'api' })
    expect(payload.aud).toContain('dashboard')
  })

  it('should set iat and exp claims automatically', async () => {
    const before = Math.floor(Date.now() / 1000)
    const token = await signJwt({}, HS256, { expiresIn: 60 })
    const payload = await verifyJwt(token, HS256)
    const after = Math.floor(Date.now() / 1000)

    expect(payload.iat).toBeGreaterThanOrEqual(before)
    expect(payload.iat).toBeLessThanOrEqual(after)
    expect(payload.exp).toBeGreaterThanOrEqual(before + 60)
  })

  it('should throw JwtExpiredError when the token lifetime is in the past', async () => {
    // expiresIn: -1 sets exp to 1 second ago
    const token = await signJwt({}, HS256, { expiresIn: -1 })
    await expect(verifyJwt(token, HS256)).rejects.toBeInstanceOf(JwtExpiredError)
  })

  it('should throw JwtInvalidError when the secret is wrong', async () => {
    const token = await signJwt({}, HS256)
    const wrong: HS256Config = { algorithm: 'HS256', secret: 'wrong-secret' }
    await expect(verifyJwt(token, wrong)).rejects.toBeInstanceOf(JwtInvalidError)
  })

  it('should throw JwtInvalidError when the expected issuer does not match', async () => {
    const token = await signJwt({}, HS256, { issuer: 'opendev' })
    await expect(
      verifyJwt(token, HS256, { issuer: 'other' })
    ).rejects.toBeInstanceOf(JwtInvalidError)
  })

  it('should throw JwtInvalidError when the expected audience does not match', async () => {
    const token = await signJwt({}, HS256, { audience: 'api' })
    await expect(
      verifyJwt(token, HS256, { audience: 'dashboard' })
    ).rejects.toBeInstanceOf(JwtInvalidError)
  })

  it('should throw JwtInvalidError for a structurally invalid token string', async () => {
    await expect(verifyJwt('not-a-jwt', HS256)).rejects.toBeInstanceOf(JwtInvalidError)
  })
})

describe('signJwt + verifyJwt — RS256', () => {
  it('should round-trip a payload using an RSA key pair', async () => {
    const token = await signJwt({ userId: '99' }, RS256)
    const payload = await verifyJwt(token, RS256)
    expect(payload['userId']).toBe('99')
  })

  it('should throw JwtInvalidError when verified with a different public key', async () => {
    const token = await signJwt({}, RS256)
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    const other: RS256Config = { algorithm: 'RS256', privateKey, publicKey }
    await expect(verifyJwt(token, other)).rejects.toBeInstanceOf(JwtInvalidError)
  })

  it('should embed issuer and audience in RS256 tokens', async () => {
    const token = await signJwt({}, RS256, { issuer: 'opendev', audience: 'svc-api' })
    const payload = await verifyJwt(token, RS256, {
      issuer: 'opendev',
      audience: 'svc-api',
    })
    expect(payload.iss).toBe('opendev')
    expect(payload.aud).toContain('svc-api')
  })
})

describe('decodeJwt', () => {
  it('should decode claims without verifying the signature', async () => {
    const token = await signJwt({ userId: '7' }, HS256)
    const payload = decodeJwt(token)
    expect(payload['userId']).toBe('7')
  })

  it('should decode an expired token without throwing', async () => {
    const token = await signJwt({}, HS256, { expiresIn: -1 })
    expect(() => decodeJwt(token)).not.toThrow()
  })

  it('should throw JwtInvalidError for a malformed token string', () => {
    expect(() => decodeJwt('not.a.valid.jwt')).toThrow(JwtInvalidError)
  })
})
