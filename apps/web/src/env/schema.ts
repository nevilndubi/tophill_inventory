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

export const webServerEnvironmentSchema = z.object({
  API_BASE_URL: requiredUrl,
  SUPABASE_URL: optionalUrl,
  SUPABASE_ANON_KEY: optionalSecret,
  SENTRY_DSN: optionalUrl,
});

export const webPublicEnvironmentSchema = z.object({
  NEXT_PUBLIC_API_URL: requiredUrl,
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
