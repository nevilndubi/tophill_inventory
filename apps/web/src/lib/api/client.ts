export type ApiErrorBody = {
  code: string;
  message: string;
  details: unknown;
  requestId?: string;
};

type ApiErrorEnvelope = {
  error?: Partial<ApiErrorBody>;
};

type ApiSuccessEnvelope<T> = {
  data: T;
  meta?: Record<string, unknown>;
};

export type HealthResponse = {
  status: 'ok';
  timestamp: string;
};

export class ApiClientError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly requestId?: string;
  readonly status: number;

  constructor(error: ApiErrorBody, status: number) {
    super(error.message);
    this.name = 'ApiClientError';
    this.code = error.code;
    this.details = error.details;
    this.requestId = error.requestId;
    this.status = status;
  }
}

type ApiClientOptions = {
  origin: string;
  getAccessToken?: () => Promise<string | null>;
  fetcher?: typeof fetch;
};

type RequestOptions = Omit<RequestInit, 'headers'> & {
  headers?: HeadersInit;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeOrigin = (origin: string): string => origin.replace(/\/+$/, '');

const normalizePath = (path: string): string => (path.startsWith('/') ? path : `/${path}`);

const readJson = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get('content-type');

  if (!contentType?.includes('application/json')) {
    return undefined;
  }

  return response.json();
};

const normalizeApiError = (payload: unknown, status: number): ApiClientError => {
  const envelope = isRecord(payload) ? (payload as ApiErrorEnvelope) : undefined;
  const error = envelope?.error;

  return new ApiClientError(
    {
      code: typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED',
      message:
        typeof error?.message === 'string'
          ? error.message
          : `The API request failed with status ${status}.`,
      details: error?.details ?? {},
      ...(typeof error?.requestId === 'string' ? { requestId: error.requestId } : {}),
    },
    status,
  );
};

export function createApiClient({
  origin,
  getAccessToken = async () => null,
  fetcher = fetch,
}: ApiClientOptions) {
  const apiOrigin = normalizeOrigin(origin);

  const execute = async <T>(url: string, options: RequestOptions = {}): Promise<T> => {
    const headers = new Headers(options.headers);
    const token = await getAccessToken();

    headers.set('accept', 'application/json');
    if (options.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    if (token) {
      headers.set('authorization', `Bearer ${token}`);
    }

    let response: Response;
    try {
      response = await fetcher(url, { ...options, headers });
    } catch (cause) {
      throw new ApiClientError(
        {
          code: 'NETWORK_ERROR',
          message: 'The API could not be reached.',
          details: cause instanceof Error ? { cause: cause.message } : {},
        },
        0,
      );
    }

    const payload = await readJson(response);
    if (!response.ok) {
      throw normalizeApiError(payload, response.status);
    }

    if (!isRecord(payload) || !('data' in payload)) {
      throw new ApiClientError(
        {
          code: 'INVALID_RESPONSE',
          message: 'The API returned an unexpected response.',
          details: {},
        },
        response.status,
      );
    }

    return (payload as ApiSuccessEnvelope<T>).data;
  };

  return {
    rootUrl: (path: string) => `${apiOrigin}${normalizePath(path)}`,
    versionedUrl: (path: string) => `${apiOrigin}/api/v1${normalizePath(path)}`,
    requestRoot: <T>(path: string, options?: RequestOptions) =>
      execute<T>(`${apiOrigin}${normalizePath(path)}`, options),
    request: <T>(path: string, options?: RequestOptions) =>
      execute<T>(`${apiOrigin}/api/v1${normalizePath(path)}`, options),
    health: () => execute<HealthResponse>(`${apiOrigin}/health`),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
