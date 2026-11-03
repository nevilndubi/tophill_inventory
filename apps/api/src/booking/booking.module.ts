import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import {
  AvailabilityController,
  BookingPolicyController,
  BookingSettingsController,
} from './booking.controller';
import { BookingPolicyService } from './booking-policy.service';
import { BookingSettingsService } from './booking-settings.service';
import { AvailabilityService } from './availability.service';

@Module({
  controllers: [AvailabilityController, BookingPolicyController, BookingSettingsController],
  imports: [AuditModule],
  providers: [AvailabilityService, BookingPolicyService, BookingSettingsService],
  exports: [AvailabilityService, BookingPolicyService, BookingSettingsService],
})
export class BookingModule {}
