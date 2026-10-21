import { z } from 'zod';

export const openEventTypeSchema = z
  .string()
  .regex(/^[a-z0-9._]{1,64}$/, 'Use 1-64 lowercase letters, digits, dots, or underscores');

export const AUDIT_ACTIONS = [
  'app_setting.updated',
  'booking.approved',
  'booking.cancelled',
  'booking.created',
  'booking.rejected',
  'booking.updated',
  'export.completed',
  'import.completed',
  'machine.condition_changed',
  'machine.created',
  'machine.restored',
  'machine.retired',
  'machine.updated',
  'service_ticket.created',
  'service_ticket.updated',
  'user.created',
  'user.role_changed',
  'user.updated',
] as const;

export const NOTIFICATION_TYPES = [
  'booking.cancelled',
  'booking.no_show',
  'booking.reminder',
  'checkout.overdue',
  'machine.out_of_service',
  'service.due',
  'service.ticket_updated',
  'warranty.expiring',
] as const;

export const auditActionSchema = z.enum(AUDIT_ACTIONS);
export const notificationTypeSchema = z.enum(NOTIFICATION_TYPES);

export type AuditAction = z.infer<typeof auditActionSchema>;
export type NotificationType = z.infer<typeof notificationTypeSchema>;
