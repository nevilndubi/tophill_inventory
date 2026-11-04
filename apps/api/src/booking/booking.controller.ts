import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  AvailabilitySearchResult,
  BookingSettings,
  MachineAvailability,
  ManagedBooking,
  ManagedBookingPage,
} from '@app/shared';
import type { CreatedBooking } from '@app/shared';
import type { Response } from 'express';
import { CurrentUser } from '../auth/current-user.decorator';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/auth.types';
import { RequirePermission } from '../authorization/require-permission.decorator';
import { AuthenticatedOnly } from '../authorization/authenticated-only.decorator';
import { getOrCreateRequestId } from '../common/http/request-id';
import { BookingPolicyService } from './booking-policy.service';
import { BookingSettingsService } from './booking-settings.service';
import { MachineIdParamsDto } from '../machines/machines.dto';
import { UpdateBookingSettingsDto } from './booking-settings.dto';
import { AvailabilityService } from './availability.service';
import { AvailabilitySearchQueryDto, MachineAvailabilityQueryDto } from './availability.dto';
import { CreateBookingDto } from './booking-creation.dto';
import { BookingService } from './booking.service';
import {
  ApproveBookingDto,
  BookingIdParamsDto,
  CancelBookingDto,
  ListBookingsQueryDto,
  RejectBookingDto,
  UpdateBookingDto,
} from './booking-lifecycle.dto';

@ApiBearerAuth('supabase')
@ApiTags('bookings')
@Controller('bookings')
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  @Get()
  @AuthenticatedOnly()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ summary: 'List bookings visible to the current user' })
  list(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: ListBookingsQueryDto,
  ): Promise<ManagedBookingPage> {
    return this.bookings.list(actor, query);
  }

  @Get(':id')
  @AuthenticatedOnly()
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ summary: 'Read one visible booking' })
  get(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: BookingIdParamsDto,
  ): Promise<ManagedBooking> {
    return this.bookings.get(actor, params.id);
  }

  @Patch(':id')
  @RequirePermission('booking:create')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ summary: 'Reschedule or update a booking purpose' })
  update(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: BookingIdParamsDto,
    @Body() input: UpdateBookingDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedBooking> {
    return this.bookings.update(actor, params.id, input, getOrCreateRequestId(request));
  }

  @Post(':id/cancel')
  @AuthenticatedOnly()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    description: 'Reason must be generic and contain no patient names or identifiers.',
    summary: 'Cancel a booking',
  })
  cancel(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: BookingIdParamsDto,
    @Body() input: CancelBookingDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedBooking> {
    return this.bookings.cancel(actor, params.id, input, getOrCreateRequestId(request));
  }

  @Post(':id/approve')
  @RequirePermission('booking:approve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ summary: 'Approve a pending booking' })
  approve(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: BookingIdParamsDto,
    @Body() input: ApproveBookingDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedBooking> {
    return this.bookings.approve(actor, params.id, input, getOrCreateRequestId(request));
  }

  @Post(':id/reject')
  @RequirePermission('booking:approve')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({ summary: 'Reject a pending booking' })
  reject(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: BookingIdParamsDto,
    @Body() input: RejectBookingDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<ManagedBooking> {
    return this.bookings.reject(actor, params.id, input, getOrCreateRequestId(request));
  }

  @Post()
  @RequirePermission('booking:create')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    description:
      'Creates one booking after authoritative policy and conflict revalidation. Purpose must be generic and contain no patient names or identifiers.',
    summary: 'Create a booking',
  })
  async create(
    @CurrentUser() actor: AuthenticatedUser,
    @Body() input: CreateBookingDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CreatedBooking> {
    const outcome = await this.bookings.create(
      actor,
      input,
      getOrCreateRequestId(request),
      idempotencyKey,
    );
    response.status(outcome.replayed ? 200 : 201);
    if (outcome.replayed) response.setHeader('Idempotency-Replayed', 'true');
    return outcome.booking;
  }
}

@ApiBearerAuth('supabase')
@ApiTags('booking policy')
@Controller('machines')
export class BookingPolicyController {
  constructor(
    private readonly policy: BookingPolicyService,
    private readonly availability: AvailabilityService,
  ) {}

  @Get(':id/availability')
  @RequirePermission('machine:read')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    description:
      'Returns a half-open [from,to) advisory snapshot. Booking creation must revalidate and may still conflict.',
    summary: 'Read machine availability and free windows',
  })
  getAvailability(
    @CurrentUser() actor: AuthenticatedUser,
    @Param() params: MachineIdParamsDto,
    @Query() query: MachineAvailabilityQueryDto,
  ): Promise<MachineAvailability> {
    return this.availability.detail(actor, params.id, query);
  }

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
@ApiTags('availability')
@Controller('availability')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('search')
  @RequirePermission('machine:read')
  @Header('Cache-Control', 'no-store')
  @Header('Vary', 'Authorization')
  @ApiOperation({
    description:
      'Finds machines available for the full candidate range including each machine effective buffer. The result is advisory.',
    summary: 'Search exact-window machine availability',
  })
  search(
    @CurrentUser() actor: AuthenticatedUser,
    @Query() query: AvailabilitySearchQueryDto,
  ): Promise<AvailabilitySearchResult> {
    return this.availability.search(actor, query);
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
