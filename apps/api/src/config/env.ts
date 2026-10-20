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

const redisUrl = z.preprocess(
  blankToUndefined,
  z
    .url('must be a valid URL')
    .refine((value) => ['redis:', 'rediss:'].includes(new URL(value).protocol), {
      message: 'must use the redis:// or rediss:// protocol',
    })
    .default('redis://127.0.0.1:6379'),
);

export const apiEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65_535).default(3001)),
    WEB_ORIGIN: requiredUrl,
    DATABASE_URL: optionalUrl,
    DIRECT_URL: optionalUrl,
    REDIS_URL: redisUrl,
    SUPABASE_URL: optionalUrl,
    SUPABASE_SERVICE_ROLE_KEY: optionalSecret,
    SUPABASE_JWT_ISSUER: optionalUrl,
    SUPABASE_JWKS_URL: optionalUrl,
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
  });

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
