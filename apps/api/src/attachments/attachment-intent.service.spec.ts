import { ConfigService } from '@nestjs/config';
import { jest } from '@jest/globals';
import type { ApiEnvironment } from '../config/env';
import { AttachmentIntentService } from './attachment-intent.service';
import {
  AttachmentConfirmationConflictException,
  AttachmentUploadExpiredException,
} from './attachments.errors';

const config = (secret: string) =>
  ({
    get: jest.fn(() => secret),
  }) as unknown as ConfigService<ApiEnvironment, true>;

describe('AttachmentIntentService', () => {
  afterEach(() => jest.useRealTimers());

  it('binds a 15-minute signed intent to the user, machine, metadata and path', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-27T10:00:00.000Z') });
    const service = new AttachmentIntentService(config('sb_secret_test_value'));
    const issued = await service.issue({
      fileName: 'photo.png',
      machineId: '11111111-1111-4111-8111-111111111111',
      mimeType: 'image/png',
      path: 'machines/11111111-1111-4111-8111-111111111111/file.png',
      sizeBytes: 8,
      sub: '22222222-2222-4222-8222-222222222222',
    });
    expect(issued.expiresAt).toBe('2026-10-27T10:15:00.000Z');
    await expect(service.verify(issued.intentToken)).resolves.toMatchObject({
      fileName: 'photo.png',
      machineId: '11111111-1111-4111-8111-111111111111',
      sub: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('rejects expired and forged intents with distinct safe errors', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-27T10:00:00.000Z') });
    const service = new AttachmentIntentService(config('sb_secret_test_value'));
    const issued = await service.issue({
      fileName: 'photo.png',
      machineId: '11111111-1111-4111-8111-111111111111',
      mimeType: 'image/png',
      path: 'machines/11111111-1111-4111-8111-111111111111/file.png',
      sizeBytes: 8,
      sub: '22222222-2222-4222-8222-222222222222',
    });
    jest.setSystemTime(new Date('2026-10-27T10:16:00.000Z'));
    await expect(service.verify(issued.intentToken)).rejects.toBeInstanceOf(
      AttachmentUploadExpiredException,
    );

    const other = new AttachmentIntentService(config('sb_secret_other_value'));
    await expect(other.verify(issued.intentToken)).rejects.toBeInstanceOf(
      AttachmentConfirmationConflictException,
    );
  });
});
