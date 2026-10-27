import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { config as loadEnvironment } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { PrismaClient } from '../apps/api/src/generated/prisma/client';
import { AttachmentIntentService } from '../apps/api/src/attachments/attachment-intent.service';
import { AttachmentsService } from '../apps/api/src/attachments/attachments.service';
import type { SupabaseStorageService } from '../apps/api/src/attachments/supabase-storage.service';
import { AuditService } from '../apps/api/src/audit/audit.service';
import type { AuthenticatedUser } from '../apps/api/src/auth/auth.types';
import type { ApiEnvironment } from '../apps/api/src/config/env';
import type { PrismaService } from '../apps/api/src/prisma/prisma.service';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
  type NeonBranch,
} from '../prisma/neon-safe-cli';

loadEnvironment({ path: 'apps/api/.env', quiet: true });
loadEnvironment({ path: 'apps/web/.env.local', quiet: true });
loadEnvironment({ path: 'apps/api/.env.task-2.1.local', quiet: true });

const requireValue = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required live-proof configuration: ${name}`);
  return value;
};
const projectId = requireValue('NEON_PROJECT_ID');
const supabaseUrl = requireValue('SUPABASE_URL');
const supabaseSecret = requireValue('SUPABASE_SECRET_KEY');
const publishableKey = requireValue('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
const testEmail = requireValue('SUPABASE_AUTH_TEST_EMAIL');
const testPassword = requireValue('SUPABASE_AUTH_TEST_PASSWORD');
const proofPrefix = `task-3.5-proof-${randomUUID()}`;
const bucketName = `${proofPrefix}-bucket`;

const runQuietly = (args: string[], environment: NodeJS.ProcessEnv): void => {
  const result = spawnSync('pnpm', args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 30 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`pnpm ${args[0] ?? ''} failed safely`);
};
const hostname = (url: string): string => new URL(url).hostname;
const clientFor = (connectionString: string): PrismaClient =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString, max: 5 }) });

class TemporaryBucketAdapter {
  constructor(
    private readonly client: SupabaseClient,
    private readonly bucket: string,
  ) {}

  async createSignedUpload(path: string): Promise<string> {
    const result = await this.client.storage
      .from(this.bucket)
      .createSignedUploadUrl(path, { upsert: false });
    if (result.error !== null) throw new Error('Temporary signed upload creation failed');
    return result.data.signedUrl;
  }

  async inspect(path: string) {
    const slash = path.lastIndexOf('/');
    const folder = path.slice(0, slash);
    const name = path.slice(slash + 1);
    const bucket = this.client.storage.from(this.bucket);
    const listed = await bucket.list(folder, { limit: 2, search: name });
    if (listed.error !== null) throw new Error('Temporary object metadata check failed');
    const object = listed.data.find((candidate) => candidate.id && candidate.name === name);
    if (!object) throw new Error('Temporary object was not found');
    const downloaded = await bucket.download(path, {}, { cache: 'no-store' });
    if (downloaded.error !== null) throw new Error('Temporary object verification failed');
    const bytes = new Uint8Array(await downloaded.data.arrayBuffer());
    const metadata = object.metadata as Record<string, unknown> | null;
    return {
      bytes,
      contentType:
        typeof metadata?.mimetype === 'string' ? metadata.mimetype : downloaded.data.type || null,
      sizeBytes: typeof metadata?.size === 'number' ? metadata.size : bytes.byteLength,
    };
  }

  async createSignedDownload(path: string, fileName: string, expiresIn: number): Promise<string> {
    const result = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(path, expiresIn, { download: fileName });
    if (result.error !== null) throw new Error('Temporary signed download creation failed');
    return result.data.signedUrl;
  }

  async remove(path: string): Promise<boolean> {
    const result = await this.client.storage.from(this.bucket).remove([path]);
    return result.error === null;
  }
}

const upload = async (url: string, bytes: Uint8Array, mimeType: string): Promise<Response> => {
  const body = new FormData();
  body.append('cacheControl', '3600');
  const arrayBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  body.append('', new Blob([arrayBuffer], { type: mimeType }));
  return fetch(url, { body, headers: { 'x-upsert': 'false' }, method: 'PUT' });
};

const errorCode = (error: unknown): string =>
  typeof error === 'object' &&
  error !== null &&
  'response' in error &&
  typeof error.response === 'object' &&
  error.response !== null &&
  'code' in error.response
    ? String(error.response.code)
    : 'unknown';

const protectedProofCount = async (connectionString: string): Promise<number> => {
  const prisma = clientFor(connectionString);
  try {
    const table = await prisma.$queryRaw<Array<{ name: string | null }>>`
      SELECT to_regclass('public.attachments')::text AS name
    `;
    if (!table[0]?.name) return 0;
    return await prisma.attachment.count({ where: { fileName: { startsWith: proofPrefix } } });
  } finally {
    await prisma.$disconnect();
  }
};

const main = async (): Promise<void> => {
  let branch: NeonBranch | undefined;
  let prisma: PrismaClient | undefined;
  const admin = createClient(supabaseUrl, supabaseSecret, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
  });
  let bucketCreated = false;
  try {
    const auth = createClient(supabaseUrl, publishableKey, {
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    });
    const signedIn = await auth.auth.signInWithPassword({
      email: testEmail,
      password: testPassword,
    });
    if (signedIn.error !== null || !signedIn.data.user?.id || !signedIn.data.user.email) {
      throw new Error('Dedicated test identity sign-in failed safely');
    }

    const createdBucket = await admin.storage.createBucket(bucketName, {
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
      fileSizeLimit: 10 * 1024 * 1024,
      public: false,
    });
    if (createdBucket.error !== null) throw new Error('Temporary proof bucket creation failed');
    bucketCreated = true;

    const mainPooled = getNeonConnectionStringCaptured(projectId, 'main', true);
    const stagingPooled = getNeonConnectionStringCaptured(projectId, 'staging', true);
    const devPooled = getNeonConnectionStringCaptured(projectId, 'dev', true);
    const suffix = new Date()
      .toISOString()
      .replaceAll(/[-:.TZ]/gu, '')
      .slice(0, 12);
    branch = createNeonBranchSafely(
      projectId,
      'main',
      `ephemeral/task-3.5-attachments-${suffix}`,
      new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    );
    const pooled = getNeonConnectionStringCaptured(projectId, branch.id, true);
    const direct = getNeonConnectionStringCaptured(projectId, branch.id, false);
    const databaseEnvironment = {
      ...process.env,
      CI: 'false',
      DATABASE_URL: pooled,
      DIRECT_URL: direct,
      INTEGRATION_DATABASE_BRANCH: branch.name,
      INTEGRATION_DATABASE_URL: pooled,
      SEED_ALLOWED_BRANCH: branch.name,
      SEED_ALLOWED_HOST: hostname(pooled),
      SEED_PROTECTED_HOSTS: [hostname(mainPooled), hostname(stagingPooled)].join(','),
    };
    runQuietly(['prisma:migrate:deploy'], databaseEnvironment);
    runQuietly(['db:seed'], databaseEnvironment);
    prisma = clientFor(pooled);
    const localUser = await prisma.user.upsert({
      create: {
        email: signedIn.data.user.email.toLowerCase(),
        fullName: 'Task 3.5 proof technician',
        isActive: true,
        isSeedData: false,
        role: 'BIOMED_TECH',
        supabaseUserId: signedIn.data.user.id,
      },
      update: { isActive: true, role: 'BIOMED_TECH' },
      where: { supabaseUserId: signedIn.data.user.id },
    });
    const machine = await prisma.machine.findFirstOrThrow({
      orderBy: { assetTag: 'asc' },
      where: { deletedAt: null },
    });
    const actor: AuthenticatedUser = {
      department: null,
      email: 'redacted',
      fullName: localUser.fullName,
      id: localUser.id,
      isActive: true,
      role: 'BIOMED_TECH',
    };
    const temporaryStorage = new TemporaryBucketAdapter(admin, bucketName);
    const config = {
      get: (key: keyof ApiEnvironment) => {
        if (key === 'SUPABASE_SECRET_KEY') return supabaseSecret;
        return process.env[key];
      },
    } as unknown as ConstructorParameters<typeof AttachmentIntentService>[0];
    const service = new AttachmentsService(
      prisma as unknown as PrismaService,
      new AuditService(),
      temporaryStorage as unknown as SupabaseStorageService,
      new AttachmentIntentService(config),
    );
    const png = new Uint8Array(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlN6r8AAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const pdf = new Uint8Array(Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF'));
    const accepted: string[] = [];
    for (const [name, mimeType, bytes] of [
      [`${proofPrefix}.png`, 'image/png', png],
      [`${proofPrefix}.pdf`, 'application/pdf', pdf],
    ] as const) {
      const signed = await service.requestUpload(actor, machine.id, {
        fileName: name,
        mimeType,
        sizeBytes: bytes.byteLength,
      });
      const response = await upload(signed.uploadUrl, bytes, mimeType);
      if (!response.ok) throw new Error('Valid temporary fixture upload failed');
      const confirmed = await service.confirm(
        actor,
        { intentToken: signed.intentToken },
        `proof-${randomUUID()}`,
      );
      accepted.push(confirmed.id);
    }

    const fake = new Uint8Array(Buffer.from('not a png'));
    const fakeSigned = await service.requestUpload(actor, machine.id, {
      fileName: `${proofPrefix}-fake.png`,
      mimeType: 'image/png',
      sizeBytes: fake.byteLength,
    });
    if (!(await upload(fakeSigned.uploadUrl, fake, 'image/png')).ok) {
      throw new Error('Fake-image upload could not reach confirmation');
    }
    let fakeCode = 'none';
    try {
      await service.confirm(
        actor,
        { intentToken: fakeSigned.intentToken },
        `proof-${randomUUID()}`,
      );
    } catch (error: unknown) {
      fakeCode = errorCode(error);
    }
    if (fakeCode !== 'ATTACHMENT_INVALID_CONTENT') {
      throw new Error('Fake-image signature rejection did not return the stable code');
    }

    const oversizedPath = `machines/${machine.id}/${randomUUID()}.png`;
    const oversizedSigned = await temporaryStorage.createSignedUpload(oversizedPath);
    const oversized = new Uint8Array(10 * 1024 * 1024 + 1);
    const oversizedResponse = await upload(oversizedSigned, oversized, 'image/png');
    if (oversizedResponse.ok) throw new Error('Temporary bucket accepted an oversized object');

    const first = await prisma.attachment.findUniqueOrThrow({ where: { id: accepted[0] } });
    const publicUrl = `${supabaseUrl}/storage/v1/object/public/${bucketName}/${first.storagePath}`;
    const privateResponse = await fetch(publicUrl);
    if (privateResponse.ok) throw new Error('Private object was anonymously readable');

    const expiring = await admin.storage.from(bucketName).createSignedUrl(first.storagePath, 1);
    if (expiring.error !== null) throw new Error('Temporary expiry proof URL creation failed');
    await new Promise((resolve) => setTimeout(resolve, 2200));
    const expiredResponse = await fetch(expiring.data.signedUrl);
    if (expiredResponse.ok) throw new Error('Expired signed URL remained readable');

    for (const id of accepted) await service.delete(actor, id, `proof-${randomUUID()}`);
    const remainingRows = await prisma.attachment.count({
      where: { fileName: { startsWith: proofPrefix } },
    });
    const remainingObjects = await admin.storage.from(bucketName).list('machines', { limit: 100 });
    if (remainingRows !== 0 || remainingObjects.error !== null) {
      throw new Error('Proof cleanup verification failed');
    }
    console.log(
      JSON.stringify({
        acceptedFixtures: 2,
        attachmentRowsAfterDelete: remainingRows,
        dedicatedIdentityUsed: true,
        directAnonymousReadStatus: privateResponse.status,
        expiredSignedReadStatus: expiredResponse.status,
        fakeImageError: fakeCode,
        oversizedUploadStatus: oversizedResponse.status,
      }),
    );

    await prisma.$disconnect();
    prisma = undefined;
    deleteNeonBranchSafely(projectId, branch.id);
    branch = undefined;
    const protectedCounts = await Promise.all([
      protectedProofCount(devPooled),
      protectedProofCount(stagingPooled),
      protectedProofCount(mainPooled),
    ]);
    console.log(
      JSON.stringify({
        disposableBranchDeleted: true,
        protectedBranchProofRows: {
          dev: protectedCounts[0],
          main: protectedCounts[2],
          staging: protectedCounts[1],
        },
      }),
    );
  } finally {
    if (prisma) await prisma.$disconnect();
    if (branch) deleteNeonBranchSafely(projectId, branch.id);
    if (bucketCreated) {
      const objects = await admin.storage.from(bucketName).list('machines', { limit: 100 });
      if (objects.data) {
        for (const folder of objects.data.filter((item) => item.id === null)) {
          const nested = await admin.storage.from(bucketName).list(`machines/${folder.name}`, {
            limit: 100,
          });
          if (nested.data && nested.data.length > 0) {
            await admin.storage
              .from(bucketName)
              .remove(nested.data.map((item) => `machines/${folder.name}/${item.name}`));
          }
        }
      }
      await admin.storage.emptyBucket(bucketName);
      await admin.storage.deleteBucket(bucketName);
      console.log(JSON.stringify({ proofBucketDeleted: true }));
    }
  }
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Attachment live proof failed safely');
  process.exitCode = 1;
});
