import { config as loadEnvironment } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

loadEnvironment({ path: process.env.API_ENV_FILE ?? 'apps/api/.env', quiet: true });

const requireValue = (name: 'SUPABASE_SECRET_KEY' | 'SUPABASE_URL'): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
};

export const MACHINE_ATTACHMENTS_BUCKET = 'machine-attachments';
export const MACHINE_ATTACHMENTS_BUCKET_OPTIONS = {
  allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  fileSizeLimit: 10 * 1024 * 1024,
  public: false,
};

const main = async (): Promise<void> => {
  const client = createClient(requireValue('SUPABASE_URL'), requireValue('SUPABASE_SECRET_KEY'), {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  const existing = await client.storage.getBucket(MACHINE_ATTACHMENTS_BUCKET);
  const operation =
    existing.data === null
      ? await client.storage.createBucket(
          MACHINE_ATTACHMENTS_BUCKET,
          MACHINE_ATTACHMENTS_BUCKET_OPTIONS,
        )
      : await client.storage.updateBucket(
          MACHINE_ATTACHMENTS_BUCKET,
          MACHINE_ATTACHMENTS_BUCKET_OPTIONS,
        );
  if (operation.error !== null) throw new Error('Supabase Storage bucket configuration failed');
  const verified = await client.storage.getBucket(MACHINE_ATTACHMENTS_BUCKET);
  if (verified.error !== null || verified.data === null) {
    throw new Error('Supabase Storage bucket verification failed');
  }
  const allowed = [...(verified.data.allowed_mime_types ?? [])].sort();
  const expected = [...MACHINE_ATTACHMENTS_BUCKET_OPTIONS.allowedMimeTypes].sort();
  if (
    verified.data.public !== false ||
    verified.data.file_size_limit !== MACHINE_ATTACHMENTS_BUCKET_OPTIONS.fileSizeLimit ||
    JSON.stringify(allowed) !== JSON.stringify(expected)
  ) {
    throw new Error('Supabase Storage bucket does not match the required private configuration');
  }
  console.log(
    JSON.stringify({
      allowedMimeTypeCount: allowed.length,
      bucket: MACHINE_ATTACHMENTS_BUCKET,
      fileSizeLimitBytes: verified.data.file_size_limit,
      private: !verified.data.public,
      status: existing.data === null ? 'created-and-verified' : 'updated-and-verified',
    }),
  );
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Storage bucket configuration failed');
  process.exitCode = 1;
});
