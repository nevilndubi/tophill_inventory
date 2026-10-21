import { spawnSync } from 'node:child_process';

type JsonObject = Record<string, unknown>;

export type NeonBranch = { id: string; name: string };

const redactDatabaseUrls = (value: string): string =>
  value.replaceAll(/postgres(?:ql)?:\/\/\S+/gi, '[database-url-redacted]');

const runCaptured = (args: string[]): string => {
  const result = spawnSync('neon', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(
      `Neon CLI command failed: ${redactDatabaseUrls(result.stderr || 'no diagnostic provided')}`,
    );
  }

  return result.stdout.trim();
};

const findBranch = (value: unknown, requestedName: string): NeonBranch | undefined => {
  if (Array.isArray(value)) {
    for (const item of value) {
      const branch = findBranch(item, requestedName);
      if (branch) return branch;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;

  const record = value as JsonObject;
  if (
    typeof record.id === 'string' &&
    typeof record.name === 'string' &&
    record.name === requestedName
  ) {
    return { id: record.id, name: record.name };
  }
  for (const child of Object.values(record)) {
    const branch = findBranch(child, requestedName);
    if (branch) return branch;
  }
  return undefined;
};

export const createNeonBranchSafely = (
  projectId: string,
  parent: string,
  name: string,
  expiresAt: string,
): NeonBranch => {
  const output = runCaptured([
    'branches',
    'create',
    '--project-id',
    projectId,
    '--parent',
    parent,
    '--name',
    name,
    '--expires-at',
    expiresAt,
    '--no-secrets',
    '--output',
    'json',
  ]);
  const branch = findBranch(JSON.parse(output) as unknown, name);
  if (!branch) throw new Error('Neon CLI returned no matching non-secret branch metadata');
  return branch;
};

export const getNeonConnectionStringCaptured = (
  projectId: string,
  branch: string,
  pooled: boolean,
): string =>
  runCaptured([
    'connection-string',
    branch,
    '--project-id',
    projectId,
    '--ssl',
    'verify-full',
    ...(pooled ? ['--pooled'] : []),
  ]);

export const deleteNeonBranchSafely = (projectId: string, branchId: string): void => {
  runCaptured(['branches', 'delete', branchId, '--project-id', projectId, '--output', 'json']);
};
