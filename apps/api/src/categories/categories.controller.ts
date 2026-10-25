import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ManagedCategory } from '@app/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/auth.types';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { getOrCreateRequestId } from '../common/http/request-id';
import { CategoriesService } from './categories.service';
import { CategoryIdParamsDto, CreateCategoryDto, UpdateCategoryDto } from './categories.dto';

@ApiBearerAuth('supabase')
@ApiTags('categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'List machine categories' })
  list(): Promise<readonly ManagedCategory[]> {
    return this.categories.read();
  }

  @Get(':id')
  @RequirePermission('machine:read')
  @ApiOperation({ summary: 'Get a machine category' })
  get(@Param() params: CategoryIdParamsDto): Promise<ManagedCategory> {
    return this.categories.read(params.id);
  }

  @Post()
  @RequirePermission('reference:manage')
  @ApiOperation({ summary: 'Create a machine category' })
  create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: CreateCategoryDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedCategory> {
    return this.categories.create(actor, input, getOrCreateRequestId(request));
  }

  @Patch(':id')
  @RequirePermission('reference:manage')
  @ApiOperation({ summary: 'Update a machine category' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: CategoryIdParamsDto,
    @Body() input: UpdateCategoryDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedCategory> {
    return this.categories.update(actor, params.id, input, getOrCreateRequestId(request));
  }

  @Delete(':id')
  @RequirePermission('reference:manage')
  @ApiOperation({ summary: 'Delete an unused machine category' })
  delete(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: CategoryIdParamsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedCategory> {
    return this.categories.delete(actor, params.id, getOrCreateRequestId(request));
  }
}
