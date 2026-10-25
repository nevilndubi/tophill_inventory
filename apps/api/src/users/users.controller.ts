import { Body, Controller, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { ManagedDepartment, ManagedUser, ManagedUserPage } from '@app/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/auth.types';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { getOrCreateRequestId } from '../common/http/request-id';
import { InviteUserDto, ListUsersQueryDto, UpdateUserDto, UserIdParamsDto } from './users.dto';
import { UsersService } from './users.service';

@ApiBearerAuth('supabase')
@ApiTags('users')
@RequirePermission('user:manage')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'List and search non-seed users' })
  list(@Query() query: ListUsersQueryDto): Promise<ManagedUserPage> {
    return this.users.list(query);
  }

  @Get('departments')
  @ApiOperation({ summary: 'List department choices for user administration' })
  listDepartments(): Promise<readonly ManagedDepartment[]> {
    return this.users.listDepartments();
  }

  @Post()
  @ApiOperation({ summary: 'Invite and provision a user' })
  invite(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: InviteUserDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedUser> {
    return this.users.invite(actor, input, getOrCreateRequestId(request));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a user role, department, or name' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: UserIdParamsDto,
    @Body() input: UpdateUserDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedUser> {
    return this.users.update(actor, params.id, input, getOrCreateRequestId(request));
  }

  @Post(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate a user in the application database' })
  deactivate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: UserIdParamsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedUser> {
    return this.users.setActive(actor, params.id, false, getOrCreateRequestId(request));
  }

  @Post(':id/reactivate')
  @ApiOperation({ summary: 'Reactivate a user in the application database' })
  reactivate(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: UserIdParamsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedUser> {
    return this.users.setActive(actor, params.id, true, getOrCreateRequestId(request));
  }
}
