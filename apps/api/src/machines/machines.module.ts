import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MachinesController } from './machines.controller';
import { MachineImportService } from './machine-import.service';
import { MachinesService } from './machines.service';

@Module({
  controllers: [MachinesController],
  imports: [AuditModule],
  providers: [MachineImportService, MachinesService],
})
export class MachinesModule {}
