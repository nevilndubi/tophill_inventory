import { can, getPermissionScope, type AppRole, type MachineLiveStatus } from '@app/shared';

export type StatusActor = Readonly<{
  departmentId: string | null;
  id: string;
  role: AppRole;
}>;

export type StatusQuickActions = Readonly<{
  canCheckIn: boolean;
  canCheckOut: boolean;
  canForceEnd: boolean;
}>;

export const statusQuickActions = (
  actor: StatusActor,
  machine: MachineLiveStatus,
): StatusQuickActions => {
  const session = machine.open_session;
  const forceScope = getPermissionScope(actor.role, 'usage:force-end');
  return {
    canCheckIn:
      session !== null && session.held_by_current_user && can(actor.role, 'usage:check-in-out'),
    canCheckOut: machine.usable && session === null && can(actor.role, 'usage:check-in-out'),
    canForceEnd:
      session !== null &&
      !session.held_by_current_user &&
      (forceScope === 'GLOBAL' ||
        (forceScope === 'OWN_DEPARTMENT' &&
          actor.departmentId !== null &&
          actor.departmentId === machine.department.id)),
  };
};
