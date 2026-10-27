import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { AttachmentIntentService } from './attachment-intent.service';
import { AttachmentUploadValidationPipe } from './attachment-upload-validation.pipe';
import { AttachmentsController } from './attachments.controller';
import { AttachmentsService } from './attachments.service';
import { SupabaseStorageService } from './supabase-storage.service';

@Module({
  controllers: [AttachmentsController],
  imports: [AuditModule],
  providers: [
    AttachmentIntentService,
    AttachmentUploadValidationPipe,
    AttachmentsService,
    SupabaseStorageService,
  ],
})
export class AttachmentsModule {}
