import { jest } from '@jest/globals';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AttachmentIntentService } from './attachment-intent.service';
import { AttachmentLimitReachedException, AttachmentNotFoundException } from './attachments.errors';
import { AttachmentsService } from './attachments.service';
import type { SupabaseStorageService } from './supabase-storage.service';

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const ATTACHMENT_ID = '33333333-3333-4333-8333-333333333333';
const PATH = `machines/${MACHINE_ID}/44444444-4444-4444-8444-444444444444.png`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const actor: AuthenticatedUser = {
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test technician',
  id: USER_ID,
  isActive: true,
  role: 'BIOMED_TECH',
};

const attachment = {
  createdAt: new Date('2026-10-27T10:00:00.000Z'),
  entityId: MACHINE_ID,
  entityType: 'MACHINE' as const,
  fileName: 'machine photo.png',
  id: ATTACHMENT_ID,
  mimeType: 'image/png',
  sizeBytes: PNG.length,
  storagePath: PATH,
  updatedAt: new Date('2026-10-27T10:00:00.000Z'),
  uploadedByUser: { fullName: actor.fullName },
  uploadedByUserId: USER_ID,
};

const intent = {
  fileName: attachment.fileName,
  intentId: '55555555-5555-4555-8555-555555555555',
  machineId: MACHINE_ID,
  mimeType: 'image/png' as const,
  path: PATH,
  sizeBytes: PNG.length,
  sub: USER_ID,
};

const makeHarness = () => {
  const tx = {
    $queryRaw: jest.fn(async () => [{ deletedAt: null, id: MACHINE_ID }]),
    attachment: {
      count: jest.fn(async () => 0),
      create: jest.fn(async () => attachment),
      delete: jest.fn(async () => attachment),
      findUnique: jest.fn(async (): Promise<typeof attachment | null> => null),
    },
    auditLog: { create: jest.fn(async () => undefined) },
  };
  const prisma = {
    $transaction: jest.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx),
    ),
    attachment: {
      count: jest.fn(async () => 0),
      findFirst: jest.fn(async () => attachment),
      findMany: jest.fn(async () => [attachment]),
      findUnique: jest.fn(async (): Promise<typeof attachment | null> => null),
    },
    machine: {
      findFirst: jest.fn(async (): Promise<{ id: string } | null> => ({ id: MACHINE_ID })),
    },
  };
  const audit = { record: jest.fn(async () => undefined) };
  const storage = {
    createSignedDownload: jest.fn(async () => 'signed-download-redacted'),
    createSignedUpload: jest.fn(async (_path: string) => 'signed-upload-redacted'),
    inspect: jest.fn(async () => ({ bytes: PNG, contentType: 'image/png', sizeBytes: PNG.length })),
    remove: jest.fn(async () => true),
  };
  const intents = {
    issue: jest.fn(async () => ({
      expiresAt: '2026-10-27T10:15:00.000Z',
      intentToken: 'intent-redacted',
    })),
    verify: jest.fn(async () => intent),
  };
  const service = new AttachmentsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    storage as unknown as SupabaseStorageService,
    intents as unknown as AttachmentIntentService,
  );
  return { audit, intents, prisma, service, storage, tx };
};

describe('AttachmentsService', () => {
  it('issues a server-controlled randomized path without returning the path', async () => {
    const { intents, service, storage } = makeHarness();
    const result = await service.requestUpload(actor, MACHINE_ID, {
      fileName: 'machine photo.png',
      mimeType: 'image/png',
      sizeBytes: PNG.length,
    });
    expect(result).toEqual({
      expiresAt: '2026-10-27T10:15:00.000Z',
      intentToken: 'intent-redacted',
      uploadUrl: 'signed-upload-redacted',
    });
    const path = storage.createSignedUpload.mock.calls[0]?.[0] as string;
    expect(path).toMatch(new RegExp(`^machines/${MACHINE_ID}/[0-9a-f-]+\\.png$`));
    expect(JSON.stringify(result)).not.toContain(path);
    expect(intents.issue).toHaveBeenCalledWith(expect.objectContaining({ path, sub: USER_ID }));
  });

  it('enforces the 20-item limit before signing and again under the machine row lock', async () => {
    const first = makeHarness();
    first.prisma.attachment.count.mockResolvedValue(20);
    await expect(
      first.service.requestUpload(actor, MACHINE_ID, {
        fileName: 'photo.png',
        mimeType: 'image/png',
        sizeBytes: PNG.length,
      }),
    ).rejects.toBeInstanceOf(AttachmentLimitReachedException);
    expect(first.storage.createSignedUpload).not.toHaveBeenCalled();

    const second = makeHarness();
    second.tx.attachment.count.mockResolvedValue(20);
    await expect(
      second.service.confirm(actor, { intentToken: 'intent-redacted' }, 'request-1'),
    ).rejects.toBeInstanceOf(AttachmentLimitReachedException);
    expect(second.storage.remove).toHaveBeenCalledWith(PATH);
  });

  it('verifies metadata and magic bytes before atomically creating the row and audit', async () => {
    const { audit, service, tx } = makeHarness();
    await expect(
      service.confirm(actor, { intentToken: 'intent-redacted' }, 'request-1'),
    ).resolves.toMatchObject({ fileName: attachment.fileName, typeLabel: 'PNG image' });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ storagePath: PATH }) }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'attachment.uploaded', entityId: ATTACHMENT_ID }),
    );
  });

  it.each([
    [
      { bytes: PNG, contentType: 'application/pdf', sizeBytes: PNG.length },
      'ATTACHMENT_INVALID_TYPE',
    ],
    [
      { bytes: PNG, contentType: 'image/png', sizeBytes: PNG.length + 1 },
      'ATTACHMENT_SIZE_MISMATCH',
    ],
    [
      { bytes: new Uint8Array(PNG.length), contentType: 'image/png', sizeBytes: PNG.length },
      'ATTACHMENT_INVALID_CONTENT',
    ],
  ] as const)('deletes mismatched objects and returns %s', async (stored, code) => {
    const { service, storage, tx } = makeHarness();
    storage.inspect.mockResolvedValue(stored);
    await expect(
      service.confirm(actor, { intentToken: 'intent-redacted' }, 'request-1'),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code }) });
    expect(storage.remove).toHaveBeenCalledWith(PATH);
    expect(tx.attachment.create).not.toHaveBeenCalled();
  });

  it('returns the same attachment when confirmation is repeated', async () => {
    const { prisma, service, storage } = makeHarness();
    prisma.attachment.findUnique.mockResolvedValue(attachment);
    await expect(
      service.confirm(actor, { intentToken: 'intent-redacted' }, 'request-1'),
    ).resolves.toMatchObject({ id: ATTACHMENT_ID });
    expect(storage.inspect).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('compensates by removing the object when the database transaction fails', async () => {
    const { audit, service, storage } = makeHarness();
    audit.record.mockRejectedValue(new Error('database failure'));
    await expect(
      service.confirm(actor, { intentToken: 'intent-redacted' }, 'request-1'),
    ).rejects.toThrow('database failure');
    expect(storage.remove).toHaveBeenCalledWith(PATH);
  });

  it('lists metadata only and hides attachments when the machine is soft-deleted', async () => {
    const { prisma, service } = makeHarness();
    const result = await service.list(MACHINE_ID);
    expect(result).toEqual([
      {
        fileName: attachment.fileName,
        id: ATTACHMENT_ID,
        sizeBytes: PNG.length,
        typeLabel: 'PNG image',
        uploadedAt: '2026-10-27T10:00:00.000Z',
        uploader: { fullName: actor.fullName },
      },
    ]);
    expect(result[0]).not.toHaveProperty('storagePath');
    prisma.machine.findFirst.mockResolvedValue(null);
    await expect(service.list(MACHINE_ID)).rejects.toMatchObject({ status: 404 });
  });

  it('creates a five-minute download and deletes the row/audit before the object', async () => {
    const { audit, service, storage, tx } = makeHarness();
    const signed = await service.download(ATTACHMENT_ID);
    expect(signed.url).toBe('signed-download-redacted');
    expect(storage.createSignedDownload).toHaveBeenCalledWith(PATH, attachment.fileName, 300);

    tx.attachment.findUnique.mockResolvedValue(attachment);
    await expect(service.delete(actor, ATTACHMENT_ID, 'request-2')).resolves.toMatchObject({
      id: ATTACHMENT_ID,
    });
    expect(tx.attachment.delete.mock.invocationCallOrder[0]).toBeLessThan(
      audit.record.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(audit.record).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'attachment.deleted' }),
    );
    expect(storage.remove).toHaveBeenCalledWith(PATH);
  });

  it('does not delete an attachment belonging to a soft-deleted machine', async () => {
    const { service, tx } = makeHarness();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(service.delete(actor, ATTACHMENT_ID, 'request-2')).rejects.toBeInstanceOf(
      AttachmentNotFoundException,
    );
    expect(tx.attachment.delete).not.toHaveBeenCalled();
  });
});
