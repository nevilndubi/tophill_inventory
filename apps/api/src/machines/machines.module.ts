import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MachinesController } from './machines.controller';
import { MachineImportService } from './machine-import.service';
import { MachinesService } from './machines.service';
import { ConditionEventsService } from './condition-events.service';
import { ConditionService } from './condition.service';
import { UsageClockService } from '../usage/usage-clock.service';
import { UsageEventsService } from '../usage/usage-events.service';
import { UsageService } from '../usage/usage.service';
import { StatusModule } from '../status/status.module';
import { TimelineService } from './timeline.service';

@Module({
  controllers: [MachinesController],
  imports: [AuditModule, StatusModule],
  providers: [
    ConditionEventsService,
    ConditionService,
    MachineImportService,
    MachinesService,
    TimelineService,
    UsageClockService,
    UsageEventsService,
    UsageService,
  ],
  exports: [ConditionService, UsageEventsService, UsageService],
})
export class MachinesModule {}
