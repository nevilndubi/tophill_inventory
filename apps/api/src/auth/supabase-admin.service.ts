import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AuthenticationUnavailableException } from './auth.errors';
import { SUPABASE_ADMIN_CLIENT } from './supabase-admin.constants';

export type VerifiedSupabaseUser = {
  email: string;
  id: string;
};

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
}
