import { spawnSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../apps/api/src/generated/prisma/client';
import { AuditService } from '../apps/api/src/audit/audit.service';
import { MachinesService } from '../apps/api/src/machines/machines.service';
import type { PrismaService } from '../apps/api/src/prisma/prisma.service';
import { createMachineSchema, updateMachineSchema } from '../packages/shared/src';
import {
  createNeonBranchSafely,
  deleteNeonBranchSafely,
  getNeonConnectionStringCaptured,
  type NeonBranch,
} from '../prisma/neon-safe-cli';

type PlanNode = {
  'Index Name'?: string;
  Plans?: PlanNode[];
};
type ExplainRow = { 'QUERY PLAN': Array<{ Plan: PlanNode }> };

const projectId = process.env.NEON_PROJECT_ID?.trim();
if (!projectId) throw new Error('NEON_PROJECT_ID is required');

const hostname = (url: string): string => new URL(url).hostname;
const clientFor = (connectionString: string, max = 20): PrismaClient =>
  new PrismaClient({ adapter: new PrismaPg({ connectionString, max }) });
const runQuietly = (args: string[], environment: NodeJS.ProcessEnv, output = false): string => {
  const result = spawnSync('pnpm', args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 30 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) throw new Error(`pnpm ${args[0] ?? ''} failed safely`);
  return output
    ? result.stdout.trim().replaceAll(/postgres(?:ql)?:\/\/\S+/giu, '[database-url-redacted]')
    : '';
};
const errorCode = (error: unknown): string =>
  typeof error === 'object' &&
  error !== null &&
  'response' in error &&
  typeof error.response === 'object' &&
  error.response !== null &&
  'code' in error.response
    ? String(error.response.code)
    : 'unknown';
const collectIndexes = (node: PlanNode, indexes = new Set<string>()): Set<string> => {
  if (node['Index Name']) indexes.add(node['Index Name']);
  for (const child of node.Plans ?? []) collectIndexes(child, indexes);
  return indexes;
};
const explainIndexes = async (prisma: PrismaClient, query: Prisma.Sql): Promise<string> => {
  const rows = await prisma.$queryRaw<ExplainRow[]>(
    Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`,
  );
  const plan = rows[0]?.['QUERY PLAN'][0]?.Plan;
  if (!plan) throw new Error('EXPLAIN returned no plan');
  const indexes = [...collectIndexes(plan)].sort();
  return indexes.length === 0 ? 'planner-sequential-scan' : indexes.join('+');
};
const proofCounts = async (connectionString: string): Promise<number> => {
  const prisma = clientFor(connectionString, 2);
  try {
    const table = await prisma.$queryRaw<Array<{ name: string | null }>>`
      SELECT to_regclass('public.machines')::text AS name
    `;
    if (!table[0]?.name) return 0;
    return prisma.machine.count({ where: { name: { startsWith: 'Task 3.3' } } });
  } finally {
    await prisma.$disconnect();
  }
};

const main = async (): Promise<void> => {
  let branch: NeonBranch | undefined;
  let prisma: PrismaClient | undefined;
  try {
    const mainPooled = getNeonConnectionStringCaptured(projectId, 'main', true);
    const stagingPooled = getNeonConnectionStringCaptured(projectId, 'staging', true);
    const suffix = new Date()
      .toISOString()
      .replaceAll(/[-:.TZ]/gu, '')
      .slice(0, 12);
    branch = createNeonBranchSafely(
      projectId,
      'main',
      `ephemeral/task-3.3-machines-${suffix}`,
      new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
    );
    console.log(`Disposable Neon branch created (${branch.id}); credentials remained captured.`);
    const pooled = getNeonConnectionStringCaptured(projectId, branch.id, true);
    const direct = getNeonConnectionStringCaptured(projectId, branch.id, false);
    const databaseEnvironment = {
      ...process.env,
      CI: 'false',
      DATABASE_URL: pooled,
      DIRECT_URL: direct,
      INTEGRATION_DATABASE_BRANCH: branch.name,
      INTEGRATION_DATABASE_URL: pooled,
      SEED_ALLOWED_BRANCH: branch.name,
      SEED_ALLOWED_HOST: hostname(pooled),
      SEED_PROTECTED_HOSTS: [hostname(mainPooled), hostname(stagingPooled)].join(','),
    };
    runQuietly(['prisma:migrate:deploy'], databaseEnvironment);
    runQuietly(['db:seed'], databaseEnvironment);
    console.log('Complete migration chain and guarded seed passed on the disposable branch.');

    prisma = clientFor(pooled);
    const prismaService = prisma as unknown as PrismaService;
    const machines = new MachinesService(prismaService, new AuditService());
    const [actorRow, category, department, otherDepartment] = await Promise.all([
      prisma.user.findFirstOrThrow({ where: { role: 'SUPER_ADMIN' } }),
      prisma.machineCategory.findFirstOrThrow({ orderBy: { name: 'asc' } }),
      prisma.department.findFirstOrThrow({ orderBy: { code: 'asc' } }),
      prisma.department.findFirstOrThrow({ orderBy: { code: 'desc' } }),
    ]);
    const location = await prisma.location.findFirstOrThrow({
      where: { departmentId: department.id },
    });
    const crossDepartmentLocation = await prisma.location.findFirstOrThrow({
      where: { departmentId: otherDepartment.id },
    });
    const actor = {
      department: null,
      email: 'redacted',
      fullName: actorRow.fullName,
      id: actorRow.id,
      isActive: true,
      role: 'SUPER_ADMIN' as const,
    };

    const first = await prisma.machine.findFirstOrThrow({
      where: { deletedAt: null },
      orderBy: { assetTag: 'asc' },
    });
    const seededChecks = await Promise.all([
      machines.list(actor, {
        direction: 'asc',
        page: 1,
        pageSize: 10,
        registry: 'active',
        sort: 'asset_tag',
      }),
      machines.list(actor, {
        department_id: first.departmentId,
        direction: 'asc',
        page: 1,
        pageSize: 100,
        registry: 'active',
        sort: 'asset_tag',
      }),
      machines.list(actor, {
        category_id: first.categoryId,
        direction: 'asc',
        page: 1,
        pageSize: 100,
        registry: 'active',
        sort: 'asset_tag',
      }),
      machines.list(actor, {
        location_id: first.locationId,
        direction: 'asc',
        page: 1,
        pageSize: 100,
        registry: 'active',
        sort: 'asset_tag',
      }),
      machines.list(actor, {
        condition: first.condition,
        direction: 'asc',
        page: 1,
        pageSize: 100,
        registry: 'active',
        sort: 'asset_tag',
      }),
      machines.list(actor, {
        direction: 'asc',
        is_bookable: first.isBookable,
        page: 1,
        pageSize: 100,
        registry: 'active',
        sort: 'asset_tag',
      }),
      machines.list(actor, {
        direction: 'asc',
        page: 1,
        pageSize: 100,
        registry: 'active',
        service_due: true,
        sort: 'asset_tag',
      }),
      machines.list(actor, {
        direction: 'asc',
        page: 1,
        pageSize: 10,
        registry: 'active',
        search: first.name,
        sort: 'asset_tag',
      }),
      machines.list(actor, {
        direction: 'asc',
        page: 1,
        pageSize: 10,
        registry: 'active',
        search: first.assetTag,
        sort: 'asset_tag',
      }),
      machines.list(actor, {
        direction: 'asc',
        page: 1,
        pageSize: 10,
        registry: 'active',
        search: first.serialNumber,
        sort: 'asset_tag',
      }),
    ]);
    if (
      seededChecks[0].total < 60 ||
      seededChecks.slice(1, 6).some((page) => !page.items.some((item) => item.id === first.id)) ||
      seededChecks.slice(7).some((page) => !page.items.some((item) => item.id === first.id))
    ) {
      throw new Error('Seeded pagination/filter/search proof failed');
    }
    console.log(
      `Seeded reads: total=${seededChecks[0].total} page_items=${seededChecks[0].items.length} filters=passed search_name_tag_serial=passed service_due=${seededChecks[6].total}.`,
    );

    const createBase = {
      categoryId: category.id,
      departmentId: department.id,
      locationId: location.id,
      manufacturer: 'task 3.3 proof',
      model: 'live',
      name: 'Task 3.3 Concurrent Machine',
    };
    const concurrent = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        machines.create(
          actor,
          { ...createBase, serialNumber: `parallel-${suffix}-${index}` },
          `task-3.3-parallel-${index}`,
        ),
      ),
    );
    const tags = new Set(concurrent.map((machine) => machine.assetTag));
    if (
      tags.size !== concurrent.length ||
      concurrent.some((machine) => machine.assetTag <= 'HM-000060')
    ) {
      throw new Error('Concurrent asset-tag proof failed');
    }
    console.log(
      `Concurrent create proof: attempts=20 successes=${concurrent.length} unique_tags=${tags.size} continued_after_seed=true.`,
    );

    const doubleInput = createMachineSchema.parse({
      ...createBase,
      name: 'Task 3.3 Double Submit',
      serialNumber: `double-${suffix}`,
    });
    const double = await Promise.allSettled([
      machines.create(actor, doubleInput, 'task-3.3-double-a'),
      machines.create(
        actor,
        createMachineSchema.parse({
          ...doubleInput,
          manufacturer: ' TASK   3.3 PROOF ',
          serialNumber: ` DOUBLE-${suffix} `,
        }),
        'task-3.3-double-b',
      ),
    ]);
    const doubleRows = await prisma.machine.count({
      where: { manufacturer: 'task 3.3 proof', serialNumber: `double-${suffix}` },
    });
    const duplicateCode = double
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => errorCode(result.reason));
    if (
      double.filter((result) => result.status === 'fulfilled').length !== 1 ||
      duplicateCode[0] !== 'MACHINE_IDENTITY_TAKEN' ||
      doubleRows !== 1
    ) {
      throw new Error('Idempotent double-submit proof failed');
    }
    console.log(
      `Double-submit proof: rows=${doubleRows} duplicate_code=${duplicateCode[0] ?? 'none'}.`,
    );

    const crossPlaced = await machines.create(
      actor,
      {
        ...createBase,
        locationId: crossDepartmentLocation.id,
        name: 'Task 3.3 Cross Department Placement',
        serialNumber: `cross-${suffix}`,
      },
      'task-3.3-cross-placement',
    );
    if (crossPlaced.department.id === crossDepartmentLocation.departmentId) {
      throw new Error('Cross-department proof did not use independent departments');
    }
    console.log('Cross-department placement: accepted=true.');

    const updated = await machines.update(
      actor,
      crossPlaced.id,
      {
        lastServicedAt: '2026-10-01T06:00:00+03:00',
        name: 'Task 3.3 Cross Department Updated',
        serviceIntervalDays: 90,
      },
      'task-3.3-update',
    );
    if (
      !updated.nextServiceDueAt ||
      updateMachineSchema.safeParse({ condition: 'RETIRED' }).success
    ) {
      throw new Error('Update/service-date/state rejection proof failed');
    }
    const noOpAuditBefore = await prisma.auditLog.count({
      where: { action: 'machine.updated', entityId: crossPlaced.id },
    });
    const beforeNoOp = await prisma.machine.findUniqueOrThrow({ where: { id: crossPlaced.id } });
    await machines.update(actor, crossPlaced.id, { name: updated.name }, 'task-3.3-noop');
    const afterNoOp = await prisma.machine.findUniqueOrThrow({ where: { id: crossPlaced.id } });
    const noOpAuditAfter = await prisma.auditLog.count({
      where: { action: 'machine.updated', entityId: crossPlaced.id },
    });
    console.log(
      `Update proof: changed=200 condition_rejected=true due_recomputed=true noop_timestamp_unchanged=${String(beforeNoOp.updatedAt.getTime() === afterNoOp.updatedAt.getTime())} noop_audit_unchanged=${String(noOpAuditBefore === noOpAuditAfter)}.`,
    );

    const rollbackName = 'Task 3.3 Must Roll Back';
    let rollbackFailed = false;
    try {
      await machines.update(
        { ...actor, id: '99999999-9999-4999-8999-999999999999' },
        crossPlaced.id,
        { name: rollbackName },
        'task-3.3-rollback',
      );
    } catch {
      rollbackFailed = true;
    }
    const rollbackRow = await prisma.machine.findUniqueOrThrow({ where: { id: crossPlaced.id } });
    const rollbackAudits = await prisma.auditLog.count({
      where: { entityId: crossPlaced.id, requestId: 'task-3.3-rollback' },
    });
    if (!rollbackFailed || rollbackRow.name === rollbackName || rollbackAudits !== 0) {
      throw new Error('Audit rollback proof failed');
    }
    console.log('Audit rollback proof: write_rolled_back=true audit_rows=0.');

    const guardMachine = concurrent[0];
    if (!guardMachine) throw new Error('Concurrent fixture was empty');
    await prisma.booking.create({
      data: {
        blockedUntil: new Date('2026-12-01T11:00:00Z'),
        endsAt: new Date('2026-12-01T11:00:00Z'),
        machineId: guardMachine.id,
        purpose: 'Ward round',
        requestedByUserId: actor.id,
        startsAt: new Date('2026-12-01T10:00:00Z'),
        status: 'CONFIRMED',
      },
    });
    let bookingGuard = 'none';
    try {
      await machines.delete(actor, guardMachine.id, {}, 'task-3.3-booking-guard');
    } catch (error: unknown) {
      bookingGuard = errorCode(error);
    }
    const sessionMachine = concurrent[1];
    if (!sessionMachine) throw new Error('Concurrent fixture was incomplete');
    await prisma.usageSession.create({
      data: {
        machineId: sessionMachine.id,
        purpose: 'Pre-op check',
        startedAt: new Date(),
        userId: actor.id,
      },
    });
    let sessionGuard = 'none';
    try {
      await machines.delete(actor, sessionMachine.id, {}, 'task-3.3-session-guard');
    } catch (error: unknown) {
      sessionGuard = errorCode(error);
    }
    if (
      bookingGuard !== 'MACHINE_HAS_ACTIVE_BOOKINGS' ||
      sessionGuard !== 'MACHINE_HAS_OPEN_SESSION'
    ) {
      throw new Error('Soft-delete dependency guards failed');
    }
    console.log(
      `Delete guards: booking_committed_first=${bookingGuard} open_session=${sessionGuard}.`,
    );

    const deletionTarget = concurrent[2];
    if (!deletionTarget) throw new Error('Concurrent fixture was incomplete');
    await Promise.all([
      prisma.attachment.create({
        data: {
          entityId: deletionTarget.id,
          entityType: 'MACHINE',
          fileName: 'registry-proof.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 12,
          storagePath: `machines/${deletionTarget.id}/registry-proof-${suffix}.pdf`,
          uploadedByUserId: actor.id,
        },
      }),
      prisma.booking.create({
        data: {
          blockedUntil: new Date('2026-12-03T11:00:00Z'),
          endsAt: new Date('2026-12-03T11:00:00Z'),
          machineId: deletionTarget.id,
          purpose: 'Ward round',
          requestedByUserId: actor.id,
          startsAt: new Date('2026-12-03T10:00:00Z'),
          status: 'CANCELLED',
        },
      }),
      prisma.serviceTicket.create({
        data: {
          description: 'Registry preservation proof',
          machineId: deletionTarget.id,
          reportedByUserId: actor.id,
          severity: 'LOW',
          status: 'CANCELLED',
          title: 'Registry proof ticket',
          type: 'INSPECTION',
        },
      }),
      prisma.usageSession.create({
        data: {
          endedAt: new Date('2026-10-20T09:00:00Z'),
          machineId: deletionTarget.id,
          purpose: 'Pre-op check',
          startedAt: new Date('2026-10-20T08:00:00Z'),
          userId: actor.id,
        },
      }),
    ]);
    const relatedCounts = () =>
      Promise.all([
        prisma!.attachment.count({ where: { entityId: deletionTarget.id, entityType: 'MACHINE' } }),
        prisma!.booking.count({ where: { machineId: deletionTarget.id } }),
        prisma!.usageSession.count({ where: { machineId: deletionTarget.id } }),
        prisma!.serviceTicket.count({ where: { machineId: deletionTarget.id } }),
        prisma!.machineStatusHistory.count({ where: { machineId: deletionTarget.id } }),
      ]);
    const relationsBefore = await relatedCounts();
    const retainedBefore = await prisma.machine.findUniqueOrThrow({
      where: { id: deletionTarget.id },
    });
    await machines.delete(
      actor,
      deletionTarget.id,
      { reason: 'Registry proof correction' },
      'task-3.8-delete',
    );
    const [hiddenList, deletedList, allList, deletedDetail, retainedAfter, relationsAfterDelete] =
      await Promise.all([
        machines.list(actor, {
          direction: 'asc',
          page: 1,
          pageSize: 100,
          registry: 'active',
          search: deletionTarget.assetTag,
          sort: 'asset_tag',
        }),
        machines.list(actor, {
          direction: 'asc',
          page: 1,
          pageSize: 100,
          registry: 'deleted',
          search: deletionTarget.assetTag,
          sort: 'asset_tag',
        }),
        machines.list(actor, {
          direction: 'asc',
          page: 1,
          pageSize: 100,
          registry: 'all',
          search: deletionTarget.assetTag,
          sort: 'asset_tag',
        }),
        machines.read(actor, deletionTarget.id, true),
        prisma.machine.findUniqueOrThrow({ where: { id: deletionTarget.id } }),
        relatedCounts(),
      ]);
    const hiddenReadCodes: string[] = [];
    for (const operation of [
      () => machines.read(actor, deletionTarget.id),
      () => machines.readByAssetTag(deletionTarget.assetTag),
    ]) {
      try {
        await operation();
      } catch (error: unknown) {
        hiddenReadCodes.push(errorCode(error));
      }
    }
    let reusedIdentity = 'none';
    try {
      await machines.create(
        actor,
        {
          ...createBase,
          name: 'Task 3.3 Reused Identity',
          serialNumber: deletionTarget.serialNumber,
        },
        'task-3.3-reuse',
      );
    } catch (error: unknown) {
      reusedIdentity = errorCode(error);
    }
    if (
      hiddenList.total !== 0 ||
      deletedList.total !== 1 ||
      allList.total !== 1 ||
      deletedDetail.registryStatus !== 'DELETED' ||
      hiddenReadCodes.some((code) => code !== 'MACHINE_NOT_FOUND') ||
      retainedAfter.deletedAt === null ||
      retainedBefore.assetTag !== retainedAfter.assetTag ||
      retainedBefore.serialNumber !== retainedAfter.serialNumber ||
      retainedBefore.condition !== retainedAfter.condition ||
      relationsBefore.some((count, index) => count !== relationsAfterDelete[index]) ||
      reusedIdentity !== 'MACHINE_IDENTITY_TAKEN'
    ) {
      throw new Error('Soft-delete visibility/retention proof failed');
    }
    console.log(
      `Soft delete: active_hidden=true admin_deleted_and_all_visible=true detail_and_tag=${hiddenReadCodes.join('+')} row_retained=true identity_permanent=${reusedIdentity} condition_unchanged=true related_counts=${relationsAfterDelete.join('/')}.`,
    );

    let deniedRegistry = 'none';
    try {
      await machines.list(
        { ...actor, role: 'STAFF' },
        { direction: 'asc', page: 1, pageSize: 25, registry: 'deleted', sort: 'asset_tag' },
      );
    } catch (error: unknown) {
      deniedRegistry = errorCode(error);
    }
    if (deniedRegistry !== 'PERMISSION_DENIED') {
      throw new Error('Deleted-registry permission proof failed');
    }

    let failedRestore = false;
    try {
      await machines.restore(
        { ...actor, id: '99999999-9999-4999-8999-999999999999' },
        deletionTarget.id,
        { reason: 'Must roll back' },
        'task-3.8-restore-rollback',
      );
    } catch {
      failedRestore = true;
    }
    const [afterFailedRestore, failedRestoreAudits] = await Promise.all([
      prisma.machine.findUniqueOrThrow({ where: { id: deletionTarget.id } }),
      prisma.auditLog.count({ where: { requestId: 'task-3.8-restore-rollback' } }),
    ]);
    if (!failedRestore || afterFailedRestore.deletedAt === null || failedRestoreAudits !== 0) {
      throw new Error('Restore audit rollback proof failed');
    }

    const restoreResults = await Promise.allSettled([
      machines.restore(
        actor,
        deletionTarget.id,
        { reason: 'Return to active registry' },
        'task-3.8-restore-a',
      ),
      machines.restore(actor, deletionTarget.id, {}, 'task-3.8-restore-b'),
    ]);
    const restoreFailures = restoreResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => errorCode(result.reason));
    const [restoredRow, restoredRead, restoredByTag, relationsAfterRestore, restoreAudits] =
      await Promise.all([
        prisma.machine.findUniqueOrThrow({ where: { id: deletionTarget.id } }),
        machines.read(actor, deletionTarget.id),
        machines.readByAssetTag(deletionTarget.assetTag),
        relatedCounts(),
        prisma.auditLog.findMany({
          select: { after: true },
          where: { action: 'machine.restored', entityId: deletionTarget.id },
        }),
      ]);
    if (
      restoreResults.filter((result) => result.status === 'fulfilled').length !== 1 ||
      restoreFailures[0] !== 'MACHINE_NOT_DELETED' ||
      restoredRow.deletedAt !== null ||
      restoredRow.condition !== retainedBefore.condition ||
      restoredRead.registryStatus !== 'ACTIVE' ||
      restoredByTag.id !== deletionTarget.id ||
      relationsBefore.some((count, index) => count !== relationsAfterRestore[index]) ||
      restoreAudits.length !== 1
    ) {
      throw new Error('Serialized restore/preservation proof failed');
    }
    console.log(
      `Restore: concurrent_attempts=2 successes=1 conflict=${restoreFailures[0] ?? 'none'} audit_rows=${restoreAudits.length} rollback_audit_rows=${failedRestoreAudits} related_counts_preserved=true QR_lookup_restored=true registry_permission_denied=${deniedRegistry}.`,
    );

    const concurrentDeleteTarget = concurrent[3];
    if (!concurrentDeleteTarget) throw new Error('Concurrent fixture was incomplete');
    const deleteResults = await Promise.allSettled([
      machines.delete(actor, concurrentDeleteTarget.id, {}, 'task-3.8-delete-a'),
      machines.delete(actor, concurrentDeleteTarget.id, {}, 'task-3.8-delete-b'),
    ]);
    const deleteFailures = deleteResults
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => errorCode(result.reason));
    if (
      deleteResults.filter((result) => result.status === 'fulfilled').length !== 1 ||
      deleteFailures[0] !== 'MACHINE_ALREADY_DELETED'
    ) {
      throw new Error('Serialized delete proof failed');
    }
    await machines.restore(actor, concurrentDeleteTarget.id, {}, 'task-3.8-delete-proof-restore');
    console.log(
      `Delete serialization: concurrent_attempts=2 successes=1 conflict=${deleteFailures[0] ?? 'none'}.`,
    );

    await prisma.$executeRaw`
      INSERT INTO machines (
        name, category_id, manufacturer, model, serial_number, department_id, location_id,
        condition, is_bookable, next_service_due_at
      )
      SELECT
        'Task 3.3 Bulk Machine ' || value,
        ${category.id}::uuid,
        'Task 3.3 Bulk Manufacturer',
        'Bulk Model',
        'task33-bulk-' || value,
        ${department.id}::uuid,
        ${location.id}::uuid,
        CASE WHEN value % 5 = 0 THEN 'NEEDS_SERVICE'::machine_condition ELSE 'OPERATIONAL'::machine_condition END,
        value % 4 <> 0,
        CASE WHEN value % 7 = 0 THEN now() - interval '1 day' ELSE now() + interval '30 days' END
      FROM generate_series(1, 3000) value
    `;
    await prisma.$executeRaw`ANALYZE machines`;
    const plans = {
      department: await explainIndexes(
        prisma,
        Prisma.sql`SELECT id FROM machines WHERE deleted_at IS NULL AND department_id = ${department.id}::uuid ORDER BY asset_tag, id LIMIT 25`,
      ),
      filters: await explainIndexes(
        prisma,
        Prisma.sql`SELECT id FROM machines WHERE deleted_at IS NULL AND category_id = ${category.id}::uuid AND condition = 'NEEDS_SERVICE'::machine_condition AND next_service_due_at <= now() ORDER BY id LIMIT 25`,
      ),
      search_name: await explainIndexes(
        prisma,
        Prisma.sql`SELECT id FROM machines WHERE deleted_at IS NULL AND name ILIKE ${'%1777%'}`,
      ),
      search_tag: await explainIndexes(
        prisma,
        Prisma.sql`SELECT id FROM machines WHERE deleted_at IS NULL AND asset_tag ILIKE ${'%003000%'}`,
      ),
      search_serial: await explainIndexes(
        prisma,
        Prisma.sql`SELECT id FROM machines WHERE deleted_at IS NULL AND serial_number ILIKE ${'%1777%'}`,
      ),
    };
    console.log(
      `EXPLAIN 3,000-row fixture: department=${plans.department} filters=${plans.filters} search_name=${plans.search_name} search_tag=${plans.search_tag} search_serial=${plans.search_serial}.`,
    );

    const diff = runQuietly(
      [
        'exec',
        'prisma',
        'migrate',
        'diff',
        '--config',
        'prisma7.config.ts',
        '--from-config-datasource',
        '--to-schema',
        'prisma/schema.prisma',
        '--exit-code',
      ],
      databaseEnvironment,
      true,
    );
    console.log(
      diff.includes('No difference detected')
        ? 'Prisma migrate diff: No difference detected.'
        : 'Prisma migrate diff returned unexpected output.',
    );
  } finally {
    await prisma?.$disconnect();
    if (branch) {
      deleteNeonBranchSafely(projectId, branch.id);
      console.log(`Disposable Neon branch deleted (${branch.id}).`);
    }
    const counts = {
      dev: await proofCounts(getNeonConnectionStringCaptured(projectId, 'dev', true)),
      main: await proofCounts(getNeonConnectionStringCaptured(projectId, 'main', true)),
      staging: await proofCounts(getNeonConnectionStringCaptured(projectId, 'staging', true)),
    };
    console.log(
      `Protected-branch Task 3.3 rows: dev=${counts.dev} staging=${counts.staging} main=${counts.main}.`,
    );
  }
};

void main().catch((error: unknown) => {
  console.error(`[task-3.3-live] ${error instanceof Error ? error.message : 'Unknown failure'}`);
  process.exitCode = 1;
});
