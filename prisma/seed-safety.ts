const ALLOWED_BRANCHES = new Set(['dev']);
const ALLOWED_BRANCH_PREFIXES = ['ci/', 'test/', 'ephemeral/', 'demo/'];
const PROTECTED_BRANCHES = new Set(['main', 'staging']);

export type SeedDatabaseConfiguration = {
  branch: string;
  url: string;
};

const requireValue = (value: string | undefined, name: string): string => {
  const normalized = value?.trim();

  if (!normalized) {
    throw new Error(`${name} is required for the explicit demo-data seed`);
  }

  return normalized;
};

const parseDatabaseUrl = (value: string, name: string): URL => {
  try {
    const parsed = new URL(value);

    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
      throw new Error('invalid protocol');
    }

    return parsed;
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL`);
  }
};

export const assertSafeSeedEnvironment = (
  environment: NodeJS.ProcessEnv,
): SeedDatabaseConfiguration => {
  if (environment.CI?.toLowerCase() === 'true') {
    throw new Error('Demo-data seeding is disabled in CI');
  }

  const url = requireValue(environment.DATABASE_URL, 'DATABASE_URL');
  const branch = requireValue(environment.SEED_ALLOWED_BRANCH, 'SEED_ALLOWED_BRANCH');
  const allowedHost = requireValue(environment.SEED_ALLOWED_HOST, 'SEED_ALLOWED_HOST');
  const protectedHostsValue = requireValue(
    environment.SEED_PROTECTED_HOSTS,
    'SEED_PROTECTED_HOSTS',
  );

  if (
    PROTECTED_BRANCHES.has(branch) ||
    (!ALLOWED_BRANCHES.has(branch) &&
      !ALLOWED_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix)))
  ) {
    throw new Error(
      'SEED_ALLOWED_BRANCH must be dev or a dedicated ci/, test/, ephemeral/, or demo/ branch; main and staging are forbidden',
    );
  }

  const parsedUrl = parseDatabaseUrl(url, 'DATABASE_URL');
  const protectedHosts = new Set(
    protectedHostsValue
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );

  if (protectedHosts.size === 0) {
    throw new Error('SEED_PROTECTED_HOSTS must list the production main and staging hosts');
  }

  if (parsedUrl.hostname.toLowerCase() !== allowedHost.toLowerCase()) {
    throw new Error('SEED_ALLOWED_HOST does not match the DATABASE_URL host');
  }

  if (protectedHosts.has(parsedUrl.hostname.toLowerCase())) {
    throw new Error('Refusing to seed a protected main or staging database host');
  }

  return { branch, url };
};
