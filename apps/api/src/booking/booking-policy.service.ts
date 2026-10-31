import { Injectable } from '@nestjs/common';
import {
  resolveEffectivePolicy,
  type BookingPolicyMachine,
  type EffectiveBookingPolicy,
} from '@app/shared';
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

    const settingRows = await this.prisma.appSetting.findMany({
      select: { key: true, updatedAt: true, value: true },
      where: { key: { in: BOOKING_SETTING_KEYS } },
    });
    const settings = settingsFromRows(settingRows);
    const policyMachine: BookingPolicyMachine = {
      allowBookingWhenNeedsService: machine.allowBookingWhenNeedsService,
      bufferMinutes: machine.bufferMinutes,
      condition: machine.condition,
      isBookable: machine.isBookable,
      maxBookingMinutes: machine.maxBookingMinutes,
      requiresApproval: machine.requiresApproval,
    };
    return resolveEffectivePolicy(policyMachine, machine.category, settings);
  }
}
