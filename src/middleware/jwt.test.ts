import { describe, it, expect, beforeAll } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { signToken, verifyToken, JwtError } from './jwt.js';

let privateKey: string;
let publicKey: string;
let foreignPublicKey: string;

beforeAll(() => {
  const primary = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = primary.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  publicKey = primary.publicKey.export({ type: 'spki', format: 'pem' }) as string;

  // A second key pair used to test signature rejection
  const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 });
  foreignPublicKey = foreign.publicKey.export({ type: 'spki', format: 'pem' }) as string;
});

describe('signToken', () => {
  it('should produce a three-part base64url string', () => {
    const token = signToken({ sub: 'u1' }, privateKey);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    parts.forEach((p) => expect(p).toMatch(/^[A-Za-z0-9_-]+$/));
  });

  it('should embed iat automatically', () => {
    const before = Math.floor(Date.now() / 1000);
    const token = signToken({}, privateKey);
    const { payload } = verifyToken(token, publicKey);
    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });

  it('should embed exp when expiresIn is provided', () => {
    const token = signToken({}, privateKey, { expiresIn: 3600 });
    const { payload } = verifyToken(token, publicKey);
    expect(payload.exp).toBeDefined();
    expect(payload.exp! - payload.iat!).toBe(3600);
  });

  it('should embed iss, aud, sub from options', () => {
    const token = signToken({}, privateKey, {
      issuer: 'opendev',
      audience: 'api',
      subject: 'user:42',
    });
    const { payload } = verifyToken(token, publicKey);
    expect(payload.iss).toBe('opendev');
    expect(payload.aud).toBe('api');
    expect(payload.sub).toBe('user:42');
  });

  it('should allow arbitrary custom claims in the payload', () => {
    const token = signToken({ role: 'admin', orgId: 99 }, privateKey);
    const { payload } = verifyToken(token, publicKey);
    expect(payload.role).toBe('admin');
    expect(payload.orgId).toBe(99);
  });
});

describe('verifyToken — happy path', () => {
  it('should return header and payload on a valid token', () => {
    const token = signToken({ sub: 'u1' }, privateKey, { expiresIn: 60 });
    const result = verifyToken(token, publicKey);
    expect(result.header.alg).toBe('RS256');
    expect(result.header.typ).toBe('JWT');
    expect(result.payload.sub).toBe('u1');
  });

  it('should accept an audience array when token aud matches any element', () => {
    const token = signToken({ aud: 'api' }, privateKey);
    expect(() => verifyToken(token, publicKey, { audience: ['api', 'admin'] })).not.toThrow();
  });

  it('should accept a token whose aud is an array containing the expected audience', () => {
    const token = signToken({ aud: ['api', 'admin'] }, privateKey);
    expect(() => verifyToken(token, publicKey, { audience: 'admin' })).not.toThrow();
  });

  it('should tolerate clock skew on an already-expired token when clockSkew is set', () => {
    // exp 5 seconds ago — within 10-second skew tolerance
    const token = signToken({ exp: Math.floor(Date.now() / 1000) - 5 }, privateKey);
    expect(() => verifyToken(token, publicKey, { clockSkew: 10 })).not.toThrow();
  });
});

describe('verifyToken — signature errors', () => {
  it('should throw INVALID_SIGNATURE when verified with the wrong public key', () => {
    const token = signToken({ sub: 'u1' }, privateKey);
    const err = (() => {
      try {
        verifyToken(token, foreignPublicKey);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(JwtError);
    expect((err as JwtError).code).toBe('INVALID_SIGNATURE');
  });

  it('should throw INVALID_SIGNATURE when the signature segment is tampered with', () => {
    const token = signToken({ sub: 'u1' }, privateKey);
    const parts = token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.aW52YWxpZA`; // "invalid" in base64url
    expect(() => verifyToken(tampered, publicKey)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SIGNATURE' }),
    );
  });

  it('should throw INVALID_SIGNATURE when the payload is tampered with', () => {
    const token = signToken({ role: 'user' }, privateKey);
    const [h, , s] = token.split('.');
    // Replace payload with a forged one claiming admin role
    const forgedPayload = Buffer.from(JSON.stringify({ role: 'admin' })).toString('base64url');
    expect(() => verifyToken(`${h}.${forgedPayload}.${s}`, publicKey)).toThrowError(
      expect.objectContaining({ code: 'INVALID_SIGNATURE' }),
    );
  });
});

describe('verifyToken — structural errors', () => {
  it('should throw MALFORMED when the token has fewer than 3 parts', () => {
    expect(() => verifyToken('only.two', publicKey)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED' }),
    );
  });

  it('should throw MALFORMED when the token is an empty string', () => {
    expect(() => verifyToken('', publicKey)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED' }),
    );
  });

  it('should throw MALFORMED when the algorithm is not RS256', () => {
    // Manually craft a token with alg:HS256 to test algorithm lock
    const fakeHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const fakePayload = Buffer.from(JSON.stringify({ sub: 'u' })).toString('base64url');
    expect(() => verifyToken(`${fakeHeader}.${fakePayload}.fakesig`, publicKey)).toThrowError(
      expect.objectContaining({ code: 'MALFORMED' }),
    );
  });
});

describe('verifyToken — claim validation', () => {
  it('should throw EXPIRED when exp is in the past', () => {
    const token = signToken({ exp: Math.floor(Date.now() / 1000) - 1 }, privateKey);
    expect(() => verifyToken(token, publicKey)).toThrowError(
      expect.objectContaining({ code: 'EXPIRED' }),
    );
  });

  it('should throw NOT_YET_VALID when nbf is in the future', () => {
    const token = signToken({ nbf: Math.floor(Date.now() / 1000) + 300 }, privateKey);
    expect(() => verifyToken(token, publicKey)).toThrowError(
      expect.objectContaining({ code: 'NOT_YET_VALID' }),
    );
  });

  it('should throw INVALID_ISSUER when iss does not match', () => {
    const token = signToken({ iss: 'other-service' }, privateKey);
    expect(() => verifyToken(token, publicKey, { issuer: 'opendev' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_ISSUER' }),
    );
  });

  it('should throw INVALID_AUDIENCE when aud does not match', () => {
    const token = signToken({ aud: 'api' }, privateKey);
    expect(() => verifyToken(token, publicKey, { audience: 'admin' })).toThrowError(
      expect.objectContaining({ code: 'INVALID_AUDIENCE' }),
    );
  });
});
