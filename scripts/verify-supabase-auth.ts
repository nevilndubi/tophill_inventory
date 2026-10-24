import { config as loadEnvironment } from 'dotenv';

type JsonRecord = Record<string, unknown>;

const environmentFile = process.env.SUPABASE_AUTH_PROOF_ENV_FILE ?? 'apps/api/.env.task-2.1.local';

loadEnvironment({ path: environmentFile, quiet: true });

const requireEnvironmentValue = (name: string): string => {
  const value = process.env[name];

  if (value === undefined || value.trim() === '') {
    throw new Error(`Missing required proof configuration: ${name}`);
  }

  return value;
};

const readErrorCode = (value: unknown): string => {
  if (typeof value !== 'object' || value === null) {
    return 'unknown_error';
  }

  const record = value as JsonRecord;
  for (const candidate of [record.error_code, record.code, record.error]) {
    if (typeof candidate === 'string') {
      return candidate;
    }
  }

  return 'unknown_error';
};

const decodeJwtSegment = (segment: string): JsonRecord => {
  const decoded: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));

  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('Supabase returned a JWT with an invalid JSON segment');
  }

  return decoded as JsonRecord;
};

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

const main = async (): Promise<void> => {
  const supabaseUrl = requireEnvironmentValue('SUPABASE_URL').replace(/\/$/, '');
  const publishableKey = requireEnvironmentValue('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  const testEmail = requireEnvironmentValue('SUPABASE_AUTH_TEST_EMAIL');
  const testPassword = requireEnvironmentValue('SUPABASE_AUTH_TEST_PASSWORD');
  const authUrl = `${supabaseUrl}/auth/v1`;
  const commonHeaders = {
    apikey: publishableKey,
    'Content-Type': 'application/json',
  };

  const validSignIn = await fetch(`${authUrl}/token?grant_type=password`, {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify({ email: testEmail, password: testPassword }),
  });
  const validSignInBody = await readJson(validSignIn);

  if (!validSignIn.ok || typeof validSignInBody !== 'object' || validSignInBody === null) {
    throw new Error(
      `Valid password sign-in failed safely (${validSignIn.status}, ${readErrorCode(validSignInBody)})`,
    );
  }

  const accessToken = (validSignInBody as JsonRecord).access_token;

  if (typeof accessToken !== 'string') {
    throw new Error('Valid password sign-in did not return an access token');
  }

  const tokenSegments = accessToken.split('.');

  if (
    tokenSegments.length !== 3 ||
    tokenSegments[0] === undefined ||
    tokenSegments[1] === undefined
  ) {
    throw new Error('Supabase returned a malformed JWT');
  }

  const tokenHeader = decodeJwtSegment(tokenSegments[0]);
  const tokenClaims = decodeJwtSegment(tokenSegments[1]);
  const expectedIssuer = `${authUrl}`;

  if (
    tokenHeader.alg !== 'ES256' ||
    typeof tokenHeader.kid !== 'string' ||
    tokenClaims.iss !== expectedIssuer ||
    tokenClaims.aud !== 'authenticated' ||
    tokenClaims.role !== 'authenticated' ||
    typeof tokenClaims.exp !== 'number'
  ) {
    throw new Error(
      'The JWT metadata does not match the expected asymmetric Supabase configuration',
    );
  }

  const jwksResponse = await fetch(`${authUrl}/.well-known/jwks.json`);
  const jwksBody = await readJson(jwksResponse);

  if (!jwksResponse.ok || typeof jwksBody !== 'object' || jwksBody === null) {
    throw new Error(`JWKS discovery failed safely (${jwksResponse.status})`);
  }

  const jwksKeys = (jwksBody as JsonRecord).keys;

  if (
    !Array.isArray(jwksKeys) ||
    !jwksKeys.some(
      (key) =>
        typeof key === 'object' &&
        key !== null &&
        (key as JsonRecord).kid === tokenHeader.kid &&
        (key as JsonRecord).alg === tokenHeader.alg,
    )
  ) {
    throw new Error('The JWT signing key is not advertised by the project JWKS endpoint');
  }

  const wrongPasswordResponse = await fetch(`${authUrl}/token?grant_type=password`, {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify({ email: testEmail, password: 'deliberately-wrong-password' }),
  });
  const wrongPasswordBody = await readJson(wrongPasswordResponse);

  if (wrongPasswordResponse.ok || readErrorCode(wrongPasswordBody) !== 'invalid_credentials') {
    throw new Error(
      `The wrong-password negative proof did not fail as expected (${wrongPasswordResponse.status}, ${readErrorCode(wrongPasswordBody)})`,
    );
  }

  const signupResponse = await fetch(`${authUrl}/signup`, {
    method: 'POST',
    headers: commonHeaders,
    body: JSON.stringify({
      email: `task-2-1-signup-${Date.now()}@example.invalid`,
      password: 'deliberately-unused-password',
    }),
  });
  const signupBody = await readJson(signupResponse);

  if (signupResponse.ok || readErrorCode(signupBody) !== 'signup_disabled') {
    throw new Error(
      `The public-signup negative proof did not fail as expected (${signupResponse.status}, ${readErrorCode(signupBody)})`,
    );
  }

  const expiresAt = new Date(tokenClaims.exp * 1_000).toISOString();
  const safeEvidence = {
    signIn: {
      status: validSignIn.status,
      jwt: {
        algorithm: tokenHeader.alg,
        keyIdPresent: true,
        issuer: tokenClaims.iss,
        audience: tokenClaims.aud,
        role: tokenClaims.role,
        expiresAt,
      },
      jwksKeyMatch: true,
    },
    wrongPassword: {
      status: wrongPasswordResponse.status,
      code: readErrorCode(wrongPasswordBody),
    },
    publicSignup: {
      status: signupResponse.status,
      code: readErrorCode(signupBody),
    },
  };

  console.log(JSON.stringify(safeEvidence, null, 2));
};

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown verification error';
  console.error(`[supabase-auth-proof] ${message}`);
  process.exitCode = 1;
});
