import { Injectable, Logger } from '@nestjs/common';
import {
  can,
  getPermissionScope,
  USAGE_DEFAULT_PURPOSE,
  USAGE_EXPECTED_END_HOURS_MAX,
  USAGE_EXPECTED_END_MINUTES_MIN,
  type CheckInMachineInput,
  type CheckOutMachineInput,
  type MachineCondition,
  type UsageSessionConflict,
  type UsageSessionDto,
  type UsageSessionEvent,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { assertDepartmentAccess } from '../authorization/department-scope';
import { PermissionDeniedException } from '../authorization/permission-denied.exception';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MachineNotFoundException } from '../machines/machines.errors';
import { UsageClockService } from './usage-clock.service';
import {
  ForceNotApplicableException,
  MachineBusyException,
  MachineInUseException,
  MachineNotAvailableException,
  NoOpenSessionException,
  SessionNotHeldException,
  UpcomingBookingConflictException,
  UsageExpectedEndInvalidException,
  UsageSettingsInvalidException,
} from './usage.errors';
import { UsageEventsService } from './usage-events.service';

type LockedMachine = {
  allowBookingWhenNeedsService: boolean;
  condition: MachineCondition;
  deletedAt: Date | null;
  departmentId: string;
  id: string;
};

type OpenSession = {
  endedAt: Date | null;
  expectedEndAt: Date | null;
  id: string;
  machineId: string;
  purpose: string;
  startedAt: Date;
  user: { fullName: string; id: string };
  userId: string;
};

type TransactionOutcome = { event: UsageSessionEvent; result: UsageSessionDto };

const LOCK_TIMEOUT = '3s';
const TRANSACTION_TIMEOUT_MS = 10_000;
const GUARD_SETTING_KEY = 'checkout.adhoc_guard_minutes';

const errorIncludes = (error: unknown, value: string): boolean => {
  try {
    return JSON.stringify(error).includes(value);
  } catch {
    return false;
  }
};

const isLockTimeout = (error: unknown): boolean =>
  errorIncludes(error, '55P03') || errorIncludes(error, 'lock timeout');

const isOpenSessionUniqueViolation = (error: unknown): boolean =>
  (errorIncludes(error, '23505') || errorIncludes(error, 'P2002')) &&
  (errorIncludes(error, 'usage_sessions_one_open_per_machine') ||
    errorIncludes(error, 'machine_id'));

const toConflict = (session: OpenSession, actorId: string): UsageSessionConflict => {
  const heldByCurrentUser = session.userId === actorId;
  return {
    expectedEndAt: session.expectedEndAt?.toISOString() ?? null,
    heldByCurrentUser,
    ...(heldByCurrentUser ? {} : { holder: session.user }),
    id: session.id,
    startedAt: session.startedAt.toISOString(),
  };
};

const toOpenDto = (session: {
  expectedEndAt: Date | null;
  id: string;
  machineId: string;
  purpose: string;
  startedAt: Date;
}): UsageSessionDto => ({
  expectedEndAt: session.expectedEndAt?.toISOString() ?? null,
  id: session.id,
  machineId: session.machineId,
  purpose: session.purpose,
  startedAt: session.startedAt.toISOString(),
});

const toClosedDto = (
  session: {
    endedAt: Date | null;
    expectedEndAt: Date | null;
    id: string;
    machineId: string;
    purpose: string;
    startedAt: Date;
  },
  endedAt: Date,
): UsageSessionDto => ({
  ...toOpenDto(session),
  durationSeconds: Math.max(
    0,
    Math.floor((endedAt.getTime() - session.startedAt.getTime()) / 1000),
  ),
  endedAt: endedAt.toISOString(),
});

@Injectable()
export class UsageService {
  private readonly logger = new Logger(UsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: UsageEventsService,
    private readonly clock: UsageClockService,
  ) {}

  async checkOut(
    actor: AuthenticatedUser,
    machineId: string,
    input: CheckOutMachineInput,
    requestId: string,
  ): Promise<UsageSessionDto> {
    if (!can(actor.role, 'usage:check-in-out')) throw new PermissionDeniedException();

    try {
      const outcome = await this.prisma.$transaction(
        async (transaction) => {
          await this.setLockTimeout(transaction);
          const machine = await this.lockMachine(transaction, machineId);
          const now = await this.clock.now(transaction);
          this.assertCheckOutCondition(machine);

          const openSession = await this.openSession(transaction, machineId);
          if (openSession !== null)
            throw new MachineInUseException(toConflict(openSession, actor.id));

          const expectedEndAt = this.expectedEnd(input.expectedEndAt, now);
          const guardMinutes = await this.guardMinutes(transaction);
          await this.assertBookingGuard(
            transaction,
            actor.id,
            machineId,
            now,
            expectedEndAt,
            guardMinutes,
          );

          const session = await transaction.usageSession.create({
            data: {
              expectedEndAt,
              machineId,
              purpose: input.purpose ?? USAGE_DEFAULT_PURPOSE,
              startedAt: now,
              userId: actor.id,
            },
          });
          await this.audit.record(transaction, {
            action: 'usage.checked_out',
            actorUserId: actor.id,
            after: {
              expectedEndAt: expectedEndAt?.toISOString() ?? null,
              machineId,
              startedAt: now.toISOString(),
              userId: actor.id,
            },
            entityId: session.id,
            entityType: 'usage_session',
            requestId,
          });
          return {
            event: {
              actorUserId: actor.id,
              forced: false,
              machineId,
              requestId,
              sessionId: session.id,
              timestamp: now.toISOString(),
              type: 'CHECKED_OUT',
              userId: actor.id,
            },
            result: toOpenDto(session),
          } satisfies TransactionOutcome;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      await this.events.emit(outcome.event);
      return outcome.result;
    } catch (error: unknown) {
      if (error instanceof MachineInUseException) throw error;
      if (isLockTimeout(error)) {
        const session = await this.currentOpenSession(machineId);
        if (session !== null) throw new MachineInUseException(toConflict(session, actor.id));
        throw new MachineBusyException();
      }
      if (isOpenSessionUniqueViolation(error)) {
        const session = await this.currentOpenSession(machineId);
        if (session !== null) throw new MachineInUseException(toConflict(session, actor.id));
      }
      throw error;
    }
  }

  async checkIn(
    actor: AuthenticatedUser,
    machineId: string,
    input: CheckInMachineInput,
    requestId: string,
  ): Promise<UsageSessionDto> {
    if (!can(actor.role, 'usage:check-in-out')) throw new PermissionDeniedException();

    try {
      const outcome = await this.prisma.$transaction(
        async (transaction) => {
          await this.setLockTimeout(transaction);
          const machine = await this.lockMachine(transaction, machineId);
          const now = await this.clock.now(transaction);
          const session = await this.openSession(transaction, machineId);
          if (session === null) throw new NoOpenSessionException();

          const isHolder = session.userId === actor.id;
          if (isHolder && input.force) throw new ForceNotApplicableException();
          if (!isHolder && !input.force) throw new SessionNotHeldException();
          if (!isHolder) this.assertForceAccess(actor, machine.departmentId);

          const forced = !isHolder;
          const endNote = forced ? input.reason : input.note;
          const updated = await transaction.usageSession.update({
            data: { endedAt: now, ...(endNote === undefined ? {} : { endNote }) },
            where: { id: session.id },
          });
          await this.audit.record(transaction, {
            action: forced ? 'usage.force_ended' : 'usage.checked_in',
            actorUserId: actor.id,
            after: {
              endedAt: now.toISOString(),
              forced,
              machineId,
              sessionUserId: session.userId,
              ...(endNote === undefined ? {} : { endNote }),
            },
            before: { endedAt: null, machineId, sessionUserId: session.userId },
            context: {
              forced,
              machineId,
              ...(forced
                ? { reason: input.reason! }
                : input.note === undefined
                  ? {}
                  : { note: input.note }),
            },
            entityId: session.id,
            entityType: 'usage_session',
            requestId,
          });
          return {
            event: {
              actorUserId: actor.id,
              forced,
              machineId,
              requestId,
              sessionId: session.id,
              timestamp: now.toISOString(),
              type: forced ? 'FORCE_ENDED' : 'CHECKED_IN',
              userId: session.userId,
            },
            result: toClosedDto(updated, now),
          } satisfies TransactionOutcome;
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      await this.events.emit(outcome.event);
      return outcome.result;
    } catch (error: unknown) {
      if (isLockTimeout(error)) throw new MachineBusyException();
      throw error;
    }
  }

  private currentOpenSession(machineId: string): Promise<OpenSession | null> {
    return this.prisma.usageSession.findFirst({
      include: { user: { select: { fullName: true, id: true } } },
      where: { endedAt: null, machineId },
    });
  }

  private async setLockTimeout(transaction: Prisma.TransactionClient): Promise<void> {
    await transaction.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
  }

  private async lockMachine(
    transaction: Prisma.TransactionClient,
    machineId: string,
  ): Promise<LockedMachine> {
    const rows = await transaction.$queryRaw<LockedMachine[]>`
      SELECT
        id,
        condition::text AS "condition",
        deleted_at AS "deletedAt",
        allow_booking_when_needs_service AS "allowBookingWhenNeedsService",
        department_id AS "departmentId"
      FROM machines
      WHERE id = ${machineId}::uuid
      FOR UPDATE
    `;
    const machine = rows[0];
    if (machine === undefined || machine.deletedAt !== null) throw new MachineNotFoundException();
    return machine;
  }

  private assertCheckOutCondition(machine: LockedMachine): void {
    if (machine.condition === 'OPERATIONAL') return;
    if (machine.condition === 'NEEDS_SERVICE' && machine.allowBookingWhenNeedsService) return;
    throw new MachineNotAvailableException();
  }

  private openSession(
    transaction: Prisma.TransactionClient,
    machineId: string,
  ): Promise<OpenSession | null> {
    return transaction.usageSession.findFirst({
      include: { user: { select: { fullName: true, id: true } } },
      where: { endedAt: null, machineId },
    }) as Promise<OpenSession | null>;
  }

  private expectedEnd(input: string | undefined, now: Date): Date | null {
    if (input === undefined) return null;
    const expected = new Date(input);
    const difference = expected.getTime() - now.getTime();
    const minimum = USAGE_EXPECTED_END_MINUTES_MIN * 60_000;
    const maximum = USAGE_EXPECTED_END_HOURS_MAX * 60 * 60_000;
    if (difference < minimum || difference > maximum) {
      throw new UsageExpectedEndInvalidException();
    }
    return expected;
  }

  private async guardMinutes(transaction: Prisma.TransactionClient): Promise<number> {
    const setting = await transaction.appSetting.findUnique({
      select: { value: true },
      where: { key: GUARD_SETTING_KEY },
    });
    const value = setting?.value;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 240) {
      this.logger.error({ key: GUARD_SETTING_KEY }, 'Application setting is invalid');
      throw new UsageSettingsInvalidException();
    }
    return value;
  }

  private async assertBookingGuard(
    transaction: Prisma.TransactionClient,
    actorId: string,
    machineId: string,
    now: Date,
    expectedEndAt: Date | null,
    guardMinutes: number,
  ): Promise<void> {
    const guardBoundary = new Date(now.getTime() + guardMinutes * 60_000);
    const boundary =
      expectedEndAt !== null && expectedEndAt > guardBoundary ? expectedEndAt : guardBoundary;
    const booking = await transaction.booking.findFirst({
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: { startsAt: true },
      where: {
        blockedUntil: { gt: now },
        machineId,
        requestedByUserId: { not: actorId },
        startsAt: { lte: boundary },
        status: 'CONFIRMED',
      },
    });
    if (booking !== null) {
      throw new UpcomingBookingConflictException(booking.startsAt, booking.startsAt <= now);
    }
  }

  private assertForceAccess(actor: AuthenticatedUser, machineDepartmentId: string): void {
    const scope = getPermissionScope(actor.role, 'usage:force-end');
    if (scope === 'GLOBAL') return;
    if (scope === 'OWN_DEPARTMENT') {
      assertDepartmentAccess(actor, machineDepartmentId);
      return;
    }
    throw new PermissionDeniedException();
  }
}
