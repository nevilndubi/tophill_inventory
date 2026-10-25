import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthenticationUnavailableException } from './auth.errors';
import { SUPABASE_ADMIN_CLIENT } from './supabase-admin.constants';

export type VerifiedSupabaseUser = {
  email: string;
  id: string;
};

export class SupabaseAdminRequestError extends Error {
  constructor() {
    super('Supabase Admin operation failed');
    this.name = 'SupabaseAdminRequestError';
  }
}

export class SupabaseIdentityExistsError extends Error {
  constructor() {
    super('Supabase identity already exists');
    this.name = 'SupabaseIdentityExistsError';
  }
}

export type CreatedSupabaseIdentity = { id: string };

@Injectable()
export class SupabaseAdminService {
  constructor(
    @Inject(SUPABASE_ADMIN_CLIENT)
    private readonly client: SupabaseClient,
  ) {}

  async getVerifiedUser(userId: string): Promise<VerifiedSupabaseUser | null> {
    try {
      const { data, error } = await this.client.auth.admin.getUserById(userId);

      if (error !== null) {
        if (error.status === 404) {
          return null;
        }

        throw new AuthenticationUnavailableException();
      }

      const { user } = data;

      if (
        user.id !== userId ||
        user.is_anonymous === true ||
        typeof user.email !== 'string' ||
        user.email_confirmed_at == null
      ) {
        return null;
      }

      return { email: user.email.toLowerCase(), id: user.id };
    } catch (error: unknown) {
      if (error instanceof AuthenticationUnavailableException) {
        throw error;
      }

      throw new AuthenticationUnavailableException();
    }
  }

  async findUserIdByEmail(email: string): Promise<string | null> {
    const normalized = email.toLowerCase();
    let page = 1;

    while (true) {
      try {
        const { data, error } = await this.client.auth.admin.listUsers({ page, perPage: 200 });
        if (error !== null) throw new SupabaseAdminRequestError();

        const match = data.users.find((user) => user.email?.toLowerCase() === normalized);
        if (match) return match.id;
        if (data.users.length < 200) return null;
        page += 1;
      } catch (error: unknown) {
        if (error instanceof SupabaseAdminRequestError) throw error;
        throw new SupabaseAdminRequestError();
      }
    }
  }

  async inviteUserByEmail(
    email: string,
    fullName: string,
    redirectTo: string,
  ): Promise<CreatedSupabaseIdentity> {
    try {
      const { data, error } = await this.client.auth.admin.inviteUserByEmail(email, {
        data: { full_name: fullName },
        redirectTo,
      });
      if (error !== null) {
        if (['email_exists', 'user_already_exists'].includes(error.code ?? '')) {
          throw new SupabaseIdentityExistsError();
        }
        throw new SupabaseAdminRequestError();
      }
      if (!data.user?.id) throw new SupabaseAdminRequestError();
      return { id: data.user.id };
    } catch (error: unknown) {
      if (
        error instanceof SupabaseAdminRequestError ||
        error instanceof SupabaseIdentityExistsError
      )
        throw error;
      throw new SupabaseAdminRequestError();
    }
  }

  async deleteUser(userId: string): Promise<boolean> {
    try {
      const { error } = await this.client.auth.admin.deleteUser(userId);
      return error === null;
    } catch {
      return false;
    }
  }

  async listIdentityIds(): Promise<readonly string[]> {
    const ids: string[] = [];
    let page = 1;

    while (true) {
      try {
        const { data, error } = await this.client.auth.admin.listUsers({ page, perPage: 200 });
        if (error !== null) throw new SupabaseAdminRequestError();
        ids.push(...data.users.map((user) => user.id));
        if (data.users.length < 200) return ids;
        page += 1;
      } catch (error: unknown) {
        if (error instanceof SupabaseAdminRequestError) throw error;
        throw new SupabaseAdminRequestError();
      }
    }
  }
}
