import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { BookingPolicyController, BookingSettingsController } from './booking.controller';
import { BookingPolicyService } from './booking-policy.service';
import { BookingSettingsService } from './booking-settings.service';

@Module({
  controllers: [BookingPolicyController, BookingSettingsController],
  imports: [AuditModule],
  providers: [BookingPolicyService, BookingSettingsService],
  exports: [BookingPolicyService, BookingSettingsService],
})
export class BookingModule {}
