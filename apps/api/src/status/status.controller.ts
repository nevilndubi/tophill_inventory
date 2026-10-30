import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { MachineStatusBoard } from '@app/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { StatusBoardQueryDto } from './status.dto';
import { StatusService } from './status.service';

@ApiBearerAuth('supabase')
@ApiTags('status')
@Controller('status')
export class StatusController {
  constructor(private readonly status: StatusService) {}

  @Get('board')
  @RequirePermission('machine:read')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ summary: 'Read the live active-registry machine status board' })
  board(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: StatusBoardQueryDto,
  ): Promise<MachineStatusBoard> {
    return this.status.board(actor, query);
  }
}
