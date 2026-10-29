import { z } from 'zod';

export const openEventTypeSchema = z
  .string()
  .regex(/^[a-z0-9._]{1,64}$/, 'Use 1-64 lowercase letters, digits, dots, or underscores');

export const AUDIT_ACTIONS = [
  'app_setting.updated',
  'attachment.deleted',
  'attachment.uploaded',
  'booking.approved',
  'booking.cancelled',
  'booking.created',
  'booking.rejected',
  'booking.updated',
  'category.created',
  'category.deleted',
  'category.updated',
  'department.created',
  'department.deleted',
  'department.manager_changed',
  'department.manager_cleared',
  'department.updated',
  'export.completed',
  'import.completed',
  'machine.condition_changed',
  'machine.created',
  'machine.deleted',
  'machine.import_completed',
  'machine.restored',
  'machine.retired',
  'machine.updated',
  'location.created',
  'location.deleted',
  'location.updated',
  'service_ticket.created',
  'service_ticket.updated',
  'usage.checked_in',
  'usage.checked_out',
  'usage.force_ended',
  'user.created',
  'user.department_changed',
  'user.deactivated',
  'user.invited',
  'user.reactivated',
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
