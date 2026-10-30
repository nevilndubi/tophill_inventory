import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  machineImportCsv,
  MACHINE_IMPORT_TEMPLATE_VERSION,
  type MachineImportReport,
  type MachineLiveStatus,
  type ManagedMachine,
  type MachineConditionHistoryItem,
  type MachineConditionTransitionResult,
} from '@app/shared';
import type { Request, Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/auth.types';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { apiResponse, type ApiResponse } from '../common/http/response-envelope';
import { getOrCreateRequestId } from '../common/http/request-id';
import {
  CreateMachineDto,
  ListMachinesQueryDto,
  MachineDetailQueryDto,
  MachineConditionTransitionDto,
  MachineHistoryQueryDto,
  MachineIdParamsDto,
  MachineImportQueryDto,
  MachineRegistryMutationDto,
  UpdateMachineDto,
} from './machines.dto';
import { MachineImportService } from './machine-import.service';
import { MachinesService } from './machines.service';
import { ConditionService } from './condition.service';
import { CheckInMachineDto, CheckOutMachineDto } from '../usage/usage.dto';
import { UsageService } from '../usage/usage.service';
import { StatusService } from '../status/status.service';

@ApiBearerAuth('supabase')
@ApiTags('machines')
@Controller('machines')
export class MachinesController {
  constructor(
    private readonly machines: MachinesService,
    private readonly imports: MachineImportService,
    private readonly conditions: ConditionService,
    private readonly usage: UsageService,
    private readonly status: StatusService,
  ) {}

  @Get()
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'List active-registry machines' })
  async list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListMachinesQueryDto,
  ): Promise<ApiResponse<readonly ManagedMachine[]>> {
    const page = await this.machines.list(actor, query);
    return apiResponse(page.items, { page: page.page, pageSize: page.pageSize, total: page.total });
  }

  @Post()
  @RequirePermission('machine:create')
  @ApiOperation({
    description:
      'Asset tags are database generated and unique, but sequence rollbacks may leave gaps.',
    summary: 'Register a machine',
  })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: CreateMachineDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedMachine> {
    return this.machines.create(actor, input, getOrCreateRequestId(request));
  }

  @Get('import/template')
  @RequirePermission('machine:create')
  @ApiOperation({ summary: 'Download the versioned machine import template or example' })
  template(@Query('kind') kind: string | undefined, @Res() response: Response): void {
    if (kind !== undefined && kind !== 'template' && kind !== 'example') {
      throw new BadRequestException({
        code: 'IMPORT_INVALID_TEMPLATE_KIND',
        details: {},
        message: 'Template kind must be template or example',
      });
    }
    const selected = kind ?? 'template';
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="machine-import-${selected}-${MACHINE_IMPORT_TEMPLATE_VERSION}.csv"`,
    );
    response.status(200).send(machineImportCsv(selected));
  }

  @Post('import')
  @RequirePermission('machine:create')
  @ApiOperation({ summary: 'Validate or commit a machine CSV import' })
  importCsv(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: MachineImportQueryDto,
    @Req() request: Request & AuthenticatedRequest,
    @Headers('x-import-file-sha256') expectedHash: string | undefined,
  ): Promise<MachineImportReport> {
    return this.imports.execute(
      request,
      actor,
      query.mode,
      getOrCreateRequestId(request),
      expectedHash,
    );
  }

  @Get('by-tag/:assetTag')
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'Find an active-registry machine by asset tag' })
  byTag(@Param('assetTag') assetTag: string): Promise<ManagedMachine> {
    return this.machines.readByAssetTag(assetTag);
  }

  @Post(':id/check-out')
  @RequirePermission('usage:check-in-out')
  @ApiOperation({
    description:
      'Purpose must contain no patient names or identifiers. Check-out applies to all machines; is_bookable governs bookings only.',
    summary: 'Check out a machine',
  })
  checkOut(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: MachineIdParamsDto,
    @Body() input: CheckOutMachineDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.usage.checkOut(actor, params.id, input, getOrCreateRequestId(request));
  }

  @Post(':id/check-in')
  @RequirePermission('usage:check-in-out')
  @ApiOperation({
    description: 'Notes and force-end reasons must contain no patient names or identifiers.',
    summary: 'Check in or explicitly force-end a machine usage session',
  })
  checkIn(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: MachineIdParamsDto,
    @Body() input: CheckInMachineDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.usage.checkIn(actor, params.id, input, getOrCreateRequestId(request));
  }

  @Get(':id/status')
  @RequirePermission('machine:read')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ summary: 'Read the live derived status for an active-registry machine' })
  statusForMachine(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: MachineIdParamsDto,
  ): Promise<MachineLiveStatus> {
    return this.status.get(actor, params.id);
  }

  @Get(':id')
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'Get an active-registry machine' })
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: MachineIdParamsDto,
    @Query() query: MachineDetailQueryDto,
  ): Promise<ManagedMachine> {
    return this.machines.read(actor, params.id, query.include_deleted === true);
  }

  @Get(':id/history')
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'List machine condition history' })
  async history(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: MachineIdParamsDto,
    @Query() query: MachineHistoryQueryDto,
  ): Promise<ApiResponse<readonly MachineConditionHistoryItem[]>> {
    const page = await this.conditions.history(actor, params.id, query);
    return apiResponse(page.items, { page: page.page, pageSize: page.pageSize, total: page.total });
  }

  @Post(':id/condition')
  @RequirePermission('service:manage')
  @ApiOperation({ summary: 'Transition a machine condition' })
  condition(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: MachineIdParamsDto,
    @Body() input: MachineConditionTransitionDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<MachineConditionTransitionResult> {
    return this.conditions.transition(params.id, input.toCondition, {
      actor,
      force: input.force,
      fromCondition: input.fromCondition,
      reason: input.reason,
      requestId: getOrCreateRequestId(request),
      source: 'MANUAL',
    });
  }

  @Patch(':id')
  @RequirePermission('machine:update')
  @ApiOperation({ summary: 'Update editable machine fields' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: MachineIdParamsDto,
    @Body() input: UpdateMachineDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedMachine> {
    return this.machines.update(actor, params.id, input, getOrCreateRequestId(request));
  }

  @Delete(':id')
  @RequirePermission('machine:retire')
  @ApiOperation({ summary: 'Remove a machine from the active registry' })
  delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: MachineIdParamsDto,
    @Body() input: MachineRegistryMutationDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedMachine> {
    return this.machines.delete(actor, params.id, input, getOrCreateRequestId(request));
  }

  @Post(':id/restore')
  @RequirePermission('machine:restore')
  @ApiOperation({ summary: 'Restore a machine to the active registry' })
  restore(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: MachineIdParamsDto,
    @Body() input: MachineRegistryMutationDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedMachine> {
    return this.machines.restore(actor, params.id, input, getOrCreateRequestId(request));
  }
}
