import {
  approveBookingSchema,
  bookingIdParamsSchema,
  cancelBookingSchema,
  listBookingsQuerySchema,
  rejectBookingSchema,
  updateBookingSchema,
  type BookingStatusValue,
} from '@app/shared';
import { createZodDto } from '../common/validation/zod-dto';

export class BookingIdParamsDto extends createZodDto(bookingIdParamsSchema) {
  declare id: string;
}

export class ListBookingsQueryDto extends createZodDto(listBookingsQuerySchema) {
  declare machine_id?: string;
  declare order: 'asc' | 'desc';
  declare page: number;
  declare page_size: number;
  declare sort: 'starts_at' | 'created_at';
  declare status?: BookingStatusValue[];
  declare view: 'mine' | 'managed' | 'all';
  declare when: 'upcoming' | 'past' | 'all';
}

export class UpdateBookingDto extends createZodDto(updateBookingSchema) {
  declare ends_at?: string;
  declare expected_updated_at: string;
  declare purpose?: string;
  declare starts_at?: string;
}

export class CancelBookingDto extends createZodDto(cancelBookingSchema) {
  declare reason: string;
}

export class ApproveBookingDto extends createZodDto(approveBookingSchema) {
  declare note?: string;
}

export class RejectBookingDto extends createZodDto(rejectBookingSchema) {
  declare note: string;
}
