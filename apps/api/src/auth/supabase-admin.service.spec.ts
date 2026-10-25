import { jest } from '@jest/globals';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthenticationUnavailableException } from './auth.errors';
import {
  SupabaseAdminRequestError,
  SupabaseAdminService,
  SupabaseIdentityExistsError,
} from './supabase-admin.service';

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

  it('finds an identity by normalized email without returning the email', async () => {
    const listUsers = jest.fn(async () => ({
      data: { users: [{ email: 'TEST@EXAMPLE.TEST', id: userId }] },
      error: null,
    }));
    const service = new SupabaseAdminService({
      auth: { admin: { listUsers } },
    } as unknown as SupabaseClient);

    await expect(service.findUserIdByEmail('test@example.test')).resolves.toBe(userId);
    expect(listUsers).toHaveBeenCalledWith({ page: 1, perPage: 200 });
  });

  it('creates an invite with the exact redirect and deletes only by identity ID', async () => {
    const inviteUserByEmail = jest.fn(async () => ({
      data: { user: { id: userId } },
      error: null,
    }));
    const deleteUser = jest.fn(async () => ({ data: {}, error: null }));
    const service = new SupabaseAdminService({
      auth: { admin: { deleteUser, inviteUserByEmail } },
    } as unknown as SupabaseClient);

    await expect(
      service.inviteUserByEmail(
        'test@example.test',
        'Test User',
        'http://127.0.0.1:3000/auth/confirm',
      ),
    ).resolves.toEqual({ id: userId });
    await expect(service.deleteUser(userId)).resolves.toBe(true);
    expect(inviteUserByEmail).toHaveBeenCalledWith('test@example.test', {
      data: { full_name: 'Test User' },
      redirectTo: 'http://127.0.0.1:3000/auth/confirm',
    });
    expect(deleteUser).toHaveBeenCalledWith(userId);
  });

  it.each(['email_exists', 'user_already_exists'])(
    'maps the %s race response to an existing identity',
    async (code) => {
      const service = new SupabaseAdminService({
        auth: {
          admin: {
            inviteUserByEmail: jest.fn(async () => ({
              data: { user: null },
              error: { code, status: 422 },
            })),
          },
        },
      } as unknown as SupabaseClient);
      await expect(
        service.inviteUserByEmail('test@example.test', 'Test', 'http://127.0.0.1/auth/confirm'),
      ).rejects.toBeInstanceOf(SupabaseIdentityExistsError);
    },
  );

  it('returns only IDs from reconciliation and maps list failures safely', async () => {
    const service = new SupabaseAdminService({
      auth: {
        admin: {
          listUsers: jest.fn(async () => ({
            data: { users: [{ email: 'redacted-for-test', id: userId }] },
            error: null,
          })),
        },
      },
    } as unknown as SupabaseClient);
    await expect(service.listIdentityIds()).resolves.toEqual([userId]);

    const failing = new SupabaseAdminService({
      auth: {
        admin: {
          listUsers: jest.fn(async () => ({ data: { users: [] }, error: { status: 503 } })),
        },
      },
    } as unknown as SupabaseClient);
    await expect(failing.listIdentityIds()).rejects.toBeInstanceOf(SupabaseAdminRequestError);
  });
});
