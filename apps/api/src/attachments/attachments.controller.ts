import { Body, Controller, Delete, Get, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  ManagedMachineAttachment,
  RequestAttachmentUploadInput,
  SignedAttachmentDownload,
  SignedAttachmentUpload,
} from '@app/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/auth.types';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { getOrCreateRequestId } from '../common/http/request-id';
import {
  AttachmentIdParamsDto,
  ConfirmAttachmentUploadDto,
  MachineAttachmentParamsDto,
} from './attachments.dto';
import { AttachmentUploadValidationPipe } from './attachment-upload-validation.pipe';
import { AttachmentsService } from './attachments.service';

@ApiBearerAuth('supabase')
@ApiTags('attachments')
@Controller()
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  @Get('machines/:machineId/attachments')
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'List machine attachment metadata' })
  list(@Param() params: MachineAttachmentParamsDto): Promise<readonly ManagedMachineAttachment[]> {
    return this.attachments.list(params.machineId);
  }

  @Post('machines/:machineId/attachments/sign-upload')
  @RequirePermission('attachment:upload')
  @ApiOperation({ summary: 'Issue a signed machine-attachment upload' })
  requestUpload(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: MachineAttachmentParamsDto,
    @Body(AttachmentUploadValidationPipe) input: RequestAttachmentUploadInput,
  ): Promise<SignedAttachmentUpload> {
    return this.attachments.requestUpload(actor, params.machineId, input);
  }

  @Post('attachments/confirm')
  @RequirePermission('attachment:upload')
  @ApiOperation({ summary: 'Verify and confirm a machine attachment upload' })
  confirm(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: ConfirmAttachmentUploadDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedMachineAttachment> {
    return this.attachments.confirm(actor, input, getOrCreateRequestId(request));
  }

  @Get('attachments/:id/url')
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'Issue a five-minute attachment download URL' })
  download(@Param() params: AttachmentIdParamsDto): Promise<SignedAttachmentDownload> {
    return this.attachments.download(params.id);
  }

  @Delete('attachments/:id')
  @RequirePermission('attachment:upload')
  @ApiOperation({ summary: 'Delete a machine attachment' })
  delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: AttachmentIdParamsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedMachineAttachment> {
    return this.attachments.delete(actor, params.id, getOrCreateRequestId(request));
  }
}
