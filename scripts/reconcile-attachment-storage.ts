import { config as loadEnvironment } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient } from '../apps/api/src/generated/prisma/client';

loadEnvironment({ path: process.env.API_ENV_FILE ?? 'apps/api/.env', quiet: true });

const requireValue = (name: 'DATABASE_URL' | 'SUPABASE_SECRET_KEY' | 'SUPABASE_URL'): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
};

const deleteOrphans = process.argv.includes('--delete');
const bucketName = process.env.ATTACHMENT_STORAGE_BUCKET?.trim() || 'machine-attachments';
const cutoff = Date.now() - 24 * 60 * 60 * 1000;
const supabase = createClient(requireValue('SUPABASE_URL'), requireValue('SUPABASE_SECRET_KEY'), {
  auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
});
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: requireValue('DATABASE_URL'), max: 2 }),
});

type FileObject = {
  created_at: string | null;
  id: string | null;
  name: string;
};

const list = async (prefix: string): Promise<FileObject[]> => {
  const found: FileObject[] = [];
  let offset = 0;
  while (true) {
    const result = await supabase.storage.from(bucketName).list(prefix, {
      limit: 100,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (result.error !== null) throw new Error('Storage reconciliation list failed');
    found.push(...result.data);
    if (result.data.length < 100) return found;
    offset += result.data.length;
  }
};

const main = async (): Promise<void> => {
  try {
    const machineFolders = await list('machines');
    const databasePaths = new Set(
      (await prisma.attachment.findMany({ select: { storagePath: true } })).map(
        (attachment) => attachment.storagePath,
      ),
    );
    const orphans: Array<{ id: string; path: string }> = [];
    for (const folder of machineFolders.filter((item) => item.id === null)) {
      const objects = await list(`machines/${folder.name}`);
      for (const object of objects) {
        if (object.id === null || object.created_at === null) continue;
        const path = `machines/${folder.name}/${object.name}`;
        if (new Date(object.created_at).getTime() < cutoff && !databasePaths.has(path)) {
          orphans.push({ id: object.id, path });
        }
      }
    }
    if (deleteOrphans && orphans.length > 0) {
      const removed = await supabase.storage
        .from(bucketName)
        .remove(orphans.map((orphan) => orphan.path));
      if (removed.error !== null) throw new Error('Storage reconciliation delete failed');
    }
    console.log(
      JSON.stringify({
        action: deleteOrphans ? 'deleted' : 'read-only',
        objectIds: orphans.map((orphan) => orphan.id).sort(),
        orphanCount: orphans.length,
      }),
    );
  } finally {
    await prisma.$disconnect();
  }
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Storage reconciliation failed');
  process.exitCode = 1;
});
