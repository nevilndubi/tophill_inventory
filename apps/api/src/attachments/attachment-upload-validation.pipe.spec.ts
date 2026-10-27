import { ATTACHMENT_MAX_BYTES } from '@app/shared';
import { AttachmentUploadValidationPipe } from './attachment-upload-validation.pipe';

describe('AttachmentUploadValidationPipe', () => {
  const pipe = new AttachmentUploadValidationPipe();

  it('sanitizes display names without using them as paths', () => {
    expect(
      pipe.transform({
        fileName: '../Ward\\photo\u0000.png',
        mimeType: 'image/png',
        sizeBytes: 8,
      }),
    ).toEqual({ fileName: '.._Ward_photo.png', mimeType: 'image/png', sizeBytes: 8 });
  });

  it('returns stable type and size errors', () => {
    expect(() =>
      pipe.transform({ fileName: 'file.txt', mimeType: 'text/plain', sizeBytes: 8 }),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'ATTACHMENT_INVALID_TYPE' }),
      }),
    );
    expect(() =>
      pipe.transform({
        fileName: 'file.png',
        mimeType: 'image/png',
        sizeBytes: ATTACHMENT_MAX_BYTES + 1,
      }),
    ).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'ATTACHMENT_TOO_LARGE' }),
      }),
    );
  });
});
