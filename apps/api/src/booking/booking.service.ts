import { Injectable } from '@nestjs/common';
import {
  can,
  canBookingTransition,
  candidateBlockedRange,
  getPermissionScope,
  idempotencyKeySchema,
  validateBookingWindow,
  type ApproveBookingInput,
  type CancelBookingInput,
  type CreateBookingInput,
  type CreatedBooking,
  type ListBookingsQuery,
  type ManagedBooking,
  type ManagedBookingPage,
  type RejectBookingInput,
  type UpdateBookingInput,
  type BookingPolicyMachine,
  type BookingWindowErrorCode,
  type MachineCondition,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PermissionDeniedException } from '../authorization/permission-denied.exception';
import { AuditService } from '../audit/audit.service';
import { Prisma, type Booking, type BookingStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BookingMachineNotFoundException } from './booking.errors';
import {
  BookingChangedException,
  BookingNotFoundException,
  BookingNotModifiableException,
  BookingNotPendingException,
  BookingRequesterInactiveException,
  BookingSelfApprovalDeniedException,
  BookingStartPassedException,
} from './booking.errors';
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
  departmentId: string;
  id: string;
  isBookable: boolean;
  maxBookingMinutes: number | null;
  name: string;
  requiresApproval: boolean;
};

type BookingWithMachine = Booking & { machine: { assetTag: string; id: string; name: string } };
type BookingOutcome = { booking: CreatedBooking; replayed: boolean };
type Transaction = Prisma.TransactionClient;

type LifecycleBooking = Prisma.BookingGetPayload<{
  include: {
    approvedByUser: { select: { fullName: true; id: true } };
    machine: {
      include: { department: { select: { code: true; id: true; name: true } } };
    };
    requestedByUser: { select: { fullName: true; id: true; isActive: true } };
  };
}>;

type LifecycleAudit = {
  action: string;
  actorUser: { fullName: string; id: string } | null;
  createdAt: Date;
  entityId: string;
  lateCancelled: boolean | null;
  requiresApproval: boolean | null;
};

type RawLifecycleAudit = Omit<LifecycleAudit, 'actorUser'> & {
  actorFullName: string | null;
  actorId: string | null;
};

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

  async list(actor: AuthenticatedUser, query: ListBookingsQuery): Promise<ManagedBookingPage> {
    const asOf = await this.readClock();
    const where = this.listWhere(actor, query, asOf);
    const orderBy = [
      { [query.sort === 'starts_at' ? 'startsAt' : 'createdAt']: query.order },
      { id: query.order },
    ] as Prisma.BookingOrderByWithRelationInput[];
    const [items, total] = await Promise.all([
      this.prisma.booking.findMany({
        include: this.lifecycleInclude(),
        orderBy,
        skip: (query.page - 1) * query.page_size,
        take: query.page_size,
        where,
      }),
      this.prisma.booking.count({ where }),
    ]);
    const audits = await this.lifecycleAudits(items.map((item) => item.id));
    return {
      items: items.map((item) => this.toManagedDto(actor, item, asOf, audits.get(item.id) ?? [])),
      meta: { page: query.page, page_size: query.page_size, total },
    };
  }

  async get(actor: AuthenticatedUser, id: string): Promise<ManagedBooking> {
    const asOf = await this.readClock();
    const booking = await this.prisma.booking.findUnique({
      include: this.lifecycleInclude(),
      where: { id },
    });
    if (booking === null || !this.canRead(actor, booking)) throw new BookingNotFoundException();
    const audits = await this.lifecycleAudits([id]);
    return this.toManagedDto(actor, booking, asOf, audits.get(id) ?? []);
  }

  async update(
    actor: AuthenticatedUser,
    id: string,
    input: UpdateBookingInput,
    requestId: string,
  ): Promise<ManagedBooking> {
    if (!can(actor.role, 'booking:create')) throw new PermissionDeniedException();
    return this.mutate(actor, id, async (transaction, booking, machine, now) => {
      this.assertMutationAccess(actor, booking, false);
      this.assertExpectedVersion(booking, input.expected_updated_at);
      if (
        (!canBookingTransition(booking.status, 'PENDING') &&
          !canBookingTransition(booking.status, 'CANCELLED')) ||
        booking.startsAt <= now
      ) {
        throw new BookingNotModifiableException();
      }
      const nextPurpose = input.purpose ?? booking.purpose;
      const nextStart =
        input.starts_at === undefined ? booking.startsAt : new Date(input.starts_at);
      const nextEnd = input.ends_at === undefined ? booking.endsAt : new Date(input.ends_at);
      const timeChanged =
        nextStart.getTime() !== booking.startsAt.getTime() ||
        nextEnd.getTime() !== booking.endsAt.getTime();
      const purposeChanged = nextPurpose !== booking.purpose;
      if (!timeChanged && !purposeChanged) return { audit: false, booking };

      let nextBlockedUntil = booking.blockedUntil;
      let nextStatus = booking.status;
      let nextApprovedBy = booking.approvedByUserId;
      let nextDecisionNote = booking.decisionNote;
      let effectiveBuffer = this.bufferMinutes(booking);
      let requiresApproval = this.requiresApproval(booking, []);
      if (timeChanged) {
        const settings = await this.policies.readSettings(transaction);
        const policy = this.policies.resolve(
          this.policyMachine(machine),
          { defaultMaxBookingMinutes: machine.defaultMaxBookingMinutes },
          settings,
        );
        const validation = validateBookingWindow(policy, nextStart, nextEnd, now);
        if (!validation.ok) this.throwWindow(validation.code);
        effectiveBuffer = validation.bufferMinutes;
        nextBlockedUntil = candidateBlockedRange(nextStart, nextEnd, effectiveBuffer).end;
        await this.assertNoUsageConflict(
          transaction,
          machine.id,
          now,
          policy.maxDurationMinutes.value,
          nextStart,
          nextBlockedUntil,
        );
        const conflict = await this.findConflict(
          transaction,
          machine.id,
          nextStart,
          nextBlockedUntil,
          booking.id,
        );
        if (conflict !== null) throw new BookingConflictException(conflict);
        const shrinksApprovedWindow =
          booking.status === 'CONFIRMED' &&
          nextStart >= booking.startsAt &&
          nextEnd <= booking.endsAt &&
          nextBlockedUntil <= booking.blockedUntil;
        requiresApproval = policy.requiresApproval.value;
        if (!shrinksApprovedWindow) {
          nextStatus = requiresApproval ? 'PENDING' : 'CONFIRMED';
          nextApprovedBy = null;
          nextDecisionNote = null;
        }
      }
      const updatedAt = this.nextVersion(booking.updatedAt, now);
      let updated: LifecycleBooking;
      try {
        updated = await transaction.booking.update({
          data: {
            approvedByUserId: nextApprovedBy,
            blockedUntil: nextBlockedUntil,
            decisionNote: nextDecisionNote,
            endsAt: nextEnd,
            purpose: nextPurpose,
            startsAt: nextStart,
            status: nextStatus,
            updatedAt,
          },
          include: this.lifecycleInclude(),
          where: { id: booking.id },
        });
      } catch (error: unknown) {
        if (!isExclusionViolation(error)) throw error;
        const conflict = await this.findConflict(
          transaction,
          machine.id,
          nextStart,
          nextBlockedUntil,
          booking.id,
        );
        if (conflict !== null) throw new BookingConflictException(conflict);
        throw error;
      }
      await this.audit.record(transaction, {
        action: 'booking.rescheduled',
        actorUserId: actor.id,
        after: this.auditState(updated),
        before: this.auditState(booking),
        context: { effectiveBufferMinutes: effectiveBuffer, requiresApproval, timeChanged },
        entityId: booking.id,
        entityType: 'booking',
        requestId,
      });
      return { audit: true, booking: updated };
    });
  }

  async cancel(
    actor: AuthenticatedUser,
    id: string,
    input: CancelBookingInput,
    requestId: string,
  ): Promise<ManagedBooking> {
    return this.mutate(
      actor,
      id,
      async (transaction, booking, _machine, now) => {
        this.assertMutationAccess(actor, booking, true);
        if (booking.status === 'CANCELLED') return { audit: false, booking };
        if (!canBookingTransition(booking.status, 'CANCELLED')) {
          throw new BookingNotModifiableException();
        }
        const lateCancelled = now >= booking.startsAt;
        const updated = await transaction.booking.update({
          data: {
            cancelledReason: input.reason,
            status: 'CANCELLED',
            updatedAt: this.nextVersion(booking.updatedAt, now),
          },
          include: this.lifecycleInclude(),
          where: { id },
        });
        await this.audit.record(transaction, {
          action: 'booking.cancelled',
          actorUserId: actor.id,
          after: this.auditState(updated),
          before: this.auditState(booking),
          context: { lateCancelled, requesterUserId: booking.requestedByUserId },
          entityId: id,
          entityType: 'booking',
          requestId,
        });
        return { audit: true, booking: updated };
      },
      { allowDeletedMachine: true },
    );
  }

  async approve(
    actor: AuthenticatedUser,
    id: string,
    input: ApproveBookingInput,
    requestId: string,
  ): Promise<ManagedBooking> {
    return this.decide(actor, id, 'CONFIRMED', input.note, requestId);
  }

  async reject(
    actor: AuthenticatedUser,
    id: string,
    input: RejectBookingInput,
    requestId: string,
  ): Promise<ManagedBooking> {
    return this.decide(actor, id, 'REJECTED', input.note, requestId);
  }

  private async decide(
    actor: AuthenticatedUser,
    id: string,
    target: 'CONFIRMED' | 'REJECTED',
    note: string | undefined,
    requestId: string,
  ): Promise<ManagedBooking> {
    if (!can(actor.role, 'booking:approve')) throw new PermissionDeniedException();
    return this.mutate(
      actor,
      id,
      async (transaction, booking, machine, now, requesterActive) => {
        this.assertDecisionAccess(actor, booking);
        if (!canBookingTransition(booking.status, target)) throw new BookingNotPendingException();
        if (target === 'CONFIRMED') {
          if (booking.startsAt <= now) throw new BookingStartPassedException();
          if (!requesterActive) throw new BookingRequesterInactiveException();
          if (machine.deletedAt !== null) throw new BookingWindowException('MACHINE_NOT_BOOKABLE');
          const settings = await this.policies.readSettings(transaction);
          const policy = this.policies.resolve(
            this.policyMachine(machine),
            { defaultMaxBookingMinutes: machine.defaultMaxBookingMinutes },
            settings,
          );
          if (!policy.bookable) throw new BookingWindowException('MACHINE_NOT_BOOKABLE');
        }
        const updated = await transaction.booking.update({
          data: {
            approvedByUserId: target === 'CONFIRMED' ? actor.id : null,
            decisionNote: note === '' ? null : (note ?? null),
            status: target,
            updatedAt: this.nextVersion(booking.updatedAt, now),
          },
          include: this.lifecycleInclude(),
          where: { id },
        });
        await this.audit.record(transaction, {
          action: target === 'CONFIRMED' ? 'booking.approved' : 'booking.rejected',
          actorUserId: actor.id,
          after: this.auditState(updated),
          before: this.auditState(booking),
          context: { requesterUserId: booking.requestedByUserId },
          entityId: id,
          entityType: 'booking',
          requestId,
        });
        return { audit: true, booking: updated };
      },
      { allowDeletedMachine: true },
    );
  }

  private async mutate(
    actor: AuthenticatedUser,
    id: string,
    operation: (
      transaction: Transaction,
      booking: LifecycleBooking,
      machine: LockedMachine,
      now: Date,
      requesterActive: boolean,
    ) => Promise<{ audit: boolean; booking: LifecycleBooking }>,
    options: { allowDeletedMachine?: boolean } = {},
  ): Promise<ManagedBooking> {
    try {
      const result = await this.prisma.$transaction(
        async (transaction) => {
          await transaction.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
          const locator = await transaction.booking.findUnique({
            select: { machineId: true, requestedByUserId: true },
            where: { id },
          });
          if (locator === null) throw new BookingNotFoundException();
          const machine = await this.lockMachine(
            transaction,
            locator.machineId,
            options.allowDeletedMachine === true,
          );
          const requesterActive = await this.lockRequester(transaction, locator.requestedByUserId);
          await transaction.$queryRaw`
            SELECT id FROM bookings WHERE id = ${id}::uuid FOR UPDATE
          `;
          const booking = await transaction.booking.findUnique({
            include: this.lifecycleInclude(),
            where: { id },
          });
          if (
            booking === null ||
            booking.machineId !== locator.machineId ||
            booking.requestedByUserId !== locator.requestedByUserId
          ) {
            throw new BookingChangedException();
          }
          const now = await this.databaseClock(transaction);
          return operation(transaction, booking, machine, now, requesterActive);
        },
        { timeout: TRANSACTION_TIMEOUT_MS },
      );
      const asOf = await this.readClock();
      const audits = await this.lifecycleAudits([result.booking.id]);
      return this.toManagedDto(actor, result.booking, asOf, audits.get(result.booking.id) ?? []);
    } catch (error: unknown) {
      if (isLockTimeout(error)) throw new BookingMachineBusyException();
      throw error;
    }
  }

  private lifecycleInclude() {
    return {
      approvedByUser: { select: { fullName: true, id: true } },
      machine: {
        include: { department: { select: { code: true, id: true, name: true } } },
      },
      requestedByUser: { select: { fullName: true, id: true, isActive: true } },
    } as const;
  }

  private async readClock(): Promise<Date> {
    const rows = await this.prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    const now = rows[0]?.now;
    if (now === undefined) throw new Error('Database clock returned no value');
    return now;
  }

  private listWhere(
    actor: AuthenticatedUser,
    query: ListBookingsQuery,
    asOf: Date,
  ): Prisma.BookingWhereInput {
    const where: Prisma.BookingWhereInput = {};
    if (query.view === 'mine') where.requestedByUserId = actor.id;
    if (query.view === 'all') {
      if (getPermissionScope(actor.role, 'booking:approve') !== 'GLOBAL') {
        throw new PermissionDeniedException();
      }
    }
    if (query.view === 'managed') {
      const scope = getPermissionScope(actor.role, 'booking:approve');
      if (scope === 'NONE' || (scope === 'OWN_DEPARTMENT' && actor.department === null)) {
        throw new PermissionDeniedException();
      }
      if (scope === 'OWN_DEPARTMENT') where.machine = { departmentId: actor.department!.id };
      if (query.status === undefined) where.status = 'PENDING';
    }
    if (query.status !== undefined) where.status = { in: query.status };
    if (query.machine_id !== undefined) where.machineId = query.machine_id;
    if (query.when === 'upcoming') {
      where.AND = [
        { endsAt: { gt: asOf } },
        { status: { notIn: ['COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'] } },
      ];
    } else if (query.when === 'past') {
      where.OR = [
        { endsAt: { lte: asOf } },
        { status: { in: ['COMPLETED', 'CANCELLED', 'REJECTED', 'NO_SHOW'] } },
      ];
    }
    return where;
  }

  private canRead(actor: AuthenticatedUser, booking: LifecycleBooking): boolean {
    if (booking.requestedByUserId === actor.id) return true;
    const scope = getPermissionScope(actor.role, 'booking:approve');
    return (
      scope === 'GLOBAL' ||
      (scope === 'OWN_DEPARTMENT' &&
        actor.department !== null &&
        actor.department.id === booking.machine.departmentId)
    );
  }

  private canManage(actor: AuthenticatedUser, booking: LifecycleBooking): boolean {
    const scope = getPermissionScope(actor.role, 'booking:approve');
    return (
      scope === 'GLOBAL' ||
      (scope === 'OWN_DEPARTMENT' &&
        actor.department !== null &&
        actor.department.id === booking.machine.departmentId)
    );
  }

  private assertMutationAccess(
    actor: AuthenticatedUser,
    booking: LifecycleBooking,
    allowOwner: boolean,
  ): void {
    if (allowOwner && booking.requestedByUserId === actor.id) return;
    if (!allowOwner && booking.requestedByUserId === actor.id) return;
    if (!this.canManage(actor, booking)) throw new BookingNotFoundException();
  }

  private assertDecisionAccess(actor: AuthenticatedUser, booking: LifecycleBooking): void {
    if (!this.canManage(actor, booking)) throw new BookingNotFoundException();
    if (booking.requestedByUserId === actor.id) throw new BookingSelfApprovalDeniedException();
  }

  private assertExpectedVersion(booking: LifecycleBooking, expected: string): void {
    if (booking.updatedAt.getTime() !== Date.parse(expected)) throw new BookingChangedException();
  }

  private nextVersion(previous: Date, now: Date): Date {
    return new Date(Math.max(now.getTime(), previous.getTime() + 1));
  }

  private bufferMinutes(booking: LifecycleBooking): number {
    return Math.max(
      0,
      Math.round((booking.blockedUntil.getTime() - booking.endsAt.getTime()) / 60_000),
    );
  }

  private policyMachine(machine: LockedMachine): BookingPolicyMachine {
    return {
      allowBookingWhenNeedsService: machine.allowBookingWhenNeedsService,
      bufferMinutes: machine.bufferMinutes,
      condition: machine.condition,
      isBookable: machine.isBookable,
      maxBookingMinutes: machine.maxBookingMinutes,
      requiresApproval: machine.requiresApproval,
    };
  }

  private auditState(booking: LifecycleBooking): Prisma.InputJsonObject {
    return {
      blockedUntil: booking.blockedUntil.toISOString(),
      endsAt: booking.endsAt.toISOString(),
      machineId: booking.machineId,
      startsAt: booking.startsAt.toISOString(),
      status: booking.status,
    };
  }

  private async lifecycleAudits(ids: string[]): Promise<Map<string, LifecycleAudit[]>> {
    const map = new Map<string, LifecycleAudit[]>();
    if (ids.length === 0) return map;
    const rows = await this.prisma.$queryRaw<RawLifecycleAudit[]>(Prisma.sql`
      SELECT audit.entity_id AS "entityId", audit.action, audit.created_at AS "createdAt",
        actor.id AS "actorId", actor.full_name AS "actorFullName",
        CASE WHEN audit.action = 'booking.cancelled'
          THEN (audit.after #>> '{context,lateCancelled}')::boolean ELSE NULL END AS "lateCancelled",
        CASE WHEN audit.action IN ('booking.created', 'booking.rescheduled')
          THEN (audit.after #>> '{context,requiresApproval}')::boolean ELSE NULL END AS "requiresApproval"
      FROM audit_logs audit
      LEFT JOIN users actor ON actor.id = audit.actor_user_id
      WHERE audit.entity_type = 'booking'
        AND audit.entity_id IN (${Prisma.join(ids)})
        AND audit.action IN (
          'booking.created', 'booking.rescheduled', 'booking.cancelled',
          'booking.approved', 'booking.rejected'
        )
      ORDER BY audit.created_at ASC, audit.id ASC
    `);
    for (const row of rows) {
      const audit: LifecycleAudit = {
        action: row.action,
        actorUser:
          row.actorId === null || row.actorFullName === null
            ? null
            : { fullName: row.actorFullName, id: row.actorId },
        createdAt: row.createdAt,
        entityId: row.entityId,
        lateCancelled: row.lateCancelled,
        requiresApproval: row.requiresApproval,
      };
      map.set(row.entityId, [...(map.get(row.entityId) ?? []), audit]);
    }
    return map;
  }

  private requiresApproval(booking: LifecycleBooking, audits: LifecycleAudit[]): boolean {
    const source = [...audits]
      .reverse()
      .find((audit) => ['booking.created', 'booking.rescheduled'].includes(audit.action));
    return source?.requiresApproval !== null && source?.requiresApproval !== undefined
      ? source.requiresApproval
      : booking.status === 'PENDING' || booking.approvedByUserId !== null;
  }

  private toManagedDto(
    actor: AuthenticatedUser,
    booking: LifecycleBooking,
    asOf: Date,
    audits: LifecycleAudit[],
  ): ManagedBooking {
    const cancellation = audits.find((audit) => audit.action === 'booking.cancelled');
    const decisionAction =
      booking.status === 'CONFIRMED'
        ? 'booking.approved'
        : booking.status === 'REJECTED'
          ? 'booking.rejected'
          : null;
    const decision =
      decisionAction === null
        ? undefined
        : [...audits].reverse().find((audit) => audit.action === decisionAction);
    const canManage = this.canManage(actor, booking);
    const owner = booking.requestedByUserId === actor.id;
    const future = booking.startsAt > asOf;
    const pending = booking.status === 'PENDING';
    const modifiable = canBookingTransition(booking.status, 'CANCELLED');
    const removed = booking.machine.deletedAt !== null;
    return {
      approved_or_decided_by: (() => {
        const user = decision?.actorUser ?? booking.approvedByUser;
        return user === null || user === undefined
          ? null
          : { full_name: user.fullName, id: user.id };
      })(),
      as_of: asOf.toISOString(),
      blocked_until: booking.blockedUntil.toISOString(),
      cancelled_at: cancellation?.createdAt.toISOString() ?? null,
      cancellation_reason: owner || canManage ? booking.cancelledReason : null,
      capabilities: {
        can_approve:
          !removed && canManage && !owner && pending && future && booking.requestedByUser.isActive,
        can_cancel: (owner || canManage) && modifiable,
        can_reject: canManage && !owner && pending,
        can_reschedule:
          !removed &&
          can(actor.role, 'booking:create') &&
          (owner || canManage) &&
          modifiable &&
          future,
      },
      created_at: booking.createdAt.toISOString(),
      decided_at: decision?.createdAt.toISOString() ?? null,
      decision_note: owner || canManage ? booking.decisionNote : null,
      effective_buffer_minutes: this.bufferMinutes(booking),
      ends_at: booking.endsAt.toISOString(),
      id: booking.id,
      late_cancelled: cancellation?.lateCancelled === true,
      machine: {
        asset_tag: removed ? null : booking.machine.assetTag,
        id: booking.machine.id,
        is_removed: removed,
        name: removed ? null : booking.machine.name,
        owning_department: removed
          ? null
          : {
              code: booking.machine.department.code,
              id: booking.machine.department.id,
              name: booking.machine.department.name,
            },
      },
      purpose: booking.purpose,
      requester: { full_name: booking.requestedByUser.fullName, id: booking.requestedByUser.id },
      requires_approval: this.requiresApproval(booking, audits),
      stale: ['PENDING', 'CONFIRMED'].includes(booking.status) && !future,
      starts_at: booking.startsAt.toISOString(),
      status: booking.status,
      updated_at: booking.updatedAt.toISOString(),
    };
  }

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

  private async lockMachine(
    transaction: Transaction,
    machineId: string,
    allowDeleted = false,
  ): Promise<LockedMachine> {
    const rows = await transaction.$queryRaw<LockedMachine[]>`
      SELECT m.id, m.asset_tag AS "assetTag", m.name,
        m.department_id AS "departmentId",
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
    if (machine === undefined || (!allowDeleted && machine.deletedAt !== null)) {
      throw new BookingMachineNotFoundException();
    }
    return machine;
  }

  private async lockRequester(transaction: Transaction, userId: string): Promise<boolean> {
    const rows = await transaction.$queryRaw<Array<{ id: string; isActive: boolean }>>`
      SELECT id, is_active AS "isActive" FROM users
      WHERE id = ${userId}::uuid FOR NO KEY UPDATE
    `;
    if (rows[0] === undefined) throw new PermissionDeniedException();
    return rows[0].isActive;
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
    excludeBookingId?: string,
  ): Promise<null | { blocked_until: string; ends_at: string; starts_at: string; status: string }> {
    const conflict = await client.booking.findFirst({
      orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      select: { blockedUntil: true, endsAt: true, startsAt: true, status: true },
      where: {
        blockedUntil: { gt: start },
        machineId,
        ...(excludeBookingId === undefined ? {} : { id: { not: excludeBookingId } }),
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
