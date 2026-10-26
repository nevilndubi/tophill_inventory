import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ManagedMachine } from '@app/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/auth.types';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { apiResponse, type ApiResponse } from '../common/http/response-envelope';
import { getOrCreateRequestId } from '../common/http/request-id';
import {
  CreateMachineDto,
  ListMachinesQueryDto,
  MachineIdParamsDto,
  UpdateMachineDto,
} from './machines.dto';
import { MachinesService } from './machines.service';

@ApiBearerAuth('supabase')
@ApiTags('machines')
@Controller('machines')
export class MachinesController {
  constructor(private readonly machines: MachinesService) {}

  @Get()
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'List active-registry machines' })
  async list(
    @Query() query: ListMachinesQueryDto,
  ): Promise<ApiResponse<readonly ManagedMachine[]>> {
    const page = await this.machines.list(query);
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

  @Get('by-tag/:assetTag')
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'Find an active-registry machine by asset tag' })
  byTag(@Param('assetTag') assetTag: string): Promise<ManagedMachine> {
    return this.machines.readByAssetTag(assetTag);
  }

  @Get(':id')
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'Get an active-registry machine' })
  get(@Param() params: MachineIdParamsDto): Promise<ManagedMachine> {
    return this.machines.read(params.id);
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
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedMachine> {
    return this.machines.delete(actor, params.id, getOrCreateRequestId(request));
  }
}
