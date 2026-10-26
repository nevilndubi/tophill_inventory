import { describe, expect, it, vi } from 'vitest';
import { createApiClient, isConfiguredApiUrl } from './client';

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

describe('API client', () => {
  it('uses the unversioned root origin for health and the versioned prefix for API routes', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        jsonResponse({ data: { status: 'ok', timestamp: '2026-10-20T00:00:00Z' } }),
      );
    const client = createApiClient({ origin: 'http://api.example.test/', fetcher });

    await client.health();
    await client.request('/machines');

    expect(fetcher.mock.calls[0]?.[0]).toBe('http://api.example.test/health');
    expect(fetcher.mock.calls[1]?.[0]).toBe('http://api.example.test/api/v1/machines');
  });

  it('preserves pagination metadata for typed list clients', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ data: [{ id: 'machine-1' }], meta: { page: 2, pageSize: 25, total: 31 } }),
      );
    const client = createApiClient({ origin: 'http://api.example.test', fetcher });

    await expect(client.requestWithMeta('/machines?page=2')).resolves.toEqual({
      data: [{ id: 'machine-1' }],
      meta: { page: 2, pageSize: 25, total: 31 },
    });
  });

  it('adds an authorization header when the future token provider returns a token', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ data: { status: 'ok', timestamp: '2026-10-20T00:00:00Z' } }),
      );
    const client = createApiClient({
      origin: 'http://api.example.test',
      fetcher,
      getAccessToken: async () => 'test-token',
    });

    await client.request('/me');

    const request = fetcher.mock.calls[0];
    const headers = new Headers(request?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-token');
  });

  it('never considers another origin eligible for the API authorization header', () => {
    expect(
      isConfiguredApiUrl('https://api.example.test', 'https://api.example.test/api/v1/me'),
    ).toBe(true);
    expect(
      isConfiguredApiUrl('https://api.example.test', 'https://other.example.test/collect'),
    ).toBe(false);
    expect(isConfiguredApiUrl('https://api.example.test', 'javascript:alert(1)')).toBe(false);
  });

  it('refreshes once after a 401 and retries with the refreshed access token', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Unauthorized', details: {} } },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'local-user' } }));
    const refreshAccessToken = vi.fn().mockResolvedValue('refreshed-opaque-value');
    const client = createApiClient({
      origin: 'https://api.example.test',
      fetcher,
      getAccessToken: async () => 'initial-opaque-value',
      refreshAccessToken,
    });

    await expect(client.request<{ id: string }>('/me')).resolves.toEqual({ id: 'local-user' });

    expect(refreshAccessToken).toHaveBeenCalledOnce();
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer initial-opaque-value',
    );
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer refreshed-opaque-value',
    );
  });

  it('notifies the session boundary when a refreshed request remains unauthorized', async () => {
    const unauthorized = jsonResponse(
      { error: { code: 'AUTHENTICATION_REQUIRED', message: 'Unauthorized', details: {} } },
      { status: 401 },
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(unauthorized);
    const onUnauthorized = vi.fn();
    const client = createApiClient({
      origin: 'https://api.example.test',
      fetcher,
      getAccessToken: async () => 'opaque-value',
      refreshAccessToken: async () => null,
      onUnauthorized,
    });

    await expect(client.request('/me')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('keeps 403 failures distinct and does not invoke session invalidation', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { error: { code: 'PERMISSION_DENIED', message: 'Permission denied', details: {} } },
          { status: 403 },
        ),
      );
    const onForbidden = vi.fn();
    const onUnauthorized = vi.fn();
    const client = createApiClient({
      origin: 'https://api.example.test',
      fetcher,
      getAccessToken: async () => 'opaque-value',
      onForbidden,
      onUnauthorized,
    });

    await expect(client.request('/admin')).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      status: 403,
    });
    expect(onForbidden).toHaveBeenCalledOnce();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('reports auth outages without invalidating the session', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { error: { code: 'AUTH_UNAVAILABLE', message: 'Unavailable', details: {} } },
          { status: 503 },
        ),
      );
    const onUnavailable = vi.fn();
    const onUnauthorized = vi.fn();
    const client = createApiClient({
      origin: 'https://api.example.test',
      fetcher,
      getAccessToken: async () => 'opaque-value',
      onUnavailable,
      onUnauthorized,
    });

    await expect(client.request('/me')).rejects.toMatchObject({
      code: 'AUTH_UNAVAILABLE',
      status: 503,
    });
    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('normalizes standard API errors', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Validation failed',
            details: { field: 'name' },
            requestId: 'request-123',
          },
        },
        { status: 400 },
      ),
    );
    const client = createApiClient({ origin: 'http://api.example.test', fetcher });

    const request = client.request('/fixture');

    await expect(request).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'Validation failed',
      details: { field: 'name' },
      requestId: 'request-123',
      status: 400,
    });
  });

  it('normalizes network failures', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('connection refused'));
    const client = createApiClient({ origin: 'http://api.example.test', fetcher });

    await expect(client.health()).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      message: 'The API could not be reached.',
      status: 0,
    });
  });
});
