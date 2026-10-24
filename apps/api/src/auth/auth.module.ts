import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { ApiEnvironment } from '../config/env';
import { AuthController } from './auth.controller';
import { JwtVerifierService } from './jwt-verifier.service';
import { SupabaseAdminService } from './supabase-admin.service';
import { SUPABASE_ADMIN_CLIENT } from './supabase-admin.constants';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { UserSessionService } from './user-session.service';

@Module({
  controllers: [AuthController],
  providers: [
    JwtVerifierService,
    {
      provide: SUPABASE_ADMIN_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiEnvironment, true>) =>
        createClient(
          config.get('SUPABASE_URL', { infer: true }),
          config.get('SUPABASE_SECRET_KEY', { infer: true }),
          {
            auth: {
              autoRefreshToken: false,
              detectSessionInUrl: false,
              persistSession: false,
            },
          },
        ),
    },
    SupabaseAdminService,
    UserSessionService,
    SupabaseAuthGuard,
  ],
  exports: [JwtVerifierService, SupabaseAdminService, SupabaseAuthGuard, UserSessionService],
})
export class AuthModule {}
