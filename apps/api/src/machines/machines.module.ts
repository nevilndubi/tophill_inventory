import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MachinesController } from './machines.controller';
import { MachineImportService } from './machine-import.service';
import { MachinesService } from './machines.service';
import { ConditionEventsService } from './condition-events.service';
import { ConditionService } from './condition.service';

@Module({
  controllers: [MachinesController],
  imports: [AuditModule],
  providers: [ConditionEventsService, ConditionService, MachineImportService, MachinesService],
  exports: [ConditionService],
})
export class MachinesModule {}
