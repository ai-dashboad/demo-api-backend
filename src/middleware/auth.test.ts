import { describe, it, expect, beforeAll, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { signToken } from './jwt.js';
import { createAuthMiddleware, type AuthenticatedRequest } from './auth.js';

let privateKey: string;
let publicKey: string;

beforeAll(() => {
  const { privateKey: priv, publicKey: pub } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = priv.export({ type: 'pkcs8', format: 'pem' }) as string;
  publicKey = pub.export({ type: 'spki', format: 'pem' }) as string;
});

/** Build a minimal mock IncomingMessage with the given Authorization header. */
function mockRequest(authHeader?: string): IncomingMessage {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as IncomingMessage;
}

/** Build a mock ServerResponse that records the status code and body. */
function mockResponse() {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    body: '',
    writeHead: vi.fn(function (this: typeof res, code: number, headers: Record<string, string | number>) {
      this.statusCode = code;
      Object.assign(this.headers, headers);
    }),
    end: vi.fn(function (this: typeof res, data: string) {
      this.body = data;
    }),
  };
  // bind so `this` works in vi.fn callbacks
  res.writeHead = res.writeHead.bind(res);
  res.end = res.end.bind(res);
  return res as unknown as ReturnType<typeof mockResponse> & ServerResponse;
}

describe('createAuthMiddleware — token accepted', () => {
  it('should call next() and attach auth when a valid token is supplied', () => {
    const middleware = createAuthMiddleware(publicKey);
    const token = signToken({ sub: 'u1' }, privateKey, { expiresIn: 60 });
    const req = mockRequest(`Bearer ${token}`);
    const res = mockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(/* no error */);
    expect((req as AuthenticatedRequest).auth.payload.sub).toBe('u1');
    expect(res.writeHead).not.toHaveBeenCalled();
  });

  it('should validate issuer and audience when options are provided', () => {
    const middleware = createAuthMiddleware(publicKey, {
      issuer: 'opendev',
      audience: 'api',
    });
    const token = signToken({}, privateKey, {
      expiresIn: 60,
      issuer: 'opendev',
      audience: 'api',
    });
    const req = mockRequest(`Bearer ${token}`);
    const res = mockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(next).toHaveBeenCalledOnce();
  });
});

describe('createAuthMiddleware — missing or malformed header', () => {
  it('should respond 401 when there is no Authorization header', () => {
    const middleware = createAuthMiddleware(publicKey);
    const req = mockRequest(); // no header
    const res = mockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should respond 401 when the scheme is not Bearer', () => {
    const middleware = createAuthMiddleware(publicKey);
    const req = mockRequest('Basic dXNlcjpwYXNz');
    const res = mockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should include WWW-Authenticate header in 401 responses', () => {
    const middleware = createAuthMiddleware(publicKey);
    const res = mockResponse();

    middleware(mockRequest(), res as unknown as ServerResponse, vi.fn());

    expect(res.headers['WWW-Authenticate']).toContain('Bearer');
  });

  it('should respond with JSON body on 401', () => {
    const middleware = createAuthMiddleware(publicKey);
    const res = mockResponse();

    middleware(mockRequest(), res as unknown as ServerResponse, vi.fn());

    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('error', 'Unauthorized');
    expect(body).toHaveProperty('reason');
  });
});

describe('createAuthMiddleware — invalid token', () => {
  it('should respond 401 for an expired token', () => {
    const middleware = createAuthMiddleware(publicKey);
    const token = signToken({ exp: Math.floor(Date.now() / 1000) - 10 }, privateKey);
    const req = mockRequest(`Bearer ${token}`);
    const res = mockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).reason).toMatch(/expired/i);
  });

  it('should respond 401 for a token with an invalid signature', () => {
    const { publicKey: otherPub } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const middleware = createAuthMiddleware(
      otherPub.export({ type: 'spki', format: 'pem' }) as string,
    );
    const token = signToken({ sub: 'u1' }, privateKey, { expiresIn: 60 });
    const req = mockRequest(`Bearer ${token}`);
    const res = mockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('should respond 401 when issuer does not match', () => {
    const middleware = createAuthMiddleware(publicKey, { issuer: 'opendev' });
    const token = signToken({ iss: 'impostor' }, privateKey, { expiresIn: 60 });
    const req = mockRequest(`Bearer ${token}`);
    const res = mockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(res.statusCode).toBe(401);
  });
});

describe('createAuthMiddleware — custom tokenExtractor', () => {
  it('should use the provided extractor instead of the Authorization header', () => {
    const token = signToken({ sub: 'cookie-user' }, privateKey, { expiresIn: 60 });
    const middleware = createAuthMiddleware(publicKey, {
      tokenExtractor: () => token,
    });
    const req = mockRequest(); // no Authorization header
    const res = mockResponse();
    const next = vi.fn();

    middleware(req, res as unknown as ServerResponse, next);

    expect(next).toHaveBeenCalledOnce();
    expect((req as AuthenticatedRequest).auth.payload.sub).toBe('cookie-user');
  });

  it('should respond 401 when the custom extractor returns null', () => {
    const middleware = createAuthMiddleware(publicKey, {
      tokenExtractor: () => null,
    });
    const res = mockResponse();
    const next = vi.fn();

    middleware(mockRequest(), res as unknown as ServerResponse, next);

    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
