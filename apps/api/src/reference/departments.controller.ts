import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { EligibleManager, ManagedDepartmentReference } from '@app/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/auth.types';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { getOrCreateRequestId } from '../common/http/request-id';
import { DepartmentsService } from './departments.service';
import { CreateDepartmentDto, ReferenceIdParamsDto, UpdateDepartmentDto } from './reference.dto';

@ApiBearerAuth('supabase')
@ApiTags('departments')
@Controller('departments')
export class DepartmentsController {
  constructor(private readonly departments: DepartmentsService) {}

  @Get()
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'List departments' })
  list(): Promise<readonly ManagedDepartmentReference[]> {
    return this.departments.read();
  }
  @Get(':id/eligible-managers')
  @RequirePermission('reference:manage')
  @ApiOperation({ summary: 'List eligible department managers' })
  eligible(@Param() params: ReferenceIdParamsDto): Promise<readonly EligibleManager[]> {
    return this.departments.eligibleManagers(params.id);
  }
  @Get(':id')
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'Get a department' })
  get(@Param() params: ReferenceIdParamsDto): Promise<ManagedDepartmentReference> {
    return this.departments.read(params.id);
  }
  @Post()
  @RequirePermission('reference:manage')
  @ApiOperation({ summary: 'Create a department' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: CreateDepartmentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.departments.create(actor, input, getOrCreateRequestId(request));
  }
  @Patch(':id')
  @RequirePermission('reference:manage')
  @ApiOperation({ summary: 'Update a department' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: ReferenceIdParamsDto,
    @Body() input: UpdateDepartmentDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.departments.update(actor, params.id, input, getOrCreateRequestId(request));
  }
  @Delete(':id')
  @RequirePermission('reference:manage')
  @ApiOperation({ summary: 'Delete an unused department' })
  delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: ReferenceIdParamsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.departments.delete(actor, params.id, getOrCreateRequestId(request));
  }
}
