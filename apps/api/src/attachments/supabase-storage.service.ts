import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { ApiEnvironment } from '../config/env';
import { MACHINE_ATTACHMENTS_BUCKET } from './attachments.constants';
import {
  AttachmentObjectMissingException,
  StorageUnavailableException,
} from './attachments.errors';

export type StoredObject = {
  bytes: Uint8Array;
  contentType: string | null;
  sizeBytes: number;
};

@Injectable()
export class SupabaseStorageService {
  private readonly client: SupabaseClient;

  constructor(config: ConfigService<ApiEnvironment, true>) {
    this.client = createClient(
      config.get('SUPABASE_URL', { infer: true }),
      config.get('SUPABASE_SECRET_KEY', { infer: true }),
      { auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false } },
    );
  }

  async createSignedUpload(path: string): Promise<string> {
    try {
      const { data, error } = await this.client.storage
        .from(MACHINE_ATTACHMENTS_BUCKET)
        .createSignedUploadUrl(path, { upsert: false });
      if (error !== null) throw error;
      return data.signedUrl;
    } catch {
      throw new StorageUnavailableException();
    }
  }

  async inspect(path: string): Promise<StoredObject> {
    const slash = path.lastIndexOf('/');
    const folder = path.slice(0, slash);
    const name = path.slice(slash + 1);

    try {
      const bucket = this.client.storage.from(MACHINE_ATTACHMENTS_BUCKET);
      const listed = await bucket.list(folder, { limit: 2, search: name });
      if (listed.error !== null) throw listed.error;
      const object = listed.data.find((candidate) => candidate.name === name && candidate.id);
      if (!object) throw new AttachmentObjectMissingException();
      const downloaded = await bucket.download(path, {}, { cache: 'no-store' });
      if (downloaded.error !== null) throw downloaded.error;
      const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
      const metadata = object.metadata as Record<string, unknown> | null;
      const metadataSize = metadata?.size;
      const metadataType = metadata?.mimetype;
      return {
        bytes,
        contentType: typeof metadataType === 'string' ? metadataType : downloaded.data.type || null,
        sizeBytes: typeof metadataSize === 'number' ? metadataSize : bytes.byteLength,
      };
    } catch (error: unknown) {
      if (error instanceof AttachmentObjectMissingException) throw error;
      throw new StorageUnavailableException();
    }
  }

  async createSignedDownload(path: string, fileName: string, expiresIn: number): Promise<string> {
    try {
      const { data, error } = await this.client.storage
        .from(MACHINE_ATTACHMENTS_BUCKET)
        .createSignedUrl(path, expiresIn, { download: fileName });
      if (error !== null) throw error;
      return data.signedUrl;
    } catch {
      throw new StorageUnavailableException();
    }
  }

  async remove(path: string): Promise<boolean> {
    try {
      const { error } = await this.client.storage.from(MACHINE_ATTACHMENTS_BUCKET).remove([path]);
      return error === null;
    } catch {
      return false;
    }
  }
}
