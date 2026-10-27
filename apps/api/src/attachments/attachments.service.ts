import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  ATTACHMENT_MAX_PER_MACHINE,
  type AttachmentTypeLabel,
  type ConfirmAttachmentUploadInput,
  type ManagedMachineAttachment,
  type RequestAttachmentUploadInput,
  type SignedAttachmentDownload,
  type SignedAttachmentUpload,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import { AttachmentEntityType } from '../generated/prisma/enums';
import { MachineNotFoundException } from '../machines/machines.errors';
import { PrismaService } from '../prisma/prisma.service';
import { AttachmentIntentService, type AttachmentIntent } from './attachment-intent.service';
import { ATTACHMENT_DOWNLOAD_TTL_SECONDS } from './attachments.constants';
import {
  AttachmentConfirmationConflictException,
  AttachmentContentInvalidException,
  AttachmentLimitReachedException,
  AttachmentNotFoundException,
} from './attachments.errors';
import { SupabaseStorageService, type StoredObject } from './supabase-storage.service';

type AttachmentRow = {
  createdAt: Date;
  entityId: string;
  fileName: string;
  id: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  uploadedByUser: { fullName: string };
  uploadedByUserId: string;
};

const MIME_DETAILS = {
  'application/pdf': { extension: 'pdf', label: 'PDF document' },
  'image/jpeg': { extension: 'jpg', label: 'JPEG image' },
  'image/png': { extension: 'png', label: 'PNG image' },
  'image/webp': { extension: 'webp', label: 'WebP image' },
} as const satisfies Record<string, { extension: string; label: AttachmentTypeLabel }>;

const isPrismaError = (error: unknown, code: string): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === code;

const hasPrefix = (bytes: Uint8Array, expected: readonly number[]): boolean =>
  expected.every((value, index) => bytes[index] === value);

const hasValidSignature = (mimeType: keyof typeof MIME_DETAILS, bytes: Uint8Array): boolean => {
  if (mimeType === 'image/jpeg') return hasPrefix(bytes, [0xff, 0xd8, 0xff]);
  if (mimeType === 'image/png')
    return hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (mimeType === 'image/webp')
    return (
      hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      hasPrefix(bytes.slice(8), [0x57, 0x45, 0x42, 0x50])
    );
  return hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d]);
};

const toDto = (row: AttachmentRow): ManagedMachineAttachment => ({
  fileName: row.fileName,
  id: row.id,
  sizeBytes: row.sizeBytes,
  typeLabel: MIME_DETAILS[row.mimeType as keyof typeof MIME_DETAILS].label,
  uploadedAt: row.createdAt.toISOString(),
  uploader: { fullName: row.uploadedByUser.fullName },
});

const auditState = (row: Pick<AttachmentRow, 'entityId' | 'fileName' | 'mimeType' | 'sizeBytes'>) =>
  ({
    entityId: row.entityId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
  }) satisfies Prisma.InputJsonObject;

@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger(AttachmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: SupabaseStorageService,
    private readonly intents: AttachmentIntentService,
  ) {}

  async requestUpload(
    actor: AuthenticatedUser,
    machineId: string,
    input: RequestAttachmentUploadInput,
  ): Promise<SignedAttachmentUpload> {
    const machine = await this.prisma.machine.findFirst({
      select: { id: true },
      where: { deletedAt: null, id: machineId },
    });
    if (machine === null) throw new MachineNotFoundException();
    const count = await this.prisma.attachment.count({
      where: { entityId: machineId, entityType: AttachmentEntityType.MACHINE },
    });
    if (count >= ATTACHMENT_MAX_PER_MACHINE) {
      throw new AttachmentLimitReachedException(ATTACHMENT_MAX_PER_MACHINE);
    }

    const objectId = randomUUID();
    const details = MIME_DETAILS[input.mimeType];
    const path = `machines/${machineId}/${objectId}.${details.extension}`;
    const uploadUrl = await this.storage.createSignedUpload(path);
    const intent = await this.intents.issue({
      fileName: input.fileName,
      machineId,
      mimeType: input.mimeType,
      path,
      sizeBytes: input.sizeBytes,
      sub: actor.id,
    });
    return { ...intent, uploadUrl };
  }

  async confirm(
    actor: AuthenticatedUser,
    input: ConfirmAttachmentUploadInput,
    requestId: string,
  ): Promise<ManagedMachineAttachment> {
    const intent = await this.intents.verify(input.intentToken);
    if (intent.sub !== actor.id) throw new AttachmentConfirmationConflictException();

    const existing = await this.findByPath(intent.path);
    if (existing !== null) {
      if (existing.entityId !== intent.machineId || existing.uploadedByUserId !== actor.id) {
        throw new AttachmentConfirmationConflictException();
      }
      return toDto(existing);
    }

    const object = await this.storage.inspect(intent.path);
    await this.validateObject(intent, object);

    try {
      const created = await this.prisma.$transaction(async (transaction) => {
        const locked = await transaction.$queryRaw<{ deletedAt: Date | null; id: string }[]>`
          SELECT id, deleted_at AS "deletedAt"
          FROM machines
          WHERE id = ${intent.machineId}::uuid
          FOR UPDATE
        `;
        if (locked[0] === undefined || locked[0].deletedAt !== null) {
          throw new MachineNotFoundException();
        }
        const duplicate = await transaction.attachment.findUnique({
          include: { uploadedByUser: { select: { fullName: true } } },
          where: { storagePath: intent.path },
        });
        if (duplicate !== null) return duplicate;
        const count = await transaction.attachment.count({
          where: { entityId: intent.machineId, entityType: AttachmentEntityType.MACHINE },
        });
        if (count >= ATTACHMENT_MAX_PER_MACHINE) {
          throw new AttachmentLimitReachedException(ATTACHMENT_MAX_PER_MACHINE);
        }
        const attachment = await transaction.attachment.create({
          data: {
            entityId: intent.machineId,
            entityType: AttachmentEntityType.MACHINE,
            fileName: intent.fileName,
            mimeType: intent.mimeType,
            sizeBytes: intent.sizeBytes,
            storagePath: intent.path,
            uploadedByUserId: actor.id,
          },
          include: { uploadedByUser: { select: { fullName: true } } },
        });
        await this.audit.record(transaction, {
          action: 'attachment.uploaded',
          actorUserId: actor.id,
          after: auditState(attachment),
          entityId: attachment.id,
          entityType: 'attachment',
          requestId,
        });
        return attachment;
      });
      return toDto(created);
    } catch (error: unknown) {
      if (isPrismaError(error, 'P2002')) {
        const duplicate = await this.findByPath(intent.path);
        if (
          duplicate !== null &&
          duplicate.entityId === intent.machineId &&
          duplicate.uploadedByUserId === actor.id
        ) {
          return toDto(duplicate);
        }
      }
      const removed = await this.storage.remove(intent.path);
      if (!removed) {
        this.logger.error({ intentId: intent.intentId }, 'ORPHANED_STORAGE_UPLOAD');
      }
      throw error;
    }
  }

  async list(machineId: string): Promise<readonly ManagedMachineAttachment[]> {
    const machine = await this.prisma.machine.findFirst({
      select: { id: true },
      where: { deletedAt: null, id: machineId },
    });
    if (machine === null) throw new MachineNotFoundException();
    const rows = await this.prisma.attachment.findMany({
      include: { uploadedByUser: { select: { fullName: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      where: { entityId: machineId, entityType: AttachmentEntityType.MACHINE },
    });
    return rows.map(toDto);
  }

  async download(id: string): Promise<SignedAttachmentDownload> {
    const attachment = await this.findActiveAttachment(id);
    const url = await this.storage.createSignedDownload(
      attachment.storagePath,
      attachment.fileName,
      ATTACHMENT_DOWNLOAD_TTL_SECONDS,
    );
    return {
      expiresAt: new Date(Date.now() + ATTACHMENT_DOWNLOAD_TTL_SECONDS * 1000).toISOString(),
      url,
    };
  }

  async delete(
    actor: AuthenticatedUser,
    id: string,
    requestId: string,
  ): Promise<ManagedMachineAttachment> {
    const deleted = await this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<{ entityId: string; id: string }[]>`
        SELECT attachment.id, attachment.entity_id AS "entityId"
        FROM attachments attachment
        JOIN machines machine ON machine.id = attachment.entity_id
        WHERE attachment.id = ${id}::uuid
          AND attachment.entity_type = 'MACHINE'::attachment_entity_type
          AND machine.deleted_at IS NULL
        FOR UPDATE OF attachment
      `;
      if (rows[0] === undefined) throw new AttachmentNotFoundException();
      const attachment = await transaction.attachment.findUnique({
        include: { uploadedByUser: { select: { fullName: true } } },
        where: { id },
      });
      if (attachment === null) throw new AttachmentNotFoundException();
      await transaction.attachment.delete({ where: { id } });
      await this.audit.record(transaction, {
        action: 'attachment.deleted',
        actorUserId: actor.id,
        before: auditState(attachment),
        entityId: id,
        entityType: 'attachment',
        requestId,
      });
      return attachment;
    });
    const removed = await this.storage.remove(deleted.storagePath);
    if (!removed) {
      this.logger.error({ attachmentId: deleted.id }, 'ORPHANED_STORAGE_OBJECT');
    }
    return toDto(deleted);
  }

  private async validateObject(intent: AttachmentIntent, object: StoredObject): Promise<void> {
    let error: AttachmentContentInvalidException | undefined;
    if (object.contentType !== intent.mimeType) {
      error = new AttachmentContentInvalidException('ATTACHMENT_INVALID_TYPE');
    } else if (
      object.sizeBytes !== intent.sizeBytes ||
      object.bytes.byteLength !== intent.sizeBytes
    ) {
      error = new AttachmentContentInvalidException('ATTACHMENT_SIZE_MISMATCH');
    } else if (!hasValidSignature(intent.mimeType, object.bytes)) {
      error = new AttachmentContentInvalidException('ATTACHMENT_INVALID_CONTENT');
    }
    if (error !== undefined) {
      const removed = await this.storage.remove(intent.path);
      if (!removed) this.logger.error({ intentId: intent.intentId }, 'ORPHANED_STORAGE_UPLOAD');
      throw error;
    }
  }

  private async findByPath(path: string): Promise<AttachmentRow | null> {
    return this.prisma.attachment.findUnique({
      include: { uploadedByUser: { select: { fullName: true } } },
      where: { storagePath: path },
    });
  }

  private async findActiveAttachment(id: string): Promise<AttachmentRow> {
    const attachment = await this.prisma.attachment.findFirst({
      include: { uploadedByUser: { select: { fullName: true } } },
      where: { entityType: AttachmentEntityType.MACHINE, id },
    });
    if (attachment === null) throw new AttachmentNotFoundException();
    const machine = await this.prisma.machine.findFirst({
      select: { id: true },
      where: { deletedAt: null, id: attachment.entityId },
    });
    if (machine === null) throw new AttachmentNotFoundException();
    return attachment;
  }
}
