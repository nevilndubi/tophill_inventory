import { Injectable } from '@nestjs/common';
import {
  can,
  candidateBlockedRange,
  idempotencyKeySchema,
  validateBookingWindow,
  type CreateBookingInput,
  type CreatedBooking,
  type BookingPolicyMachine,
  type BookingWindowErrorCode,
  type MachineCondition,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PermissionDeniedException } from '../authorization/permission-denied.exception';
import { AuditService } from '../audit/audit.service';
import type { Booking, BookingStatus, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BookingMachineNotFoundException } from './booking.errors';
import { BookingPolicyService } from './booking-policy.service';
import {
  ActiveBookingLimitReachedException,
  BookingConflictException,
  BookingMachineBusyException,
  BookingMachineInUseException,
  BookingPolicyUnavailableException,
  BookingWindowException,
  BookingWindowInvalidException,
  IdempotencyKeyInvalidException,
  IdempotencyKeyReusedException,
} from './booking-creation.errors';

type LockedMachine = {
  allowBookingWhenNeedsService: boolean;
  assetTag: string;
  bufferMinutes: number | null;
  condition: MachineCondition;
  defaultMaxBookingMinutes: number | null;
  deletedAt: Date | null;
  id: string;
  isBookable: boolean;
  maxBookingMinutes: number | null;
  name: string;
  requiresApproval: boolean;
};

type BookingWithMachine = Booking & { machine: { assetTag: string; id: string; name: string } };
type BookingOutcome = { booking: CreatedBooking; replayed: boolean };
type Transaction = Prisma.TransactionClient;

const ACTIVE_BOOKING_STATUSES: BookingStatus[] = ['PENDING', 'CONFIRMED', 'IN_PROGRESS'];
const LOCK_TIMEOUT = '3s';
const TRANSACTION_TIMEOUT_MS = 10_000;

const errorIncludes = (error: unknown, value: string): boolean => {
  try {
    return JSON.stringify(error).includes(value);
  } catch {
    return false;
  }
};

const isLockTimeout = (error: unknown): boolean =>
  errorIncludes(error, '55P03') ||
  errorIncludes(error, '57014') ||
  errorIncludes(error, 'lock timeout');

const isExclusionViolation = (error: unknown): boolean =>
  errorIncludes(error, '23P01') || errorIncludes(error, 'bookings_no_overlap');

const isIdempotencyUniqueViolation = (error: unknown): boolean =>
  (errorIncludes(error, '23505') || errorIncludes(error, 'P2002')) &&
  (errorIncludes(error, 'bookings_requested_by_user_id_idempotency_key_key') ||
    errorIncludes(error, 'idempotency_key'));

const isBookingCheckViolation = (error: unknown): boolean =>
  (errorIncludes(error, '23514') || errorIncludes(error, 'P2004')) &&
  (errorIncludes(error, 'bookings_ends_after_starts_check') ||
    errorIncludes(error, 'bookings_blocked_until_not_before_ends_check') ||
    errorIncludes(error, 'bookings_purpose_length_check') ||
    errorIncludes(error, 'bookings_idempotency_key_format_check'));

const sameRequest = (booking: Booking, input: CreateBookingInput): boolean =>
  booking.machineId === input.machine_id &&
  booking.startsAt.getTime() === Date.parse(input.starts_at) &&
  booking.endsAt.getTime() === Date.parse(input.ends_at) &&
  booking.purpose === input.purpose;

const requiresApprovalFromAudit = (value: Prisma.JsonValue | null): boolean | undefined => {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return undefined;
  const context = value.context;
  if (context === null || Array.isArray(context) || typeof context !== 'object') return undefined;
  return typeof context.requiresApproval === 'boolean' ? context.requiresApproval : undefined;
};

const toDto = (booking: BookingWithMachine, requiresApproval: boolean): CreatedBooking => ({
  blocked_until: booking.blockedUntil.toISOString(),
  created_at: booking.createdAt.toISOString(),
  effective_buffer_minutes: Math.max(
    0,
    Math.round((booking.blockedUntil.getTime() - booking.endsAt.getTime()) / 60_000),
  ),
  ends_at: booking.endsAt.toISOString(),
  id: booking.id,
  machine: {
    asset_tag: booking.machine.assetTag,
    id: booking.machine.id,
    name: booking.machine.name,
  },
  purpose: booking.purpose,
  requires_approval: requiresApproval,
  starts_at: booking.startsAt.toISOString(),
  status: booking.status,
});

@Injectable()
export class BookingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: BookingPolicyService,
    private readonly audit: AuditService,
  ) {}

  async create(
    actor: AuthenticatedUser,
    input: CreateBookingInput,
    requestId: string,
    rawIdempotencyKey?: string,
  ): Promise<BookingOutcome> {
    if (!can(actor.role, 'booking:create')) throw new PermissionDeniedException();
    const idempotencyKey = this.idempotencyKey(rawIdempotencyKey);
    const preflight = await this.replay(actor.id, idempotencyKey, input);
    if (preflight !== null) return { booking: preflight, replayed: true };

    const candidateStart = new Date(input.starts_at);
    const candidateEnd = new Date(input.ends_at);
    let candidateBlockedUntil = candidateEnd;
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
          const machine = await this.lockMachine(transaction, input.machine_id);
          await this.lockRequester(transaction, actor.id);
          const now = await this.databaseClock(transaction);

          const replay = await this.replay(actor.id, idempotencyKey, input, transaction);
          if (replay !== null) return { booking: replay, replayed: true };

          const settings = await this.policies.readSettings(transaction);
          const policyMachine: BookingPolicyMachine = {
            allowBookingWhenNeedsService: machine.allowBookingWhenNeedsService,
            bufferMinutes: machine.bufferMinutes,
            condition: machine.condition,
            isBookable: machine.isBookable,
            maxBookingMinutes: machine.maxBookingMinutes,
            requiresApproval: machine.requiresApproval,
          };
          const policy = this.policies.resolve(
            policyMachine,
            { defaultMaxBookingMinutes: machine.defaultMaxBookingMinutes },
            settings,
          );
          const validation = validateBookingWindow(policy, candidateStart, candidateEnd, now);
          if (!validation.ok) this.throwWindow(validation.code);
          candidateBlockedUntil = candidateBlockedRange(
            candidateStart,
            candidateEnd,
            validation.bufferMinutes,
          ).end;

          const activeCount = await transaction.booking.count({
            where: {
              OR: [
                { endsAt: { gt: now }, status: { in: ['PENDING', 'CONFIRMED'] } },
                { status: 'IN_PROGRESS' },
              ],
              requestedByUserId: actor.id,
            },
          });
          if (activeCount >= settings.maxActivePerUser) {
            throw new ActiveBookingLimitReachedException(settings.maxActivePerUser, activeCount);
          }

          await this.assertNoUsageConflict(
            transaction,
            machine.id,
            now,
            policy.maxDurationMinutes.value,
            candidateStart,
            candidateBlockedUntil,
          );
          const conflict = await this.findConflict(
            transaction,
            machine.id,
            candidateStart,
            candidateBlockedUntil,
          );
          if (conflict !== null) throw new BookingConflictException(conflict);

          const status: BookingStatus = policy.requiresApproval.value ? 'PENDING' : 'CONFIRMED';
          const created = await transaction.booking.create({
            data: {
              blockedUntil: candidateBlockedUntil,
              endsAt: candidateEnd,
              idempotencyKey,
              machineId: machine.id,
              purpose: input.purpose,
              requestedByUserId: actor.id,
              startsAt: candidateStart,
              status,
            },
            include: { machine: { select: { assetTag: true, id: true, name: true } } },
          });
          await this.audit.record(transaction, {
            action: 'booking.created',
            actorUserId: actor.id,
            after: {
              blockedUntil: candidateBlockedUntil.toISOString(),
              endsAt: candidateEnd.toISOString(),
              machineId: machine.id,
              requestedByUserId: actor.id,
              startsAt: candidateStart.toISOString(),
              status,
            },
            context: {
              effectiveBufferMinutes: validation.bufferMinutes,
              requiresApproval: policy.requiresApproval.value,
            },
            entityId: created.id,
            entityType: 'booking',
            requestId,
          });
          return {
            booking: toDto(created, policy.requiresApproval.value),
            replayed: false,
          };
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
    } catch (error: unknown) {
      if (isLockTimeout(error)) throw new BookingMachineBusyException();
      if (isIdempotencyUniqueViolation(error) && idempotencyKey !== undefined) {
        const replay = await this.replay(actor.id, idempotencyKey, input);
        if (replay !== null) return { booking: replay, replayed: true };
        throw new IdempotencyKeyReusedException();
      }
      if (isExclusionViolation(error)) {
        const conflict = await this.findConflict(
          this.prisma,
          input.machine_id,
          candidateStart,
          candidateBlockedUntil,
        );
        if (conflict !== null) throw new BookingConflictException(conflict);
      }
      if (isBookingCheckViolation(error)) throw new BookingWindowInvalidException();
      throw error;
    }
  }

  private idempotencyKey(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const parsed = idempotencyKeySchema.safeParse(value);
    if (!parsed.success) throw new IdempotencyKeyInvalidException();
    return parsed.data;
  }

  private throwWindow(code: BookingWindowErrorCode): never {
    if (code === 'BOOKING_WINDOW_INVALID') throw new BookingWindowInvalidException();
    if (code === 'POLICY_INVALID') throw new BookingPolicyUnavailableException();
    throw new BookingWindowException(code);
  }

  private async lockMachine(transaction: Transaction, machineId: string): Promise<LockedMachine> {
    const rows = await transaction.$queryRaw<LockedMachine[]>`
      SELECT m.id, m.asset_tag AS "assetTag", m.name,
        m.deleted_at AS "deletedAt", m.condition::text AS condition,
        m.is_bookable AS "isBookable", m.requires_approval AS "requiresApproval",
        m.allow_booking_when_needs_service AS "allowBookingWhenNeedsService",
        m.max_booking_minutes AS "maxBookingMinutes", m.buffer_minutes AS "bufferMinutes",
        category.default_max_booking_minutes AS "defaultMaxBookingMinutes"
      FROM machines m
      JOIN machine_categories category ON category.id = m.category_id
      WHERE m.id = ${machineId}::uuid
      FOR UPDATE OF m
    `;
    const machine = rows[0];
    if (machine === undefined || machine.deletedAt !== null) {
      throw new BookingMachineNotFoundException();
    }
    return machine;
  }

  private async lockRequester(transaction: Transaction, userId: string): Promise<void> {
    const rows = await transaction.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM users WHERE id = ${userId}::uuid FOR NO KEY UPDATE
    `;
    if (rows[0] === undefined) throw new PermissionDeniedException();
  }

  private async databaseClock(transaction: Transaction): Promise<Date> {
    const rows = await transaction.$queryRaw<Array<{ now: Date }>>`
      SELECT clock_timestamp() AS now
    `;
    const now = rows[0]?.now;
    if (now === undefined) throw new Error('Database clock returned no value');
    return now;
  }

  private async assertNoUsageConflict(
    transaction: Transaction,
    machineId: string,
    now: Date,
    maxDurationMinutes: number,
    candidateStart: Date,
    candidateEnd: Date,
  ): Promise<void> {
    const session = await transaction.usageSession.findFirst({
      select: { expectedEndAt: true },
      where: { endedAt: null, machineId },
    });
    if (session === null) return;
    const estimated = session.expectedEndAt === null || session.expectedEndAt <= now;
    const blockEnd =
      session.expectedEndAt !== null && session.expectedEndAt > now
        ? session.expectedEndAt
        : new Date(now.getTime() + maxDurationMinutes * 60_000);
    if (candidateStart < blockEnd && candidateEnd > now) {
      throw new BookingMachineInUseException(blockEnd, estimated);
    }
  }

  private async findConflict(
    client: Pick<Transaction, 'booking'> | PrismaService,
    machineId: string,
    start: Date,
    blockedUntil: Date,
  ): Promise<null | { blocked_until: string; ends_at: string; starts_at: string; status: string }> {
    const conflict = await client.booking.findFirst({
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: { blockedUntil: true, endsAt: true, startsAt: true, status: true },
      where: {
        blockedUntil: { gt: start },
        machineId,
        startsAt: { lt: blockedUntil },
        status: { in: ACTIVE_BOOKING_STATUSES },
      },
    });
    return conflict === null
      ? null
      : {
          blocked_until: conflict.blockedUntil.toISOString(),
          ends_at: conflict.endsAt.toISOString(),
          starts_at: conflict.startsAt.toISOString(),
          status: conflict.status,
        };
  }

  private async replay(
    userId: string,
    idempotencyKey: string | undefined,
    input: CreateBookingInput,
    client: Pick<Transaction, 'auditLog' | 'booking'> | PrismaService = this.prisma,
  ): Promise<CreatedBooking | null> {
    if (idempotencyKey === undefined) return null;
    const booking = await client.booking.findFirst({
      include: { machine: { select: { assetTag: true, id: true, name: true } } },
      where: { idempotencyKey, requestedByUserId: userId },
    });
    if (booking === null) return null;
    if (!sameRequest(booking, input)) throw new IdempotencyKeyReusedException();
    const audit = await client.auditLog.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { after: true },
      where: { action: 'booking.created', entityId: booking.id, entityType: 'booking' },
    });
    const requiresApproval =
      requiresApprovalFromAudit(audit?.after ?? null) ?? booking.status === 'PENDING';
    return toDto(booking, requiresApproval);
  }
}
