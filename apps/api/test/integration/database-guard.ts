const ALLOWED_BRANCH_PREFIXES = ['ci/', 'test/', 'ephemeral/'];
const PROTECTED_BRANCHES = new Set(['main', 'staging', 'dev']);

export type IntegrationDatabaseConfiguration = {
  branch: string;
  url: string;
};

const requireValue = (value: string | undefined, name: string): string => {
  const normalized = value?.trim();

  if (!normalized) {
    throw new Error(`${name} is required for the explicit database integration suite`);
  }

  return normalized;
};

export const assertSafeIntegrationDatabaseEnvironment = (
  environment: NodeJS.ProcessEnv,
): IntegrationDatabaseConfiguration => {
  const url = requireValue(environment.INTEGRATION_DATABASE_URL, 'INTEGRATION_DATABASE_URL');
  const branch = requireValue(
    environment.INTEGRATION_DATABASE_BRANCH,
    'INTEGRATION_DATABASE_BRANCH',
  );

  if (
    PROTECTED_BRANCHES.has(branch) ||
    !ALLOWED_BRANCH_PREFIXES.some((prefix) => branch.startsWith(prefix))
  ) {
    throw new Error(
      'INTEGRATION_DATABASE_BRANCH must name a dedicated ci/, test/, or ephemeral/ branch; main, staging, and dev are forbidden',
    );
  }

  if ([environment.DATABASE_URL, environment.DIRECT_URL].some((value) => value?.trim() === url)) {
    throw new Error(
      'INTEGRATION_DATABASE_URL must not equal DATABASE_URL or DIRECT_URL; use a dedicated ephemeral branch',
    );
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('INTEGRATION_DATABASE_URL must be a valid URL');
  }

  if (
    !['postgres:', 'postgresql:'].includes(parsedUrl.protocol) ||
    !parsedUrl.hostname.endsWith('.neon.tech')
  ) {
    throw new Error('INTEGRATION_DATABASE_URL must be a PostgreSQL URL for a Neon branch');
  }

  return { branch, url };
};
