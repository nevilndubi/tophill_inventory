import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ManagedLocation, ManagedLocationPage } from '@app/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/auth.types';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { getOrCreateRequestId } from '../common/http/request-id';
import { LocationsService } from './locations.service';
import {
  CreateLocationDto,
  ListLocationsQueryDto,
  LocationIdParamsDto,
  UpdateLocationDto,
} from './reference.dto';

@ApiBearerAuth('supabase')
@ApiTags('locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}
  @Get()
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'List locations' })
  list(@Query() query: ListLocationsQueryDto): Promise<ManagedLocationPage> {
    return this.locations.list(query);
  }
  @Get(':id')
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'Get a location' })
  get(@Param() params: LocationIdParamsDto): Promise<ManagedLocation> {
    return this.locations.read(params.id);
  }
  @Post()
  @RequirePermission('reference:manage')
  @ApiOperation({ summary: 'Create a location' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: CreateLocationDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.locations.create(actor, input, getOrCreateRequestId(request));
  }
  @Patch(':id')
  @RequirePermission('reference:manage')
  @ApiOperation({ summary: 'Update a location' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: LocationIdParamsDto,
    @Body() input: UpdateLocationDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.locations.update(actor, params.id, input, getOrCreateRequestId(request));
  }
  @Delete(':id')
  @RequirePermission('reference:manage')
  @ApiOperation({ summary: 'Delete an unused location' })
  delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: LocationIdParamsDto,
    @Req() request: AuthenticatedRequest,
  ) {
    return this.locations.delete(actor, params.id, getOrCreateRequestId(request));
  }
}
