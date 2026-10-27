import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, errors as JoseErrors, jwtVerify } from 'jose';
import { z } from 'zod';
import type { ApiEnvironment } from '../config/env';
import {
  AttachmentConfirmationConflictException,
  AttachmentUploadExpiredException,
} from './attachments.errors';
import { ATTACHMENT_CONFIRMATION_TTL_SECONDS } from './attachments.constants';

const INTENT_AUDIENCE = 'attachment-upload';
const INTENT_ISSUER = 'tophill-inventory-api';

const intentClaimsSchema = z.object({
  fileName: z.string(),
  intentId: z.uuid(),
  machineId: z.uuid(),
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  path: z.string().startsWith('machines/'),
  sizeBytes: z.number().int().positive(),
  sub: z.uuid(),
});

export type AttachmentIntent = z.infer<typeof intentClaimsSchema>;

@Injectable()
export class AttachmentIntentService {
  private readonly key: Uint8Array;

  constructor(config: ConfigService<ApiEnvironment, true>) {
    this.key = createHash('sha256')
      .update('attachment-upload-intent\0')
      .update(config.get('SUPABASE_SECRET_KEY', { infer: true }))
      .digest();
  }

  async issue(input: Omit<AttachmentIntent, 'intentId'>): Promise<{
    expiresAt: string;
    intentToken: string;
  }> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = nowSeconds + ATTACHMENT_CONFIRMATION_TTL_SECONDS;
    const intentId = randomUUID();
    const intentToken = await new SignJWT({ ...input, intentId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(INTENT_ISSUER)
      .setAudience(INTENT_AUDIENCE)
      .setSubject(input.sub)
      .setJti(intentId)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(expiresAtSeconds)
      .sign(this.key);
    return { expiresAt: new Date(expiresAtSeconds * 1000).toISOString(), intentToken };
  }

  async verify(token: string): Promise<AttachmentIntent> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        audience: INTENT_AUDIENCE,
        issuer: INTENT_ISSUER,
      });
      return intentClaimsSchema.parse(payload);
    } catch (error: unknown) {
      if (error instanceof JoseErrors.JWTExpired) throw new AttachmentUploadExpiredException();
      throw new AttachmentConfirmationConflictException();
    }
  }
}
