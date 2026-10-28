import { Injectable } from '@nestjs/common';
import {
  can,
  MACHINE_ALLOWED_TRANSITIONS,
  type MachineCondition,
  type MachineConditionHistoryPage,
  type MachineConditionTransitionEvent,
  type MachineConditionTransitionResult,
  type MachineHistoryQuery,
  type MachineStatusSource,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PermissionDeniedException } from '../authorization/permission-denied.exception';
import { AuditService } from '../audit/audit.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConditionChangedException,
  ConditionForceInvalidException,
  ConditionTicketNotFoundException,
  ConditionReasonInvalidException,
  ConditionUnchangedException,
  InvalidConditionTransitionException,
  MachineDeletedException,
} from './condition.errors';
import { ConditionEventsService } from './condition-events.service';
import { MachineHasOpenSessionException, MachineNotFoundException } from './machines.errors';

export type ConditionTransitionContext = {
  actor: AuthenticatedUser;
  force?: boolean;
  fromCondition?: MachineCondition;
  reason: string;
  requestId: string;
  source: MachineStatusSource;
  ticketId?: string;
};

const retirementBoundary = (from: MachineCondition, to: MachineCondition): boolean =>
  from === 'RETIRED' || to === 'RETIRED';

const nairobiDate = (now: Date): Date => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(`${value.year}-${value.month}-${value.day}T00:00:00.000Z`);
};

const dateOnly = (value: Date | null): string | null =>
  value === null ? null : value.toISOString().slice(0, 10);

@Injectable()
export class ConditionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: ConditionEventsService,
  ) {}

  async transition(
    machineId: string,
    toCondition: MachineCondition,
    context: ConditionTransitionContext,
  ): Promise<MachineConditionTransitionResult> {
    if (!can(context.actor.role, 'service:manage')) throw new PermissionDeniedException();
    const reason = context.reason.normalize('NFC').trim().replace(/\s+/gu, ' ');
    if (
      reason.length === 0 ||
      reason.length > 200 ||
      (context.force === true && reason.length < 10)
    ) {
      throw new ConditionReasonInvalidException();
    }
    const force = context.force === true;
    const transitionedAt = new Date();
    const outcome = await this.prisma.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM machines WHERE id = ${machineId}::uuid FOR UPDATE`;
      const machine = await transaction.machine.findUnique({
        select: { condition: true, deletedAt: true, id: true, retiredOn: true },
        where: { id: machineId },
      });
      if (machine === null) throw new MachineNotFoundException();
      if (machine.deletedAt !== null) throw new MachineDeletedException();
      const fromCondition = machine.condition as MachineCondition;

      if (context.fromCondition !== undefined && context.fromCondition !== fromCondition) {
        throw new ConditionChangedException(fromCondition);
      }
      if (toCondition === fromCondition) throw new ConditionUnchangedException();
      if (!MACHINE_ALLOWED_TRANSITIONS[fromCondition].includes(toCondition as never)) {
        throw new InvalidConditionTransitionException();
      }
      if (
        retirementBoundary(fromCondition, toCondition) &&
        !can(context.actor.role, 'machine:retire')
      ) {
        throw new PermissionDeniedException();
      }

      await this.assertInternalSource(transaction, machineId, context);
      const openSessionCount = await transaction.usageSession.count({
        where: { endedAt: null, machineId },
      });
      if (openSessionCount > 0) {
        if (toCondition === 'UNDER_MAINTENANCE' || toCondition === 'RETIRED') {
          throw new MachineHasOpenSessionException();
        }
        if (toCondition === 'OUT_OF_SERVICE' && !force) {
          throw new MachineHasOpenSessionException();
        }
      }
      if (force && (toCondition !== 'OUT_OF_SERVICE' || openSessionCount === 0)) {
        throw new ConditionForceInvalidException();
      }

      const retiredOn =
        toCondition === 'RETIRED'
          ? nairobiDate(transitionedAt)
          : fromCondition === 'RETIRED'
            ? null
            : machine.retiredOn;
      const after = await transaction.machine.update({
        data: { condition: toCondition, retiredOn },
        select: { condition: true, id: true, retiredOn: true },
        where: { id: machineId },
      });
      await transaction.machineStatusHistory.create({
        data: {
          changedByUserId: context.actor.id,
          createdAt: transitionedAt,
          fromCondition,
          machineId,
          reason,
          source: context.source,
          ticketId: context.ticketId,
          toCondition,
        },
      });
      await this.audit.record(transaction, {
        action: 'machine.condition_changed',
        actorUserId: context.actor.id,
        after: { condition: toCondition, retiredOn: dateOnly(retiredOn) },
        before: { condition: fromCondition, retiredOn: dateOnly(machine.retiredOn) },
        context: { forced: force, reason },
        entityId: machineId,
        entityType: 'machine',
        requestId: context.requestId,
      });
      return {
        result: {
          condition: after.condition as MachineCondition,
          machineId: after.id,
          retiredOn: dateOnly(after.retiredOn),
        },
        event: {
          forced: force,
          from: fromCondition,
          machineId,
          requestId: context.requestId,
          source: context.source,
          timestamp: transitionedAt.toISOString(),
          to: toCondition,
        } satisfies MachineConditionTransitionEvent,
      };
    });

    await this.events.emit(outcome.event);
    return outcome.result;
  }

  async history(
    actor: AuthenticatedUser,
    machineId: string,
    query: MachineHistoryQuery,
  ): Promise<MachineConditionHistoryPage> {
    if (query.include_deleted === true && !can(actor.role, 'machine:restore')) {
      throw new PermissionDeniedException();
    }
    const machine = await this.prisma.machine.findFirst({
      select: { id: true },
      where:
        query.include_deleted === true ? { id: machineId } : { deletedAt: null, id: machineId },
    });
    if (machine === null) throw new MachineNotFoundException();
    const where = { machineId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.machineStatusHistory.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          changedByUser: { select: { fullName: true } },
          createdAt: true,
          fromCondition: true,
          id: true,
          reason: true,
          source: true,
          toCondition: true,
        },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        where,
      }),
      this.prisma.machineStatusHistory.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        actor: { fullName: row.changedByUser.fullName },
        createdAt: row.createdAt.toISOString(),
        fromCondition: row.fromCondition as MachineCondition | null,
        id: row.id,
        reason: row.reason,
        source: row.source as MachineStatusSource,
        toCondition: row.toCondition as MachineCondition,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
    };
  }

  private async assertInternalSource(
    transaction: Prisma.TransactionClient,
    machineId: string,
    context: ConditionTransitionContext,
  ): Promise<void> {
    if (context.source !== 'SERVICE_TICKET') {
      if (context.ticketId !== undefined) throw new ConditionTicketNotFoundException();
      return;
    }
    if (context.ticketId === undefined) throw new ConditionTicketNotFoundException();
    const ticket = await transaction.serviceTicket.findFirst({
      select: { id: true },
      where: { id: context.ticketId, machineId },
    });
    if (ticket === null) throw new ConditionTicketNotFoundException();
  }
}
