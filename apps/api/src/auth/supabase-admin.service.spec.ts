import { jest } from '@jest/globals';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthenticationUnavailableException } from './auth.errors';
import { SupabaseAdminService } from './supabase-admin.service';

const userId = '11111111-1111-4111-8111-111111111111';

const clientWithResult = (result: unknown): SupabaseClient =>
  ({
    auth: {
      admin: {
        getUserById: jest.fn(async () => result),
      },
    },
  }) as unknown as SupabaseClient;

describe('SupabaseAdminService', () => {
  it('returns only normalized identity data for a confirmed non-anonymous user', async () => {
    const service = new SupabaseAdminService(
      clientWithResult({
        data: {
          user: {
            email: 'First.Admin@Hospital.Test',
            email_confirmed_at: '2026-10-24T00:00:00.000Z',
            id: userId,
            is_anonymous: false,
          },
        },
        error: null,
      }),
    );

    await expect(service.getVerifiedUser(userId)).resolves.toEqual({
      email: 'first.admin@hospital.test',
      id: userId,
    });
  });

  it.each([
    ['unconfirmed', { email_confirmed_at: null, is_anonymous: false, id: userId }],
    [
      'anonymous',
      {
        email: 'anonymous@hospital.test',
        email_confirmed_at: '2026-10-24T00:00:00.000Z',
        id: userId,
        is_anonymous: true,
      },
    ],
    [
      'mismatched identity',
      {
        email: 'other@hospital.test',
        email_confirmed_at: '2026-10-24T00:00:00.000Z',
        id: '22222222-2222-4222-8222-222222222222',
        is_anonymous: false,
      },
    ],
  ])('refuses a %s Admin API user', async (_name, user) => {
    const service = new SupabaseAdminService(clientWithResult({ data: { user }, error: null }));

    await expect(service.getVerifiedUser(userId)).resolves.toBeNull();
  });

  it('treats a missing Auth user as not verified', async () => {
    const service = new SupabaseAdminService(
      clientWithResult({ data: { user: null }, error: { status: 404 } }),
    );

    await expect(service.getVerifiedUser(userId)).resolves.toBeNull();
  });

  it('maps Admin API failures to authentication unavailable', async () => {
    const service = new SupabaseAdminService(
      clientWithResult({ data: { user: null }, error: { status: 503 } }),
    );

    await expect(service.getVerifiedUser(userId)).rejects.toBeInstanceOf(
      AuthenticationUnavailableException,
    );
  });
});
