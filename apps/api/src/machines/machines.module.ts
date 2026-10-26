import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { MachinesController } from './machines.controller';
import { MachinesService } from './machines.service';

@Module({
  controllers: [MachinesController],
  imports: [AuditModule],
  providers: [MachinesService],
})
export class MachinesModule {}
