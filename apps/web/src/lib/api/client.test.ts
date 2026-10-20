import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from './client';

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

    await client.health();

    const request = fetcher.mock.calls[0];
    const headers = new Headers(request?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-token');
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
