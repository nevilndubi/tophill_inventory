import { jest } from '@jest/globals';
import { BadRequestException, Logger } from '@nestjs/common';
import { machineTimelineQuerySchema } from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import { PermissionDeniedException } from '../authorization/permission-denied.exception';
import type { PrismaService } from '../prisma/prisma.service';
import { MachineNotFoundException } from './machines.errors';
import { TimelineService } from './timeline.service';

const actor = (role: AuthenticatedUser['role']): AuthenticatedUser => ({
  department: null,
  email: 'redacted-for-test',
  fullName: 'Timeline User',
  id: '11111111-1111-4111-8111-111111111111',
  isActive: true,
  role,
});

const queryResult = (overrides: Record<string, unknown> = {}) => ({
  asOf: new Date('2026-10-30T09:00:00.000Z'),
  cutoff: new Date('2026-10-30T09:00:00.000Z'),
  duplicateEndingAudits: [],
  futureUntil: false,
  items: [
    {
      duration_seconds: 3600,
      end_note: null,
      ended_at: '2026-10-30T08:00:00.000Z',
      ending_actor: { full_name: 'Timeline User' },
      event_id: 'usage-end:22222222-2222-4222-8222-222222222222',
      expected_end_at: '2026-10-30T08:00:00.000Z',
      forced: false,
      holder: { full_name: 'Machine Holder' },
      kind: 'USAGE_ENDED',
      occurred_at: '2026-10-30T08:00:00.000Z',
      overdue_at_end: false,
      purpose: 'Ward round',
      session_id: '22222222-2222-4222-8222-222222222222',
      started_at: '2026-10-30T07:00:00.000Z',
    },
  ],
  machineFound: true,
  total: 1,
  ...overrides,
});

describe(TimelineService.name, () => {
  const rawQuery = jest.fn<(...parameters: unknown[]) => Promise<ReturnType<typeof queryResult>[]>>(
    async () => [queryResult()],
  );
  const service = new TimelineService({ $queryRawUnsafe: rawQuery } as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    rawQuery.mockImplementation(async () => [queryResult()]);
  });

  it('returns a cutoff-stable minimized page in one query', async () => {
    const result = await service.list(actor('STAFF'), '33333333-3333-4333-8333-333333333333', {
      page: 1,
      page_size: 50,
    });
    expect(result).toEqual(
      expect.objectContaining({
        as_of: '2026-10-30T09:00:00.000Z',
        page: 1,
        page_size: 50,
        total: 1,
        until: '2026-10-30T09:00:00.000Z',
      }),
    );
    expect(result.items[0]).not.toHaveProperty('email');
    expect(rawQuery).toHaveBeenCalledTimes(1);
    const sql = String(rawQuery.mock.calls[0]?.[0]);
    expect(sql).toContain('ORDER BY occurred_at DESC, event_rank DESC, immutable_id DESC');
    expect(sql).toContain("audit.action IN ('usage.checked_in', 'usage.force_ended')");
    expect(sql).toContain("audit.after #>> '{context,forced}'");
  });

  it('warns by session ID only when duplicate ending audits exist', async () => {
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    rawQuery.mockResolvedValueOnce([
      queryResult({ duplicateEndingAudits: ['22222222-2222-4222-8222-222222222222'] }),
    ]);

    await service.list(actor('STAFF'), '33333333-3333-4333-8333-333333333333', {
      page: 1,
      page_size: 50,
    });

    expect(warning).toHaveBeenCalledWith(
      'Multiple ending audit rows found for usage session 22222222-2222-4222-8222-222222222222',
    );
    warning.mockRestore();
  });

  it('fails closed before lookup when deleted visibility is not permitted', async () => {
    await expect(
      service.list(actor('STAFF'), '33333333-3333-4333-8333-333333333333', {
        include_deleted: true,
        page: 1,
        page_size: 50,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedException);
    expect(rawQuery).not.toHaveBeenCalled();
  });

  it('allows an administrator to request deleted visibility', async () => {
    await expect(
      service.list(actor('ADMIN'), '33333333-3333-4333-8333-333333333333', {
        include_deleted: true,
        page: 1,
        page_size: 50,
      }),
    ).resolves.toBeDefined();
  });

  it('hides missing and normally hidden machines', async () => {
    rawQuery.mockResolvedValueOnce([queryResult({ machineFound: false })]);
    await expect(
      service.list(actor('STAFF'), '33333333-3333-4333-8333-333333333333', {
        page: 1,
        page_size: 50,
      }),
    ).rejects.toBeInstanceOf(MachineNotFoundException);
  });

  it('rejects a future cutoff using database time', async () => {
    rawQuery.mockResolvedValueOnce([queryResult({ futureUntil: true })]);
    await expect(
      service.list(actor('STAFF'), '33333333-3333-4333-8333-333333333333', {
        page: 1,
        page_size: 50,
        until: '2026-10-31T09:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('strictly validates timeline pagination, cutoff and unknown parameters', () => {
    expect(machineTimelineQuerySchema.parse({ page: '2', page_size: '200' })).toEqual({
      page: 2,
      page_size: 200,
    });
    expect(machineTimelineQuerySchema.safeParse({ page_size: 201 }).success).toBe(false);
    expect(machineTimelineQuerySchema.safeParse({ until: '2026-10-30' }).success).toBe(false);
    expect(machineTimelineQuerySchema.safeParse({ unexpected: 'value' }).success).toBe(false);
  });
});
