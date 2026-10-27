import type {
  ConfirmAttachmentUploadInput,
  ManagedMachineAttachment,
  RequestAttachmentUploadInput,
  SignedAttachmentDownload,
  SignedAttachmentUpload,
} from '@app/shared';
import { browserApi } from './browser-client';

export type UploadProgress = { loaded: number; percent: number; total: number };

export const uploadToSignedUrl = (
  uploadUrl: string,
  file: File,
  onProgress: (progress: UploadProgress) => void,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();
    signal.addEventListener('abort', abort, { once: true });
    request.open('PUT', uploadUrl);
    request.setRequestHeader('x-upsert', 'false');
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      onProgress({
        loaded: event.loaded,
        percent: Math.round((event.loaded / event.total) * 100),
        total: event.total,
      });
    });
    request.addEventListener('load', () => {
      signal.removeEventListener('abort', abort);
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error('Storage upload failed'));
    });
    request.addEventListener('error', () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('Storage upload failed'));
    });
    request.addEventListener('abort', () => {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Upload cancelled', 'AbortError'));
    });
    const body = new FormData();
    body.append('cacheControl', '3600');
    body.append('', file);
    request.send(body);
  });

export const attachmentsApi = {
  confirm(input: ConfirmAttachmentUploadInput): Promise<ManagedMachineAttachment> {
    return browserApi.request<ManagedMachineAttachment>('/attachments/confirm', {
      body: JSON.stringify(input),
      method: 'POST',
    });
  },
  delete(id: string): Promise<ManagedMachineAttachment> {
    return browserApi.request<ManagedMachineAttachment>(`/attachments/${id}`, {
      method: 'DELETE',
    });
  },
  download(id: string): Promise<SignedAttachmentDownload> {
    return browserApi.request<SignedAttachmentDownload>(`/attachments/${id}/url`);
  },
  list(machineId: string): Promise<readonly ManagedMachineAttachment[]> {
    return browserApi.request<readonly ManagedMachineAttachment[]>(
      `/machines/${machineId}/attachments`,
    );
  },
  requestUpload(
    machineId: string,
    input: RequestAttachmentUploadInput,
  ): Promise<SignedAttachmentUpload> {
    return browserApi.request<SignedAttachmentUpload>(
      `/machines/${machineId}/attachments/sign-upload`,
      { body: JSON.stringify(input), method: 'POST' },
    );
  },
};
