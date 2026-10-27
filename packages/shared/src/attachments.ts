import { z } from 'zod';

export const ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_PER_MACHINE = 20;

const removeControlCharacters = (value: string): string =>
  [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return !((codePoint >= 0 && codePoint <= 31) || (codePoint >= 127 && codePoint <= 159));
    })
    .join('');

const cleanDisplayName = (value: string): string =>
  removeControlCharacters(value.normalize('NFC').replace(/[\\/]+/g, '_'))
    .replace(/\s+/g, ' ')
    .trim();

export const attachmentIdParamsSchema = z.strictObject({ id: z.uuid() });
export const machineAttachmentParamsSchema = z.strictObject({ machineId: z.uuid() });

export const requestAttachmentUploadSchema = z.strictObject({
  fileName: z
    .string()
    .transform(cleanDisplayName)
    .pipe(z.string().min(1, 'File name is required').max(180, 'File name is too long')),
  mimeType: z.enum(ATTACHMENT_MIME_TYPES, { error: 'File type is not allowed' }),
  sizeBytes: z
    .number()
    .int('File size must be a whole number')
    .min(1, 'File must not be empty')
    .max(ATTACHMENT_MAX_BYTES, 'File must be 10 MiB or smaller'),
});

export const confirmAttachmentUploadSchema = z.strictObject({
  intentToken: z.string().min(1).max(4096),
});

export type RequestAttachmentUploadInput = z.infer<typeof requestAttachmentUploadSchema>;
export type ConfirmAttachmentUploadInput = z.infer<typeof confirmAttachmentUploadSchema>;

export type AttachmentTypeLabel = 'JPEG image' | 'PDF document' | 'PNG image' | 'WebP image';

export type ManagedMachineAttachment = {
  id: string;
  fileName: string;
  typeLabel: AttachmentTypeLabel;
  sizeBytes: number;
  uploadedAt: string;
  uploader: { fullName: string };
};

export type SignedAttachmentUpload = {
  intentToken: string;
  uploadUrl: string;
  expiresAt: string;
};

export type SignedAttachmentDownload = {
  url: string;
  expiresAt: string;
};
