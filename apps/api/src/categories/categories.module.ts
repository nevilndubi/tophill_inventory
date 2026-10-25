import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CategoriesController } from './categories.controller';
import { CategoriesService } from './categories.service';

@Module({
  controllers: [CategoriesController],
  imports: [AuditModule],
  providers: [CategoriesService],
})
export class CategoriesModule {}
