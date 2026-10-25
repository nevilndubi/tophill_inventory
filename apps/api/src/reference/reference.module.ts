import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { DepartmentsController } from './departments.controller';
import { DepartmentsService } from './departments.service';
import { LocationsController } from './locations.controller';
import { LocationsService } from './locations.service';

@Module({
  controllers: [DepartmentsController, LocationsController],
  imports: [AuditModule],
  providers: [DepartmentsService, LocationsService],
})
export class ReferenceModule {}
