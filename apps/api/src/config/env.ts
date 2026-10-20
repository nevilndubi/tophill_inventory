import 'dotenv/config';
import { z } from 'zod';

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const requiredUrl = z.preprocess(
  (value) => value ?? '',
  z.string().min(1, 'is required').pipe(z.url('must be a valid URL')),
);

const optionalUrl = z.preprocess(blankToUndefined, z.url('must be a valid URL').optional());

const optionalSecret = z.preprocess(
  blankToUndefined,
  z.string().min(1, 'must not be empty').optional(),
);

const apiEnvironmentSchema = z.object({
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65_535).default(3001)),
  WEB_ORIGIN: requiredUrl,
  DATABASE_URL: optionalUrl,
  DIRECT_URL: optionalUrl,
  REDIS_URL: optionalUrl,
  SUPABASE_URL: optionalUrl,
  SUPABASE_SERVICE_ROLE_KEY: optionalSecret,
  SUPABASE_JWT_ISSUER: optionalUrl,
  SUPABASE_JWKS_URL: optionalUrl,
  RESEND_API_KEY: optionalSecret,
  SENTRY_DSN: optionalUrl,
});

const formatEnvironmentError = (error: z.ZodError): string => {
  const details = error.issues
    .map((issue) => `- ${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('\n');

  return `[api] Invalid environment variables:\n${details}`;
};

const result = apiEnvironmentSchema.safeParse(process.env);

if (!result.success) {
  throw new Error(formatEnvironmentError(result.error));
}

export const env = result.data;
