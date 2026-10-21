import { createHash } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  BookingStatus,
  MachineCondition,
  MachineStatusSource,
  PrismaClient,
  Role,
  ServiceTicketSeverity,
  ServiceTicketStatus,
  ServiceTicketType,
} from '../apps/api/src/generated/prisma/client';
import { assertSafeSeedEnvironment } from './seed-safety';

const uuid = (key: string): string => {
  const digits = createHash('sha256')
    .update(`tophill-seed-v1:${key}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  digits[12] = '5';
  digits[16] = ['8', '9', 'a', 'b'][Number.parseInt(digits[16] ?? '0', 16) % 4] ?? '8';
  const value = digits.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};

const plusMinutes = (date: Date, minutes: number): Date =>
  new Date(date.getTime() + minutes * 60_000);
const plusDays = (date: Date, days: number): Date => plusMinutes(date, days * 1_440);

const departments = [
  [
    'CAS',
    'Casualty',
    ['Resuscitation Bay', 'Observation Ward', 'Procedure Room', 'Equipment Store'],
  ],
  ['ICU', 'Intensive Care Unit', ['ICU Bay 1', 'ICU Bay 2', 'High Dependency Unit', 'ICU Store']],
  ['MAT', 'Maternity', ['Labour Ward', 'Postnatal Ward', 'Newborn Unit', 'Maternity Theatre']],
  ['RAD', 'Radiology', ['X-Ray Room 1', 'Ultrasound Room', 'Reporting Room', 'Radiology Store']],
  [
    'THR',
    'Theatre and Anaesthesia',
    ['Main Theatre 1', 'Main Theatre 2', 'Recovery Bay', 'Theatre Store'],
  ],
] as const;

const categories = [
  ['Ventilator', 'Dräger', 'Savina 300', 180],
  ['Infusion Pump', 'B. Braun', 'Infusomat Space', 180],
  ['Patient Monitor', 'Mindray', 'BeneVision N12', 180],
  ['Ultrasound', 'GE Healthcare', 'LOGIQ e', 365],
  ['X-Ray', 'Siemens Healthineers', 'MOBILETT Elara Max', 365],
  ['Defibrillator', 'ZOLL', 'R Series', 180],
  ['ECG', 'Edan', 'SE-1201', 365],
  ['Dialysis', 'Fresenius Medical Care', '4008S', 180],
] as const;

const roles = [
  Role.SUPER_ADMIN,
  Role.ADMIN,
  Role.BIOMED_TECH,
  Role.DEPT_MANAGER,
  Role.STAFF,
  Role.VIEWER,
] as const;

const conditionFor = (number: number): MachineCondition => {
  if (number <= 45) return MachineCondition.OPERATIONAL;
  if (number <= 51) return MachineCondition.NEEDS_SERVICE;
  if (number <= 56) return MachineCondition.UNDER_MAINTENANCE;
  if (number <= 58) return MachineCondition.OUT_OF_SERVICE;
  return MachineCondition.RETIRED;
};

const main = async (): Promise<void> => {
  const target = assertSafeSeedEnvironment(process.env);
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: target.url, max: 4 }),
  });
  const now = new Date();
  now.setUTCSeconds(0, 0);

  try {
    await prisma.$connect();
    await prisma.$transaction(
      async (tx) => {
        for (const [code, name, locations] of departments) {
          const departmentId = uuid(`department:${code}`);
          await tx.department.upsert({
            create: { code, id: departmentId, name },
            update: { name },
            where: { id: departmentId },
          });
          for (const [index, locationName] of locations.entries()) {
            const id = uuid(`location:${code}:${locationName}`);
            const data = {
              building: code === 'RAD' ? 'Diagnostics Block' : 'Main Hospital',
              floor: String(Math.floor(index / 2) + 1),
              name: locationName,
              room: `${code}-${index + 1}`,
            };
            await tx.location.upsert({
              create: { ...data, departmentId, id },
              update: data,
              where: { id },
            });
          }
        }

        for (const [index, role] of roles.entries()) {
          const id = uuid(`user:${role}`);
          const [departmentCode] = departments[index % departments.length]!;
          const displayRole = role
            .split('_')
            .map((part) => `${part[0]}${part.slice(1).toLowerCase()}`)
            .join(' ');
          const data = {
            departmentId: uuid(`department:${departmentCode}`),
            fullName: `Seed ${displayRole}`,
            isActive: true,
            isSeedData: true,
            role,
            supabaseUserId: null,
          };
          await tx.user.upsert({
            create: {
              ...data,
              email: `${role.toLowerCase().replaceAll('_', '-')}@example.invalid`,
              id,
            },
            update: data,
            where: { id },
          });
        }
        await tx.department.update({
          data: { managerUserId: uuid(`user:${Role.DEPT_MANAGER}`) },
          where: { id: uuid('department:MAT') },
        });

        for (const [name, _manufacturer, _model, interval] of categories) {
          const id = uuid(`category:${name}`);
          const data = {
            defaultMaxBookingMinutes: 240,
            defaultServiceIntervalDays: interval,
            description: `${name} equipment for clinical care`,
            name,
          };
          await tx.machineCategory.upsert({
            create: { ...data, id },
            update: data,
            where: { id },
          });
        }

        for (let number = 1; number <= 60; number += 1) {
          const [categoryName, manufacturer, model] = categories[(number - 1) % categories.length]!;
          const [departmentCode, departmentName, locations] =
            departments[(number - 1) % departments.length]!;
          const locationName = locations[(number - 1) % locations.length];
          const condition = conditionFor(number);
          const commissionedOn = plusDays(now, -(365 + number * 9));
          const id = uuid(`machine:${number}`);
          const data = {
            allowBookingWhenNeedsService: number === 46,
            assetTag: `HM-${String(number).padStart(6, '0')}`,
            bufferMinutes: number % 3 === 0 ? 15 : null,
            categoryId: uuid(`category:${categoryName}`),
            commissionedOn,
            condition,
            departmentId: uuid(`department:${departmentCode}`),
            description: `${categoryName} assigned to ${departmentName}; demonstration data only.`,
            isBookable: condition === MachineCondition.OPERATIONAL,
            lastServicedAt: plusDays(now, -(30 + number)),
            locationId: uuid(`location:${departmentCode}:${locationName}`),
            manufacturer,
            maxBookingMinutes: number % 4 === 0 ? 180 : null,
            model: `${model} ${1 + (number % 3)}`,
            name: `${departmentCode} ${categoryName} ${String(number).padStart(2, '0')}`,
            nextServiceDueAt: number === 20 ? plusDays(now, -7) : plusDays(now, 60 + number),
            purchaseDate: plusDays(commissionedOn, -30),
            requiresApproval: number % 5 === 0,
            retiredOn: condition === MachineCondition.RETIRED ? plusDays(now, -90) : null,
            serialNumber: `ke-${categoryName.toLowerCase().replaceAll(' ', '-')}-${String(number).padStart(5, '0')}`,
            serviceIntervalDays: number % 7 === 0 ? 90 : null,
            warrantyExpiresOn: number === 12 ? plusDays(now, 21) : plusDays(commissionedOn, 730),
          };
          await tx.machine.upsert({ create: { ...data, id }, update: data, where: { id } });
        }

        const bookingDefinitions = [
          [1, -60, 60, BookingStatus.IN_PROGRESS],
          [2, -45, 75, BookingStatus.IN_PROGRESS],
          [3, -30, 90, BookingStatus.IN_PROGRESS],
          [10, 30, 150, BookingStatus.CONFIRMED],
          [11, 40, 160, BookingStatus.CONFIRMED],
          [12, 50, 170, BookingStatus.CONFIRMED],
          [13, 1_440, 1_560, BookingStatus.CONFIRMED],
          [14, 1_680, 1_800, BookingStatus.PENDING],
          [15, -1_440, -1_320, BookingStatus.COMPLETED],
          [13, 1_440, 1_560, BookingStatus.CANCELLED],
          [16, 1_920, 2_040, BookingStatus.REJECTED],
          [17, -2_880, -2_760, BookingStatus.NO_SHOW],
        ] as const;
        for (const [index, [machine, start, end, status]] of bookingDefinitions.entries()) {
          const id = uuid(`booking:${index + 1}`);
          const endsAt = plusMinutes(now, end);
          const data = {
            approvedByUserId:
              status === BookingStatus.PENDING ? null : uuid(`user:${Role.DEPT_MANAGER}`),
            blockedUntil: plusMinutes(endsAt, machine % 3 === 0 ? 15 : 0),
            cancelledReason: status === BookingStatus.CANCELLED ? 'Schedule changed' : null,
            decisionNote:
              status === BookingStatus.REJECTED ? 'Alternative equipment available' : null,
            endsAt,
            machineId: uuid(`machine:${machine}`),
            purpose: index % 2 === 0 ? 'Ward round' : 'Pre-op check',
            requestedByUserId: uuid(`user:${roles[index % roles.length]}`),
            startsAt: plusMinutes(now, start),
            status,
          };
          await tx.booking.upsert({ create: { ...data, id }, update: data, where: { id } });
        }

        for (let machine = 1; machine <= 9; machine += 1) {
          const id = uuid(`usage:open:${machine}`);
          const startedAt = plusMinutes(now, machine === 9 ? -240 : -45 - machine * 5);
          const data = {
            bookingId: machine <= 3 ? uuid(`booking:${machine}`) : null,
            endedAt: null,
            endNote: null,
            expectedEndAt: machine === 9 ? plusMinutes(now, -60) : plusMinutes(now, 90),
            machineId: uuid(`machine:${machine}`),
            purpose: machine % 2 === 0 ? 'Ward round' : 'Pre-op check',
            startedAt,
            userId: uuid(`user:${roles[machine % roles.length]}`),
          };
          await tx.usageSession.upsert({ create: { ...data, id }, update: data, where: { id } });
        }
        for (let machine = 20; machine <= 24; machine += 1) {
          const id = uuid(`usage:closed:${machine}`);
          const startedAt = plusDays(now, -machine);
          const data = {
            bookingId: null,
            endedAt: plusMinutes(startedAt, 90),
            endNote: 'Returned after routine use',
            expectedEndAt: plusMinutes(startedAt, 120),
            machineId: uuid(`machine:${machine}`),
            purpose: 'Ward round',
            startedAt,
            userId: uuid(`user:${Role.STAFF}`),
          };
          await tx.usageSession.upsert({ create: { ...data, id }, update: data, where: { id } });
        }

        for (let machine = 46; machine <= 60; machine += 1) {
          const condition = conditionFor(machine);
          const status =
            condition === MachineCondition.UNDER_MAINTENANCE
              ? ServiceTicketStatus.IN_PROGRESS
              : condition === MachineCondition.OUT_OF_SERVICE
                ? ServiceTicketStatus.ASSIGNED
                : ServiceTicketStatus.OPEN;
          const ticketId = uuid(`ticket:condition:${machine}`);
          const openedAt = plusDays(now, -(machine - 43));
          const ticket = {
            assignedToUserId:
              status === ServiceTicketStatus.OPEN ? null : uuid(`user:${Role.BIOMED_TECH}`),
            description: `Demonstration ${condition.toLowerCase().replaceAll('_', ' ')} ticket; no patient data.`,
            machineBackInServiceAt: null,
            machineId: uuid(`machine:${machine}`),
            machineOutOfServiceFrom:
              condition === MachineCondition.OUT_OF_SERVICE ? openedAt : null,
            openedAt,
            reportedByUserId: uuid(`user:${Role.STAFF}`),
            severity:
              condition === MachineCondition.OUT_OF_SERVICE
                ? ServiceTicketSeverity.CRITICAL
                : condition === MachineCondition.UNDER_MAINTENANCE
                  ? ServiceTicketSeverity.HIGH
                  : ServiceTicketSeverity.MEDIUM,
            status,
            title: `${condition.toLowerCase().replaceAll('_', ' ')} follow-up`,
            type:
              condition === MachineCondition.UNDER_MAINTENANCE
                ? ServiceTicketType.PREVENTIVE
                : ServiceTicketType.FAULT,
          };
          await tx.serviceTicket.upsert({
            create: { ...ticket, id: ticketId },
            update: ticket,
            where: { id: ticketId },
          });
          const historyId = uuid(`history:condition:${machine}`);
          const history = {
            changedByUserId: uuid(`user:${Role.ADMIN}`),
            fromCondition: MachineCondition.OPERATIONAL,
            machineId: uuid(`machine:${machine}`),
            reason: 'Seeded demonstration condition history',
            source: MachineStatusSource.SERVICE_TICKET,
            ticketId,
            toCondition: condition,
          };
          await tx.machineStatusHistory.upsert({
            create: { ...history, id: historyId },
            update: history,
            where: { id: historyId },
          });
          if (
            condition === MachineCondition.UNDER_MAINTENANCE ||
            condition === MachineCondition.OUT_OF_SERVICE
          ) {
            const id = uuid(`service-record:${machine}`);
            const performedAt = plusDays(now, -1);
            const record = {
              costAmount: 25_000 + machine * 1_000,
              currency: 'KES',
              nextDueAt: plusDays(performedAt, 180),
              partsReplaced: machine % 2 === 0 ? 'Battery pack' : null,
              performedAt,
              performedByUserId: uuid(`user:${Role.BIOMED_TECH}`),
              ticketId,
              vendorName: 'Hospital Biomedical Unit',
              workDone: 'Inspection, functional test and preventive servicing',
            };
            await tx.serviceRecord.upsert({
              create: { ...record, id },
              update: record,
              where: { id },
            });
          }
        }

        for (let machine = 1; machine <= 25; machine += 1) {
          const id = uuid(`maintenance:${machine}`);
          const schedule = {
            intervalDays: 180,
            isActive: true,
            lastDoneAt: plusDays(now, -120),
            machineId: uuid(`machine:${machine}`),
            nextDueAt: machine === 20 ? plusDays(now, -7) : plusDays(now, 60),
          };
          await tx.maintenanceSchedule.upsert({
            create: { ...schedule, id },
            update: schedule,
            where: { id },
          });
        }

        await tx.$queryRaw`
          SELECT setval(
            'machine_asset_tag_seq',
            GREATEST(
              (SELECT last_value FROM machine_asset_tag_seq),
              COALESCE((SELECT MAX(substring(asset_tag FROM '^HM-([0-9]+)$')::bigint)
                        FROM machines WHERE asset_tag ~ '^HM-[0-9]+$'), 1)
            ),
            true
          )
        `;
      },
      { maxWait: 10_000, timeout: 120_000 },
    );

    const [departmentCount, locationCount, categoryCount, machineCount, userCount] =
      await Promise.all([
        prisma.department.count({
          where: { id: { in: departments.map(([code]) => uuid(`department:${code}`)) } },
        }),
        prisma.location.count({
          where: {
            id: {
              in: departments.flatMap(([code, , locations]) =>
                locations.map((name) => uuid(`location:${code}:${name}`)),
              ),
            },
          },
        }),
        prisma.machineCategory.count({
          where: { id: { in: categories.map(([name]) => uuid(`category:${name}`)) } },
        }),
        prisma.machine.count({
          where: {
            id: { in: Array.from({ length: 60 }, (_, index) => uuid(`machine:${index + 1}`)) },
          },
        }),
        prisma.user.count({ where: { isSeedData: true } }),
      ]);
    console.log(
      `Seed complete on approved branch ${target.branch}: ${departmentCount} departments, ${locationCount} locations, ${categoryCount} categories, ${machineCount} machines, ${userCount} placeholder users.`,
    );
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown seed failure';
  console.error(
    `Seed failed: ${message.replaceAll(/postgres(?:ql)?:\/\/\S+/gi, '[database-url-redacted]')}`,
  );
  process.exitCode = 1;
});
