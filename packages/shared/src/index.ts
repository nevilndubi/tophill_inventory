export const APP_NAME = 'Tophill Inventory' as const;

export {
  AUDIT_ACTIONS,
  auditActionSchema,
  NOTIFICATION_TYPES,
  notificationTypeSchema,
  openEventTypeSchema,
  type AuditAction,
  type NotificationType,
} from './event-types';
