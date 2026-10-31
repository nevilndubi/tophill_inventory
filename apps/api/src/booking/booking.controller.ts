import { Body, Controller, Get, Header, Param, Patch, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { BookingSettings } from '@app/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/auth.types';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { getOrCreateRequestId } from '../common/http/request-id';
import { BookingPolicyService } from './booking-policy.service';
import { BookingSettingsService } from './booking-settings.service';
import { MachineIdParamsDto } from '../machines/machines.dto';
import { UpdateBookingSettingsDto } from './booking-settings.dto';

@ApiBearerAuth('supabase')
@ApiTags('booking policy')
@Controller('machines')
export class BookingPolicyController {
  constructor(private readonly policy: BookingPolicyService) {}

  @Get(':id/booking-policy')
  @RequirePermission('machine:read')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ summary: 'Read the effective booking policy for a machine' })
  get(@Param() params: MachineIdParamsDto) {
    return this.policy.get(params.id);
  }
}

@ApiBearerAuth('supabase')
@ApiTags('settings')
@Controller('settings/booking')
export class BookingSettingsController {
  constructor(private readonly settings: BookingSettingsService) {}

  @Get()
  @RequirePermission('machine:read')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ summary: 'Read global booking and check-out settings' })
  get(): Promise<BookingSettings> {
    return this.settings.read();
  }

  @Patch()
  @RequirePermission('reference:manage')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ summary: 'Update global booking and check-out settings' })
  patch(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: UpdateBookingSettingsDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<BookingSettings> {
    return this.settings.update(actor, input, getOrCreateRequestId(request));
  }
}
