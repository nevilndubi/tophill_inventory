import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { z } from 'zod';
import type { ApiEnvironment } from '../config/env';
import { AuthenticationUnavailableException, InvalidAuthenticationException } from './auth.errors';
import type { VerifiedAccessToken } from './auth.types';

const AUTH_CLOCK_TOLERANCE_SECONDS = 30;
const JWKS_CACHE_MAX_AGE_MS = 10 * 60 * 1_000;
const JWKS_COOLDOWN_MS = 30 * 1_000;
const JWKS_TIMEOUT_MS = 1_000;
const uuidSchema = z.uuid();

const unavailableJoseCodes = new Set([
  'ERR_JOSE_GENERIC',
  'ERR_JWK_INVALID',
  'ERR_JWKS_INVALID',
  'ERR_JWKS_MULTIPLE_MATCHING_KEYS',
  'ERR_JWKS_TIMEOUT',
]);

@Injectable()
export class JwtVerifierService {
  private readonly issuer: string;
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(config: ConfigService<ApiEnvironment, true>) {
    this.issuer = config.get('SUPABASE_JWT_ISSUER', { infer: true });
    this.jwks = createRemoteJWKSet(new URL(config.get('SUPABASE_JWKS_URL', { infer: true })), {
      cacheMaxAge: JWKS_CACHE_MAX_AGE_MS,
      cooldownDuration: JWKS_COOLDOWN_MS,
      timeoutDuration: JWKS_TIMEOUT_MS,
    });
  }

  async verify(token: string): Promise<VerifiedAccessToken> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.jwks, {
        algorithms: ['ES256'],
        audience: 'authenticated',
        clockTolerance: AUTH_CLOCK_TOLERANCE_SECONDS,
        issuer: this.issuer,
        requiredClaims: ['exp', 'role', 'sub'],
      });

      const subject = uuidSchema.safeParse(payload.sub);

      if (
        protectedHeader.alg !== 'ES256' ||
        typeof protectedHeader.kid !== 'string' ||
        protectedHeader.kid.length === 0 ||
        payload.role !== 'authenticated' ||
        !subject.success
      ) {
        throw new InvalidAuthenticationException();
      }

      return { subject: subject.data };
    } catch (error: unknown) {
      if (
        error instanceof AuthenticationUnavailableException ||
        error instanceof InvalidAuthenticationException
      ) {
        throw error;
      }

      if (!(error instanceof errors.JOSEError) || unavailableJoseCodes.has(error.code)) {
        throw new AuthenticationUnavailableException();
      }

      throw new InvalidAuthenticationException();
    }
  }
}
