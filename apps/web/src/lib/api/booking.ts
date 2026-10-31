import type { BookingSettings, EffectiveBookingPolicy, UpdateBookingSettings } from '@app/shared';
import { browserApi } from './browser-client';

export const bookingApi = {
  policy(machineId: string): Promise<EffectiveBookingPolicy> {
    return browserApi.request<EffectiveBookingPolicy>(`/machines/${machineId}/booking-policy`);
  },
  settings(): Promise<BookingSettings> {
    return browserApi.request<BookingSettings>('/settings/booking');
  },
  updateSettings(input: UpdateBookingSettings): Promise<BookingSettings> {
    return browserApi.request<BookingSettings>('/settings/booking', {
      body: JSON.stringify(input),
      method: 'PATCH',
    });
  },
};
