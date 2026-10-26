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

export type ApiResult<T> = {
  data: T;
  meta: Record<string, unknown>;
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

export type ApiClientOptions = {
  origin: string;
  getAccessToken?: () => Promise<string | null>;
  refreshAccessToken?: () => Promise<string | null>;
  onForbidden?: (error: ApiClientError) => void | Promise<void>;
  onUnauthorized?: (error: ApiClientError) => void | Promise<void>;
  onUnavailable?: (error: ApiClientError) => void | Promise<void>;
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

export const isConfiguredApiUrl = (origin: string, target: string): boolean => {
  try {
    return new URL(target).origin === new URL(origin).origin;
  } catch {
    return false;
  }
};

export function createApiClient({
  origin,
  getAccessToken = async () => null,
  refreshAccessToken,
  onForbidden,
  onUnauthorized,
  onUnavailable,
  fetcher = fetch,
}: ApiClientOptions) {
  const apiOrigin = normalizeOrigin(origin);

  const executeEnvelope = async <T>(
    url: string,
    options: RequestOptions = {},
    authenticated = true,
  ): Promise<ApiResult<T>> => {
    const headers = new Headers(options.headers);

    headers.set('accept', 'application/json');
    if (options.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }

    const send = async (token: string | null): Promise<Response> => {
      const requestHeaders = new Headers(headers);
      if (authenticated && token && isConfiguredApiUrl(apiOrigin, url)) {
        requestHeaders.set('authorization', `Bearer ${token}`);
      }
      return fetcher(url, { ...options, headers: requestHeaders });
    };

    const handleNetworkFailure = async (cause: unknown): Promise<never> => {
      const networkError = new ApiClientError(
        {
          code: 'NETWORK_ERROR',
          message: 'The API could not be reached.',
          details: cause instanceof Error ? { cause: cause.message } : {},
        },
        0,
      );
      if (authenticated) {
        await onUnavailable?.(networkError);
      }
      throw networkError;
    };

    let response: Response;
    try {
      response = await send(authenticated ? await getAccessToken() : null);
    } catch (cause) {
      return handleNetworkFailure(cause);
    }

    let payload = await readJson(response);
    if (authenticated && response.status === 401 && refreshAccessToken) {
      let refreshedToken: string | null;
      try {
        refreshedToken = await refreshAccessToken();
      } catch (cause) {
        const refreshError =
          cause instanceof ApiClientError
            ? cause
            : new ApiClientError(
                {
                  code: 'AUTH_UNAVAILABLE',
                  message: 'Authentication is temporarily unavailable.',
                  details: {},
                },
                503,
              );
        await onUnavailable?.(refreshError);
        throw refreshError;
      }
      if (refreshedToken) {
        try {
          response = await send(refreshedToken);
        } catch (cause) {
          return handleNetworkFailure(cause);
        }
        payload = await readJson(response);
      }
    }

    if (!response.ok) {
      const apiError = normalizeApiError(payload, response.status);
      if (authenticated && response.status === 401) {
        await onUnauthorized?.(apiError);
      } else if (authenticated && response.status === 403) {
        await onForbidden?.(apiError);
      } else if (authenticated && response.status === 503 && apiError.code === 'AUTH_UNAVAILABLE') {
        await onUnavailable?.(apiError);
      }
      throw apiError;
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

    const envelope = payload as ApiSuccessEnvelope<T>;
    return { data: envelope.data, meta: envelope.meta ?? {} };
  };

  const execute = async <T>(
    url: string,
    options: RequestOptions = {},
    authenticated = true,
  ): Promise<T> => (await executeEnvelope<T>(url, options, authenticated)).data;

  return {
    rootUrl: (path: string) => `${apiOrigin}${normalizePath(path)}`,
    versionedUrl: (path: string) => `${apiOrigin}/api/v1${normalizePath(path)}`,
    requestRoot: <T>(path: string, options?: RequestOptions) =>
      execute<T>(`${apiOrigin}${normalizePath(path)}`, options, false),
    request: <T>(path: string, options?: RequestOptions) =>
      execute<T>(`${apiOrigin}/api/v1${normalizePath(path)}`, options),
    requestWithMeta: <T>(path: string, options?: RequestOptions) =>
      executeEnvelope<T>(`${apiOrigin}/api/v1${normalizePath(path)}`, options),
    health: () => execute<HealthResponse>(`${apiOrigin}/health`, {}, false),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
