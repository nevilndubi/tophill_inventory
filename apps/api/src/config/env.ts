import 'dotenv/config';
import { z } from 'zod';

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const requiredUrl = z.preprocess(
  (value) => value ?? '',
  z.string().min(1, 'is required').pipe(z.url('must be a valid URL')),
);

const requiredPostgresUrl = z.preprocess(
  (value) => value ?? '',
  z
    .string()
    .min(1, 'is required')
    .pipe(z.url('must be a valid URL'))
    .refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol), {
      message: 'must use the postgres:// or postgresql:// protocol',
    }),
);

const optionalUrl = z.preprocess(blankToUndefined, z.url('must be a valid URL').optional());

const optionalSecret = z.preprocess(
  blankToUndefined,
  z.string().min(1, 'must not be empty').optional(),
);

const optionalEmail = z.preprocess(
  blankToUndefined,
  z
    .email('must be a valid email address')
    .transform((value) => value.toLowerCase())
    .optional(),
);

const requiredSupabaseSecretKey = z.preprocess(
  (value) => value ?? '',
  z.string().min(1, 'is required').startsWith('sb_secret_', 'must be a modern sb_secret_ key'),
);

const redisUrl = z.preprocess(
  blankToUndefined,
  z
    .url('must be a valid URL')
    .refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol), {
      message: 'must use the redis:// or rediss:// protocol',
    })
    .default('redis://127.0.0.1:6379'),
);

const apiEnvironmentInputSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65_535).default(3001)),
    READINESS_DB_TIMEOUT_MS: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(100).max(10_000).default(3000),
    ),
    WEB_ORIGIN: requiredUrl,
    DATABASE_URL: requiredPostgresUrl,
    DIRECT_URL: requiredPostgresUrl,
    REDIS_URL: redisUrl,
    SUPABASE_URL: requiredUrl,
    SUPABASE_SECRET_KEY: requiredSupabaseSecretKey,
    SUPABASE_JWT_ISSUER: optionalUrl,
    SUPABASE_JWKS_URL: optionalUrl,
    BOOTSTRAP_SUPER_ADMIN_EMAIL: optionalEmail,
    RESEND_API_KEY: optionalSecret,
    SENTRY_DSN: optionalUrl,
  })
  .superRefine((environment, context) => {
    if (
      environment.NODE_ENV === 'production' &&
      new URL(environment.REDIS_URL).protocol !== 'rediss:'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must be explicitly configured with a rediss:// URL in production',
        path: ['REDIS_URL'],
      });
    }

    const supabaseBaseUrl = environment.SUPABASE_URL.replace(/\/$/, '');
    const expectedIssuer = `${supabaseBaseUrl}/auth/v1`;
    const expectedJwksUrl = `${expectedIssuer}/.well-known/jwks.json`;

    if (
      environment.SUPABASE_JWT_ISSUER !== undefined &&
      environment.SUPABASE_JWT_ISSUER.replace(/\/$/, '') !== expectedIssuer
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must match SUPABASE_URL/auth/v1',
        path: ['SUPABASE_JWT_ISSUER'],
      });
    }

    if (
      environment.SUPABASE_JWKS_URL !== undefined &&
      environment.SUPABASE_JWKS_URL !== expectedJwksUrl
    ) {
      context.addIssue({
        code: 'custom',
        message: 'must match SUPABASE_URL/auth/v1/.well-known/jwks.json',
        path: ['SUPABASE_JWKS_URL'],
      });
    }

    if (environment.BOOTSTRAP_SUPER_ADMIN_EMAIL?.endsWith('.invalid')) {
      context.addIssue({
        code: 'custom',
        message: 'must not use a reserved .invalid address',
        path: ['BOOTSTRAP_SUPER_ADMIN_EMAIL'],
      });
    }
  })
  .transform((environment) => {
    const supabaseBaseUrl = environment.SUPABASE_URL.replace(/\/$/, '');
    const supabaseIssuer = `${supabaseBaseUrl}/auth/v1`;

    return {
      ...environment,
      SUPABASE_URL: supabaseBaseUrl,
      SUPABASE_JWT_ISSUER: supabaseIssuer,
      SUPABASE_JWKS_URL: `${supabaseIssuer}/.well-known/jwks.json`,
    };
  });

export const apiEnvironmentSchema = apiEnvironmentInputSchema;

export type ApiEnvironment = z.infer<typeof apiEnvironmentSchema>;

const formatEnvironmentError = (error: z.ZodError): string => {
  const details = error.issues
    .map((issue) => `- ${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('\n');

  return `[api] Invalid environment variables:\n${details}`;
};

export const parseApiEnvironment = (input: Record<string, unknown>): ApiEnvironment => {
  const result = apiEnvironmentSchema.safeParse(input);

  if (!result.success) {
    throw new Error(formatEnvironmentError(result.error));
  }

  return result.data;
};

export const env = parseApiEnvironment(process.env);
