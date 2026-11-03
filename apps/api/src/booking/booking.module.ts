import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import {
  AvailabilityController,
  BookingController,
  BookingPolicyController,
  BookingSettingsController,
} from './booking.controller';
import { BookingPolicyService } from './booking-policy.service';
import { BookingSettingsService } from './booking-settings.service';
import { AvailabilityService } from './availability.service';
import { BookingService } from './booking.service';

@Module({
  controllers: [
    AvailabilityController,
    BookingController,
    BookingPolicyController,
    BookingSettingsController,
  ],
  imports: [AuditModule],
  providers: [AvailabilityService, BookingPolicyService, BookingService, BookingSettingsService],
  exports: [AvailabilityService, BookingPolicyService, BookingService, BookingSettingsService],
})
export class BookingModule {}
