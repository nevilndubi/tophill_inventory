import { Controller, Get, Param } from '@nestjs/common';
import { getPermissionScope } from '@app/shared';
import { CurrentUser } from '../src/auth/current-user.decorator';
import { Public } from '../src/auth/public.decorator';
import type { AuthenticatedUser } from '../src/auth/auth.types';
import { AuthenticatedOnly } from '../src/authorization/authenticated-only.decorator';
import { assertDepartmentAccess } from '../src/authorization/department-scope';
import { RequirePermission } from '../src/authorization/require-permission.decorator';

export const RBAC_TEST_ONLY_MARKER = 'RBAC_TEST_ONLY_CONTROLLER';

@Controller('rbac-test-only')
export class RbacTestOnlyController {
  @Get('global')
  @RequirePermission('machine:create')
  getGlobalPermission(): { allowed: true } {
    return { allowed: true };
  }

  @Get('department/:departmentId')
  @RequirePermission('booking:approve')
  getDepartmentPermission(
    @CurrentUser() user: AuthenticatedUser,
    @Param('departmentId') departmentId: string,
  ): { allowed: true } {
    if (getPermissionScope(user.role, 'booking:approve') === 'OWN_DEPARTMENT') {
      assertDepartmentAccess(user, departmentId);
    }

    return { allowed: true };
  }

  @Get('authenticated')
  @AuthenticatedOnly()
  getAuthenticatedOnly(): { allowed: true } {
    return { allowed: true };
  }

  @Get('public')
  @Public()
  getPublic(): { public: true } {
    return { public: true };
  }
}
