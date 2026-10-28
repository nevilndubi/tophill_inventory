import { jest } from '@jest/globals';
import {
  MACHINE_ALLOWED_TRANSITIONS,
  MACHINE_CONDITIONS,
  type MachineCondition,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ConditionChangedException,
  ConditionForceInvalidException,
  ConditionTicketNotFoundException,
  ConditionReasonInvalidException,
  ConditionUnchangedException,
  InvalidConditionTransitionException,
  MachineDeletedException,
} from './condition.errors';
import type { ConditionEventsService } from './condition-events.service';
import { ConditionService } from './condition.service';
import { MachineHasOpenSessionException } from './machines.errors';

const MACHINE_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const TICKET_ID = '33333333-3333-4333-8333-333333333333';
const actor = (role: AuthenticatedUser['role'] = 'ADMIN'): AuthenticatedUser => ({
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: ACTOR_ID,
  isActive: true,
  role,
});

const makeHarness = (from: MachineCondition = 'OPERATIONAL') => {
  const state = { condition: from, deletedAt: null as Date | null, retiredOn: null as Date | null };
  const tx = {
    $queryRaw: jest.fn(async () => [{ id: MACHINE_ID }]),
    auditLog: { create: jest.fn(async () => undefined) },
    machine: {
      findFirst: jest.fn(async () => ({ id: MACHINE_ID })),
      findUnique: jest.fn(async () => ({ id: MACHINE_ID, ...state })),
      update: jest.fn(
        async ({ data }: { data: { condition: MachineCondition; retiredOn: Date | null } }) => {
          state.condition = data.condition;
          state.retiredOn = data.retiredOn;
          return { id: MACHINE_ID, ...state };
        },
      ),
    },
    machineStatusHistory: {
      count: jest.fn(async () => 1),
      create: jest.fn(async () => undefined),
      findMany: jest.fn(async () => []),
    },
    serviceTicket: { findFirst: jest.fn(async () => ({ id: TICKET_ID })) },
    usageSession: { count: jest.fn(async () => 0) },
  };
  const prisma = {
    $transaction: jest.fn(async (argument: unknown) => {
      if (Array.isArray(argument)) return Promise.all(argument);
      return (argument as (client: typeof tx) => Promise<unknown>)(tx);
    }),
    machine: { findFirst: tx.machine.findFirst },
    machineStatusHistory: tx.machineStatusHistory,
  };
  const audit = { record: jest.fn(async () => undefined) };
  const events = { emit: jest.fn(async () => undefined) };
  const service = new ConditionService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    events as unknown as ConditionEventsService,
  );
  const transition = (to: MachineCondition, overrides = {}) =>
    service.transition(MACHINE_ID, to, {
      actor: actor(),
      fromCondition: from,
      reason: 'Verified equipment condition',
      requestId: 'request-1',
      source: 'MANUAL',
      ...overrides,
    });
  return { audit, events, prisma, service, state, transition, tx };
};

describe('ConditionService', () => {
  const allPairs = MACHINE_CONDITIONS.flatMap((from) =>
    MACHINE_CONDITIONS.filter((to) => to !== from).map((to) => [from, to] as const),
  );

  it.each(allPairs)('enforces the complete %s -> %s transition table', async (from, to) => {
    const { transition, tx } = makeHarness(from);
    const allowed = MACHINE_ALLOWED_TRANSITIONS[from].includes(to as never);
    if (allowed) {
      await expect(transition(to)).resolves.toMatchObject({ condition: to });
      expect(tx.machineStatusHistory.create).toHaveBeenCalledTimes(1);
    } else {
      await expect(transition(to)).rejects.toBeInstanceOf(InvalidConditionTransitionException);
      expect(tx.machine.update).not.toHaveBeenCalled();
    }
  });

  it('rejects unchanged and stale-screen transitions without writes', async () => {
    const unchanged = makeHarness('NEEDS_SERVICE');
    await expect(unchanged.transition('NEEDS_SERVICE')).rejects.toBeInstanceOf(
      ConditionUnchangedException,
    );
    const stale = makeHarness('NEEDS_SERVICE');
    await expect(
      stale.transition('OPERATIONAL', { fromCondition: 'OPERATIONAL' }),
    ).rejects.toBeInstanceOf(ConditionChangedException);
    expect(unchanged.tx.machineStatusHistory.create).not.toHaveBeenCalled();
    expect(stale.audit.record).not.toHaveBeenCalled();
  });

  it('allows needs-service during use and requires an explicit safety force for out-of-service', async () => {
    const needsService = makeHarness();
    needsService.tx.usageSession.count.mockResolvedValue(1);
    await expect(needsService.transition('NEEDS_SERVICE')).resolves.toBeDefined();

    const unsafe = makeHarness();
    unsafe.tx.usageSession.count.mockResolvedValue(1);
    await expect(unsafe.transition('OUT_OF_SERVICE')).rejects.toBeInstanceOf(
      MachineHasOpenSessionException,
    );
    await expect(unsafe.transition('OUT_OF_SERVICE', { force: true })).resolves.toMatchObject({
      condition: 'OUT_OF_SERVICE',
    });
    expect(unsafe.audit.record).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ context: expect.objectContaining({ forced: true }) }),
    );
  });

  it.each(['UNDER_MAINTENANCE', 'RETIRED'] as const)(
    'always blocks %s while a usage session is open',
    async (to) => {
      const harness = makeHarness();
      harness.tx.usageSession.count.mockResolvedValue(1);
      await expect(harness.transition(to, { force: true })).rejects.toBeInstanceOf(
        MachineHasOpenSessionException,
      );
    },
  );

  it('rejects force when there is no open session', async () => {
    const { transition } = makeHarness();
    await expect(transition('OUT_OF_SERVICE', { force: true })).rejects.toBeInstanceOf(
      ConditionForceInvalidException,
    );
  });

  it('enforces service:manage and reason rules inside the service boundary', async () => {
    const harness = makeHarness();
    await expect(
      harness.transition('NEEDS_SERVICE', { actor: actor('STAFF') }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PERMISSION_DENIED' }) });
    await expect(harness.transition('NEEDS_SERVICE', { reason: '   ' })).rejects.toBeInstanceOf(
      ConditionReasonInvalidException,
    );
    expect(harness.tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('requires machine:retire to cross the retirement boundary', async () => {
    const retiring = makeHarness();
    await expect(
      retiring.transition('RETIRED', { actor: actor('BIOMED_TECH') }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PERMISSION_DENIED' }) });
    const reinstating = makeHarness('RETIRED');
    await expect(
      reinstating.transition('UNDER_MAINTENANCE', { actor: actor('BIOMED_TECH') }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'PERMISSION_DENIED' }) });
  });

  it('sets and clears retired_on using the Nairobi calendar date', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-28T21:30:00.000Z'));
    const retiring = makeHarness();
    await expect(retiring.transition('RETIRED')).resolves.toMatchObject({
      retiredOn: '2026-10-29',
    });
    const reinstating = makeHarness('RETIRED');
    reinstating.state.retiredOn = new Date('2026-10-29T00:00:00.000Z');
    await expect(reinstating.transition('UNDER_MAINTENANCE')).resolves.toMatchObject({
      retiredOn: null,
    });
    jest.useRealTimers();
  });

  it('rejects deleted machines and validates service-ticket ownership', async () => {
    const deleted = makeHarness();
    deleted.state.deletedAt = new Date();
    await expect(deleted.transition('NEEDS_SERVICE')).rejects.toBeInstanceOf(
      MachineDeletedException,
    );

    const ticket = makeHarness();
    ticket.tx.serviceTicket.findFirst.mockResolvedValue(null as never);
    await expect(
      ticket.transition('NEEDS_SERVICE', { source: 'SERVICE_TICKET', ticketId: TICKET_ID }),
    ).rejects.toBeInstanceOf(ConditionTicketNotFoundException);
  });

  it.each(['machine', 'history', 'audit'] as const)(
    'rolls back and emits no event when the %s write fails',
    async (stage) => {
      const harness = makeHarness();
      const failure = new Error(`${stage} failed`);
      if (stage === 'machine') harness.tx.machine.update.mockRejectedValueOnce(failure);
      if (stage === 'history')
        harness.tx.machineStatusHistory.create.mockRejectedValueOnce(failure);
      if (stage === 'audit') harness.audit.record.mockRejectedValueOnce(failure);
      await expect(harness.transition('NEEDS_SERVICE')).rejects.toBe(failure);
      expect(harness.events.emit).not.toHaveBeenCalled();
    },
  );

  it('emits the typed hook only after the transaction commits', async () => {
    const harness = makeHarness();
    await harness.transition('NEEDS_SERVICE');
    expect(harness.events.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        forced: false,
        from: 'OPERATIONAL',
        machineId: MACHINE_ID,
        source: 'MANUAL',
        to: 'NEEDS_SERVICE',
      }),
    );
    expect(harness.prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      harness.events.emit.mock.invocationCallOrder[0]!,
    );
  });

  it('returns newest-first minimized history including the registration row', async () => {
    const harness = makeHarness();
    harness.tx.machineStatusHistory.findMany.mockResolvedValue([
      {
        changedByUser: { fullName: 'Test User' },
        createdAt: new Date('2026-10-28T10:00:00.000Z'),
        fromCondition: null,
        id: '44444444-4444-4444-8444-444444444444',
        reason: 'Machine registered',
        source: 'SYSTEM',
        toCondition: 'OPERATIONAL',
      },
    ] as never);
    const result = await harness.service.history(actor(), MACHINE_ID, {
      page: 1,
      pageSize: 50,
    });
    expect(result.items[0]).toEqual(
      expect.objectContaining({ actor: { fullName: 'Test User' }, fromCondition: null }),
    );
    expect(result.items[0]).not.toHaveProperty('ticketId');
    expect(result.items[0]).not.toHaveProperty('email');
    expect(harness.tx.machineStatusHistory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] }),
    );
  });
});
