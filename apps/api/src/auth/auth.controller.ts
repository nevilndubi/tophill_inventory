import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from './current-user.decorator';
import type { AuthenticatedUser } from './auth.types';

@ApiBearerAuth('supabase')
@ApiTags('auth')
@Controller('me')
export class AuthController {
  @Get()
  @ApiOperation({ summary: 'Get the authenticated local user' })
  @ApiOkResponse({ description: 'The authenticated local user and department.' })
  getMe(@CurrentUser() user: AuthenticatedUser): AuthenticatedUser {
    return user;
  }
}
