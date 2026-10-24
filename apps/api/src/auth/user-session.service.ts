import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma, Role } from '../generated/prisma/client';
import type { ApiEnvironment } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { UserInactiveException, UserNotProvisionedException } from './auth.errors';
import type { AuthenticatedUser } from './auth.types';
import { SupabaseAdminService } from './supabase-admin.service';

const LOGIN_WRITE_INTERVAL_MS = 5 * 60 * 1_000;
const SUPER_ADMIN_BOOTSTRAP_LOCK_ID = 2_202;

const userSelection = {
  department: { select: { code: true, id: true, name: true } },
  email: true,
  fullName: true,
  id: true,
  isActive: true,
  isSeedData: true,
  lastLoginAt: true,
  role: true,
  supabaseUserId: true,
} satisfies Prisma.UserSelect;

type LocalUser = Prisma.UserGetPayload<{ select: typeof userSelection }>;

@Injectable()
export class UserSessionService {
  private readonly bootstrapEmail: string | undefined;
  private readonly logger = new Logger(UserSessionService.name);

  constructor(
    config: ConfigService<ApiEnvironment, true>,
    private readonly prisma: PrismaService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {
    this.bootstrapEmail = config.get('BOOTSTRAP_SUPER_ADMIN_EMAIL', { infer: true });
  }

  async resolve(subject: string, now = new Date()): Promise<AuthenticatedUser> {
    const existing = await this.prisma.user.findUnique({
      select: userSelection,
      where: { supabaseUserId: subject },
    });

    if (existing !== null) {
      this.assertUsable(existing);
      await this.touchLastLogin(existing.id, now);
      return this.toAuthenticatedUser(existing);
    }

    const bootstrapped = await this.tryBootstrap(subject, now);

    if (bootstrapped === null) {
      throw new UserNotProvisionedException();
    }

    this.assertUsable(bootstrapped);
    return this.toAuthenticatedUser(bootstrapped);
  }

  private assertUsable(user: LocalUser): void {
    if (user.isSeedData || user.supabaseUserId === null) {
      throw new UserNotProvisionedException();
    }

    if (!user.isActive) {
      throw new UserInactiveException();
    }
  }

  private async touchLastLogin(userId: string, now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - LOGIN_WRITE_INTERVAL_MS);

    await this.prisma.user.updateMany({
      data: { lastLoginAt: now },
      where: {
        id: userId,
        OR: [{ lastLoginAt: null }, { lastLoginAt: { lt: cutoff } }],
      },
    });
  }

  private async tryBootstrap(subject: string, now: Date): Promise<LocalUser | null> {
    if (this.bootstrapEmail === undefined) {
      return null;
    }

    const verifiedUser = await this.supabaseAdmin.getVerifiedUser(subject);

    if (
      verifiedUser === null ||
      verifiedUser.email !== this.bootstrapEmail ||
      verifiedUser.email.endsWith('.invalid')
    ) {
      return null;
    }

    const result = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${SUPER_ADMIN_BOOTSTRAP_LOCK_ID})::text AS lock_result`;

      const identityAfterLock = await transaction.user.findUnique({
        select: userSelection,
        where: { supabaseUserId: subject },
      });

      if (identityAfterLock !== null) {
        return { created: false, user: identityAfterLock };
      }

      const activeSuperAdmin = await transaction.user.findFirst({
        select: { id: true },
        where: { isActive: true, isSeedData: false, role: 'SUPER_ADMIN' },
      });
      const seedAddress = await transaction.user.findFirst({
        select: { id: true },
        where: { email: verifiedUser.email, isSeedData: true },
      });

      if (activeSuperAdmin !== null || seedAddress !== null) {
        return { created: false, user: null };
      }

      const user = await transaction.user.create({
        data: {
          email: verifiedUser.email,
          fullName: 'Initial Super Administrator',
          isActive: true,
          isSeedData: false,
          lastLoginAt: now,
          role: 'SUPER_ADMIN' satisfies Role,
          supabaseUserId: subject,
        },
        select: userSelection,
      });

      return { created: true, user };
    });

    if (result.created && result.user !== null) {
      this.logger.log({ userId: result.user.id }, 'Bootstrap completed');
    }

    return result.user;
  }

  private toAuthenticatedUser(user: LocalUser): AuthenticatedUser {
    return {
      department: user.department,
      email: user.email,
      fullName: user.fullName,
      id: user.id,
      isActive: user.isActive,
      role: user.role,
    };
  }
}
