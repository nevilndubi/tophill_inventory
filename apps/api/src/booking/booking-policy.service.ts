import { Injectable } from '@nestjs/common';
import {
  resolveEffectivePolicy,
  type BookingPolicyCategory,
  type BookingPolicyMachine,
  type BookingSettings,
  type EffectiveBookingPolicy,
} from '@app/shared';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BookingMachineNotFoundException } from './booking.errors';
import { BOOKING_SETTING_KEYS, settingsFromRows } from './booking-settings.service';

@Injectable()
export class BookingPolicyService {
  constructor(private readonly prisma: PrismaService) {}

  async get(machineId: string): Promise<EffectiveBookingPolicy> {
    const machine = await this.prisma.machine.findFirst({
      select: {
        allowBookingWhenNeedsService: true,
        bufferMinutes: true,
        category: { select: { defaultMaxBookingMinutes: true } },
        condition: true,
        deletedAt: true,
        isBookable: true,
        maxBookingMinutes: true,
        requiresApproval: true,
      },
      where: { deletedAt: null, id: machineId },
    });
    if (machine === null) throw new BookingMachineNotFoundException();

    const settings = await this.readSettings();
    const policyMachine: BookingPolicyMachine = {
      allowBookingWhenNeedsService: machine.allowBookingWhenNeedsService,
      bufferMinutes: machine.bufferMinutes,
      condition: machine.condition,
      isBookable: machine.isBookable,
      maxBookingMinutes: machine.maxBookingMinutes,
      requiresApproval: machine.requiresApproval,
    };
    return this.resolve(policyMachine, machine.category, settings);
  }

  resolve(
    machine: BookingPolicyMachine,
    category: BookingPolicyCategory,
    settings: BookingSettings,
  ): EffectiveBookingPolicy {
    return resolveEffectivePolicy(machine, category, settings);
  }

  async readSettings(
    client: Pick<Prisma.TransactionClient, 'appSetting'> | PrismaService = this.prisma,
  ): Promise<BookingSettings> {
    const rows = await client.appSetting.findMany({
      select: { key: true, updatedAt: true, value: true },
      where: { key: { in: BOOKING_SETTING_KEYS } },
    });
    return settingsFromRows(rows);
  }
}
