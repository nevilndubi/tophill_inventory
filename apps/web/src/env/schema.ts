import { z } from 'zod';

const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const requiredUrl = z.preprocess(
  (value) => value ?? '',
  z.string().min(1, 'is required').pipe(z.url('must be a valid URL')),
);

const optionalUrl = z.preprocess(blankToUndefined, z.url('must be a valid URL').optional());

const requiredPublishableKey = z.preprocess(
  (value) => value ?? '',
  z
    .string()
    .min(1, 'is required')
    .startsWith('sb_publishable_', 'must be a modern sb_publishable_ key'),
);

export const webServerEnvironmentSchema = z.object({
  API_BASE_URL: requiredUrl,
  SENTRY_DSN: optionalUrl,
});

export const webPublicEnvironmentSchema = z.object({
  NEXT_PUBLIC_API_URL: requiredUrl,
  NEXT_PUBLIC_SUPABASE_URL: requiredUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: requiredPublishableKey,
});

const webEnvironmentSchema = webServerEnvironmentSchema.extend(webPublicEnvironmentSchema.shape);

const formatEnvironmentError = (error: z.ZodError): string => {
  const details = error.issues
    .map((issue) => `- ${issue.path.join('.') || 'environment'}: ${issue.message}`)
    .join('\n');

  return `[web] Invalid environment variables:\n${details}`;
};

const parseEnvironment = <Schema extends z.ZodType>(
  schema: Schema,
  values: unknown,
): z.output<Schema> => {
  const result = schema.safeParse(values);

  if (!result.success) {
    throw new Error(formatEnvironmentError(result.error));
  }

  return result.data;
};

export const validateWebEnvironment = (values: unknown): void => {
  parseEnvironment(webEnvironmentSchema, values);
};

export const parseWebServerEnvironment = (values: unknown) =>
  parseEnvironment(webServerEnvironmentSchema, values);

export const parseWebPublicEnvironment = (values: unknown) =>
  parseEnvironment(webPublicEnvironmentSchema, values);
