import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import { exportJWK, generateKeyPair, SignJWT, UnsecuredJWT, type CryptoKey, type JWK } from 'jose';
import type { ApiEnvironment } from '../config/env';
import { AuthenticationUnavailableException, InvalidAuthenticationException } from './auth.errors';
import { JwtVerifierService } from './jwt-verifier.service';

const issuer = 'https://auth.example.test/auth/v1';
const subject = '11111111-1111-4111-8111-111111111111';
const keyId = 'test-es256-key';

type TokenOptions = {
  audience?: string;
  expiresAt?: number;
  issuer?: string;
  key?: CryptoKey;
  kid?: string;
  role?: string;
  subject?: string;
};

const configFor = (jwksUrl: string) =>
  ({
    get: jest.fn((key: keyof ApiEnvironment) => {
      if (key === 'SUPABASE_JWT_ISSUER') return issuer;
      if (key === 'SUPABASE_JWKS_URL') return jwksUrl;
      return undefined;
    }),
  }) as unknown as ConfigService<ApiEnvironment, true>;

describe('JwtVerifierService', () => {
  let server: Server;
  let jwksUrl: string;
  let privateKey: CryptoKey;
  let otherPrivateKey: CryptoKey;
  let publicJwk: JWK;
  let requestCount: number;

  const signToken = async (options: TokenOptions = {}): Promise<string> =>
    new SignJWT({ role: options.role ?? 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid: options.kid ?? keyId })
      .setIssuer(options.issuer ?? issuer)
      .setAudience(options.audience ?? 'authenticated')
      .setSubject(options.subject ?? subject)
      .setIssuedAt()
      .setExpirationTime(options.expiresAt ?? Math.floor(Date.now() / 1_000) + 300)
      .sign(options.key ?? privateKey);

  beforeAll(async () => {
    const primary = await generateKeyPair('ES256');
    const other = await generateKeyPair('ES256');
    privateKey = primary.privateKey;
    otherPrivateKey = other.privateKey;
    publicJwk = {
      ...(await exportJWK(primary.publicKey)),
      alg: 'ES256',
      kid: keyId,
      use: 'sig',
    };
  });

  beforeEach(async () => {
    requestCount = 0;
    server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    jwksUrl = `http://127.0.0.1:${address.port}/.well-known/jwks.json`;
  });

  afterEach(async () => {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    }
  });

  it('verifies a valid ES256 token and reuses the remote JWKS cache', async () => {
    const verifier = new JwtVerifierService(configFor(jwksUrl));

    await expect(verifier.verify(await signToken())).resolves.toEqual({ subject });
    await expect(verifier.verify(await signToken())).resolves.toEqual({ subject });
    expect(requestCount).toBe(1);
  });

  it.each([
    ['expired', () => signToken({ expiresAt: Math.floor(Date.now() / 1_000) - 60 })],
    ['forged', () => signToken({ key: otherPrivateKey })],
    ['unknown kid', () => signToken({ kid: 'unknown-key' })],
    ['wrong issuer', () => signToken({ issuer: 'https://other.example.test/auth/v1' })],
    ['wrong audience', () => signToken({ audience: 'other' })],
    ['anonymous role', () => signToken({ role: 'anon' })],
    ['service role', () => signToken({ role: 'service_role' })],
    ['non-UUID subject', () => signToken({ subject: 'not-a-uuid' })],
  ])('rejects a %s token', async (_name, createToken) => {
    const verifier = new JwtVerifierService(configFor(jwksUrl));

    await expect(verifier.verify(await createToken())).rejects.toBeInstanceOf(
      InvalidAuthenticationException,
    );
  });

  it('rejects none and HS256 algorithms', async () => {
    const verifier = new JwtVerifierService(configFor(jwksUrl));
    const unsigned = new UnsecuredJWT({ role: 'authenticated' })
      .setIssuer(issuer)
      .setAudience('authenticated')
      .setSubject(subject)
      .setExpirationTime('5m')
      .encode();
    const symmetricKey = new TextEncoder().encode('test-only-symmetric-key-with-32-bytes');
    const symmetric = await new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'HS256', kid: keyId })
      .setIssuer(issuer)
      .setAudience('authenticated')
      .setSubject(subject)
      .setExpirationTime('5m')
      .sign(symmetricKey);

    await expect(verifier.verify(unsigned)).rejects.toBeInstanceOf(InvalidAuthenticationException);
    await expect(verifier.verify(symmetric)).rejects.toBeInstanceOf(InvalidAuthenticationException);
  });

  it('reports an unreachable JWKS endpoint as authentication unavailable', async () => {
    const token = await signToken();
    const unavailableUrl = jwksUrl;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    const verifier = new JwtVerifierService(configFor(unavailableUrl));

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AuthenticationUnavailableException);
  });
});
