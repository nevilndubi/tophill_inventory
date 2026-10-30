import { jest } from '@jest/globals';
import {
  deriveDisplayStatus,
  DISPLAY_STATUSES,
  DISPLAY_STATUS_METADATA,
  isMachineUsable,
  MACHINE_STATUS_STYLE_NAMES,
  statusBoardQuerySchema,
  type MachineCondition,
} from '@app/shared';
import type { AuthenticatedUser } from '../auth/auth.types';
import type { PrismaService } from '../prisma/prisma.service';
import { StatusService } from './status.service';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const MACHINE_ID = '22222222-2222-4222-8222-222222222222';

const actor = {
  department: null,
  email: 'redacted-for-test',
  fullName: 'Test User',
  id: ACTOR_ID,
  isActive: true,
  role: 'STAFF',
} satisfies AuthenticatedUser;

const queryResult = (overrides: Record<string, unknown> = {}) => ({
  asOf: new Date('2026-10-29T12:00:00.000Z'),
  counts: {
    AVAILABLE_NEEDS_SERVICE: 0,
    AVAILABLE_OK: 0,
    IN_USE: 1,
    OUT_OF_SERVICE: 0,
    RETIRED: 0,
    UNDER_MAINTENANCE: 0,
  },
  items: [
    {
      allow_booking_when_needs_service: false,
      asset_tag: 'HM-000001',
      category: { id: '33333333-3333-4333-8333-333333333333', name: 'Ventilator' },
      department: {
        code: 'ICU',
        id: '44444444-4444-4444-8444-444444444444',
        name: 'Intensive Care',
      },
      display_status: 'IN_USE',
      id: MACHINE_ID,
      location: { id: '55555555-5555-4555-8555-555555555555', name: 'Bay 1' },
      name: 'Ventilator One',
      next_booking_at: '2026-10-29T14:00:00.000Z',
      open_session: {
        expected_end_at: '2026-10-29T11:59:59.999Z',
        holder: { full_name: 'Test User', id: ACTOR_ID },
        id: '66666666-6666-4666-8666-666666666666',
        started_at: '2026-10-29T10:00:00.000Z',
      },
      service_due: true,
      stored_condition: 'OPERATIONAL',
    },
  ],
  total: 1,
  ...overrides,
});

describe('display status contracts', () => {
  it.each([
    ['OPERATIONAL', false, 'AVAILABLE_OK'],
    ['NEEDS_SERVICE', false, 'AVAILABLE_NEEDS_SERVICE'],
    ['OPERATIONAL', true, 'IN_USE'],
    ['NEEDS_SERVICE', true, 'IN_USE'],
    ['UNDER_MAINTENANCE', true, 'UNDER_MAINTENANCE'],
    ['OUT_OF_SERVICE', true, 'OUT_OF_SERVICE'],
    ['RETIRED', true, 'RETIRED'],
  ] as const)('derives %s/open=%s as %s', (condition, open, expected) => {
    expect(deriveDisplayStatus(condition, open)).toBe(expected);
  });

  it('uses every existing status style exactly once', () => {
    expect(DISPLAY_STATUSES.map((status) => DISPLAY_STATUS_METADATA[status].style).sort()).toEqual(
      [...MACHINE_STATUS_STYLE_NAMES].sort(),
    );
  });

  it.each([
    ['OPERATIONAL', false, false, true],
    ['OPERATIONAL', false, true, false],
    ['NEEDS_SERVICE', true, false, true],
    ['NEEDS_SERVICE', false, false, false],
    ['UNDER_MAINTENANCE', true, false, false],
  ] as const)(
    'shares usability for %s/allow=%s/open=%s',
    (condition, allowBookingWhenNeedsService, hasOpenSession, expected) => {
      expect(isMachineUsable({ allowBookingWhenNeedsService, condition, hasOpenSession })).toBe(
        expected,
      );
    },
  );

  it('strictly validates repeatable board filters and bounds', () => {
    expect(
      statusBoardQuerySchema.parse({ status: ['IN_USE', 'RETIRED'], service_due: 'true' }),
    ).toEqual(
      expect.objectContaining({
        page: 1,
        page_size: 50,
        service_due: true,
        status: ['IN_USE', 'RETIRED'],
      }),
    );
    expect(statusBoardQuerySchema.safeParse({ service_due: 'false' }).success).toBe(false);
    expect(statusBoardQuerySchema.safeParse({ q: 'x' }).success).toBe(false);
    expect(statusBoardQuerySchema.safeParse({ page_size: 201 }).success).toBe(false);
    expect(statusBoardQuerySchema.safeParse({ unknown: 'value' }).success).toBe(false);
  });
});

describe(StatusService.name, () => {
  const query = jest.fn<(...parameters: unknown[]) => Promise<ReturnType<typeof queryResult>[]>>(
    async () => [queryResult()],
  );
  const service = new StatusService({ $queryRawUnsafe: query } as unknown as PrismaService);

  beforeEach(() => {
    jest.clearAllMocks();
    query.mockImplementation(async () => [queryResult()]);
  });

  it('returns minimized live data, one clock, holder ownership and overdue state in one query', async () => {
    const result = await service.board(actor, {
      order: 'asc',
      page: 1,
      page_size: 50,
      sort: 'asset_tag',
    });

    expect(query).toHaveBeenCalledTimes(1);
    expect(result.as_of).toBe('2026-10-29T12:00:00.000Z');
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        as_of: result.as_of,
        display_status: 'IN_USE',
        next_booking_at: '2026-10-29T14:00:00.000Z',
        open_session: expect.objectContaining({
          held_by_current_user: true,
          overdue: true,
        }),
        service_due: true,
        usable: false,
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(/email|supabase|seed|allow_booking/i);
  });

  it('uses the same query builder and DTO mapping for detail and board', async () => {
    const detail = await service.get(actor, MACHINE_ID);
    const board = await service.board(actor, {
      order: 'asc',
      page: 1,
      page_size: 50,
      sort: 'asset_tag',
    });
    expect(detail).toEqual(board.items[0]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).toContain('LEFT JOIN LATERAL');
    expect(String(query.mock.calls[0]?.[0])).toContain('m.deleted_at IS NULL');
  });

  it('parameterizes filters/search/status and keeps counts outside the status filter', async () => {
    await service.board(actor, {
      category_id: '33333333-3333-4333-8333-333333333333',
      department_id: '44444444-4444-4444-8444-444444444444',
      location_id: '55555555-5555-4555-8555-555555555555',
      order: 'desc',
      page: 2,
      page_size: 20,
      q: '100%_safe',
      service_due: true,
      sort: 'status',
      status: ['IN_USE', 'RETIRED'],
    });

    const [sql, ...parameters] = query.mock.calls[0] ?? [];
    expect(String(sql)).toContain('SELECT * FROM base WHERE');
    expect(String(sql)).toContain('COUNT(*) FILTER');
    expect(String(sql)).toContain('status_rank DESC');
    expect(parameters).toContain('%100\\%\\_safe%');
    expect(parameters).toContain('IN_USE');
    expect(parameters).toContain('RETIRED');
  });

  it.each([
    ['RETIRED', false],
    ['OUT_OF_SERVICE', true],
  ] as const)('returns the database service-due decision for %s', async (condition, expected) => {
    const row = queryResult().items[0]!;
    query.mockResolvedValueOnce([
      queryResult({
        items: [{ ...row, service_due: expected, stored_condition: condition as MachineCondition }],
      }),
    ]);
    const result = await service.get(actor, MACHINE_ID);
    expect(result.service_due).toBe(expected);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "m.condition <> 'RETIRED'::machine_condition",
    );
  });

  it('returns MACHINE_NOT_FOUND for missing or soft-deleted machines', async () => {
    query.mockResolvedValueOnce([queryResult({ counts: {}, items: [], total: 0 })]);
    await expect(service.get(actor, MACHINE_ID)).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'MACHINE_NOT_FOUND' }),
    });
  });
});
