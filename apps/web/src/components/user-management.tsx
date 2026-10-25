'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canAssignRole,
  canManageUser,
  inviteUserSchema,
  ROLES,
  updateUserSchema,
  type AppRole,
  type ManagedDepartment,
  type ManagedUser,
} from '@app/shared';
import { CheckCircle2, LoaderCircle, Pencil, Plus, Search, UserRoundX } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthenticatedUser } from '@/components/authenticated-user-provider';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiClientError } from '@/lib/api/client';
import { usersApi } from '@/lib/api/users';

const PAGE_SIZE = 25;
const ROLE_LABELS: Record<AppRole, string> = {
  ADMIN: 'Administrator',
  BIOMED_TECH: 'Biomedical technician',
  DEPT_MANAGER: 'Department manager',
  STAFF: 'Staff',
  SUPER_ADMIN: 'Super administrator',
  VIEWER: 'Viewer',
};

const friendlyError = (error: unknown): string => {
  if (!(error instanceof ApiClientError)) return 'Something went wrong. Please try again.';
  const messages: Record<string, string> = {
    AUTH_IDENTITY_EXISTS:
      'An authentication identity already exists. Ask an administrator to reconcile it.',
    DEPARTMENT_NOT_FOUND: 'Choose a valid department.',
    LAST_SUPER_ADMIN: 'The final active super administrator cannot be changed.',
    ROLE_ASSIGNMENT_DENIED: 'You cannot assign that role.',
    SEED_USER_PROTECTED: 'Demo seed users cannot be managed.',
    SELF_DEACTIVATION_DENIED: 'You cannot deactivate your own account.',
    SELF_ROLE_OR_DEPARTMENT_CHANGE: 'You cannot change your own role or department.',
    SUPER_ADMIN_PROTECTED: 'Administrators cannot modify a super administrator.',
    USER_ALREADY_EXISTS: 'A user with that email address already exists.',
  };
  return messages[error.code] ?? 'The request could not be completed. Please try again.';
};

function RoleSelect({
  actorRole,
  disabled,
  id,
  onValueChange,
  value,
}: {
  actorRole: AppRole;
  disabled?: boolean;
  id: string;
  onValueChange: (value: AppRole) => void;
  value: AppRole;
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => onValueChange(next as AppRole)}
      disabled={disabled}
    >
      <SelectTrigger id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {ROLES.filter((role) => canAssignRole(actorRole, role)).map((role) => (
            <SelectItem key={role} value={role}>
              {ROLE_LABELS[role]}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function DepartmentSelect({
  departments,
  disabled,
  id,
  onValueChange,
  value,
}: {
  departments: readonly ManagedDepartment[];
  disabled?: boolean;
  id: string;
  onValueChange: (value: string | null) => void;
  value: string | null;
}) {
  return (
    <Select
      value={value ?? 'none'}
      onValueChange={(next) => onValueChange(next === 'none' ? null : next)}
      disabled={disabled}
    >
      <SelectTrigger id={id}>
        <SelectValue placeholder="No department" />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value="none">No department</SelectItem>
          {departments.map((department) => (
            <SelectItem key={department.id} value={department.id}>
              {department.name} ({department.code})
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function UserManagement() {
  const { user: actor } = useAuthenticatedUser();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState<string>('all');
  const [active, setActive] = useState<string>('all');
  const [department, setDepartment] = useState<string>('all');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedUser | null>(null);
  const [activationTarget, setActivationTarget] = useState<ManagedUser | null>(null);

  const filters = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      ...(search ? { search } : {}),
      ...(role === 'all' ? {} : { role }),
      ...(department === 'all' ? {} : { departmentId: department }),
      ...(active === 'all' ? {} : { active: active === 'active' }),
    }),
    [active, department, page, role, search],
  );
  const users = useQuery({ queryFn: () => usersApi.list(filters), queryKey: ['users', filters] });
  const departments = useQuery({ queryFn: usersApi.departments, queryKey: ['user-departments'] });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['users'] });
  const activation = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      usersApi.setActive(id, isActive),
    onError: (error) => toast.error(friendlyError(error)),
    onSuccess: async () => {
      await refresh();
      setActivationTarget(null);
      toast.success('User access updated.');
    },
  });

  const totalPages = Math.max(1, Math.ceil((users.data?.total ?? 0) / PAGE_SIZE));
  const departmentOptions = departments.data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-primary">
            Administration
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Users and access</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Invite authorised staff and manage their application role, department and access state.
          </p>
        </div>
        <Button onClick={() => setInviteOpen(true)}>
          <Plus data-icon="inline-start" />
          Invite user
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Find users</CardTitle>
          <CardDescription>Seed demo records are excluded from this workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(12rem,1fr)_11rem_12rem_10rem_auto]"
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
              setSearch(searchInput.trim());
            }}
          >
            <Field>
              <FieldLabel htmlFor="user-search">Name or email</FieldLabel>
              <Input
                id="user-search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                maxLength={120}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="role-filter">Role</FieldLabel>
              <Select
                value={role}
                onValueChange={(value) => {
                  setRole(value);
                  setPage(1);
                }}
              >
                <SelectTrigger id="role-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All roles</SelectItem>
                    {ROLES.map((item) => (
                      <SelectItem key={item} value={item}>
                        {ROLE_LABELS[item]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="department-filter">Department</FieldLabel>
              <Select
                value={department}
                onValueChange={(value) => {
                  setDepartment(value);
                  setPage(1);
                }}
              >
                <SelectTrigger id="department-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All departments</SelectItem>
                    {departmentOptions.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.name}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="status-filter">Status</FieldLabel>
              <Select
                value={active}
                onValueChange={(value) => {
                  setActive(value);
                  setPage(1);
                }}
              >
                <SelectTrigger id="status-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Button
              type="submit"
              variant="outline"
              className="self-end sm:col-span-2 xl:col-span-1"
            >
              <Search data-icon="inline-start" />
              Search
            </Button>
          </form>
        </CardContent>
      </Card>

      {users.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Users could not be loaded</AlertTitle>
          <AlertDescription>{friendlyError(users.error)}</AlertDescription>
        </Alert>
      ) : users.isPending ? (
        <div className="flex flex-col gap-3" aria-label="Loading users">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : users.data.items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No users found</EmptyTitle>
            <EmptyDescription>Adjust the filters or invite the first user.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="hidden overflow-x-auto rounded-lg border lg:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.data.items.map((managedUser) => (
                  <UserRow
                    key={managedUser.id}
                    actor={actor}
                    user={managedUser}
                    onEdit={setEditing}
                    onActivation={setActivationTarget}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="grid gap-3 lg:hidden">
            {users.data.items.map((managedUser) => (
              <UserCard
                key={managedUser.id}
                actor={actor}
                user={managedUser}
                onEdit={setEditing}
                onActivation={setActivationTarget}
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-4">
            <p className="text-sm text-muted-foreground">
              Page {page} of {totalPages} · {users.data.total} users
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={page >= totalPages}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      <InviteDialog
        open={inviteOpen}
        onOpenChange={setInviteOpen}
        actorRole={actor.role}
        departments={departmentOptions}
        onSaved={refresh}
      />
      <EditDialog
        user={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        actor={actor}
        departments={departmentOptions}
        onSaved={refresh}
      />
      <AlertDialog
        open={activationTarget !== null}
        onOpenChange={(open) => {
          if (!open) setActivationTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {activationTarget?.isActive ? 'Deactivate' : 'Reactivate'}{' '}
              {activationTarget?.fullName}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {activationTarget?.isActive
                ? 'They can still sign in to Supabase, but every application API request will be denied until reactivated.'
                : 'Their application access will be restored immediately.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={
                activationTarget?.isActive
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : undefined
              }
              disabled={activation.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (activationTarget)
                  activation.mutate({
                    id: activationTarget.id,
                    isActive: !activationTarget.isActive,
                  });
              }}
            >
              {activation.isPending
                ? 'Saving…'
                : activationTarget?.isActive
                  ? 'Deactivate'
                  : 'Reactivate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type UserActionsProps = {
  actor: { id: string; role: AppRole };
  user: ManagedUser;
  onEdit: (user: ManagedUser) => void;
  onActivation: (user: ManagedUser) => void;
};

function UserStatus({ user }: { user: ManagedUser }) {
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant={user.isActive ? 'default' : 'destructive'}>
        {user.isActive ? 'Active' : 'Inactive'}
      </Badge>
      {user.lastLoginAt === null ? (
        <Badge variant="secondary">Invited, not yet signed in</Badge>
      ) : null}
    </div>
  );
}

function UserActions({ actor, user, onEdit, onActivation }: UserActionsProps) {
  const manageable = canManageUser(actor.role, user.role);
  return (
    <div className="flex justify-end gap-2">
      <Button size="sm" variant="outline" disabled={!manageable} onClick={() => onEdit(user)}>
        <Pencil data-icon="inline-start" />
        Edit
      </Button>
      <Button
        size="sm"
        variant={user.isActive ? 'destructive' : 'outline'}
        disabled={!manageable || actor.id === user.id}
        onClick={() => onActivation(user)}
      >
        {user.isActive ? (
          <UserRoundX data-icon="inline-start" />
        ) : (
          <CheckCircle2 data-icon="inline-start" />
        )}
        {user.isActive ? 'Deactivate' : 'Reactivate'}
      </Button>
    </div>
  );
}

function UserRow(props: UserActionsProps) {
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{props.user.fullName}</div>
        <div className="text-sm text-muted-foreground">{props.user.email}</div>
      </TableCell>
      <TableCell>{ROLE_LABELS[props.user.role]}</TableCell>
      <TableCell>{props.user.department?.name ?? 'Not assigned'}</TableCell>
      <TableCell>
        <UserStatus user={props.user} />
      </TableCell>
      <TableCell>
        <UserActions {...props} />
      </TableCell>
    </TableRow>
  );
}

function UserCard(props: UserActionsProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{props.user.fullName}</CardTitle>
        <CardDescription className="break-all">{props.user.email}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-muted-foreground">Role</dt>
            <dd className="font-medium">{ROLE_LABELS[props.user.role]}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Department</dt>
            <dd className="font-medium">{props.user.department?.name ?? 'Not assigned'}</dd>
          </div>
        </dl>
        <UserStatus user={props.user} />
        <UserActions {...props} />
      </CardContent>
    </Card>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  actorRole,
  departments,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actorRole: AppRole;
  departments: readonly ManagedDepartment[];
  onSaved: () => Promise<unknown>;
}) {
  const [role, setRole] = useState<AppRole>('STAFF');
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: usersApi.invite,
    onError: (value) => setError(friendlyError(value)),
    onSuccess: async () => {
      await onSaved();
      onOpenChange(false);
      setError(null);
      toast.success('Invitation created.');
    },
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const parsed = inviteUserSchema.safeParse({
      departmentId,
      email: form.get('email'),
      fullName: form.get('fullName'),
      role,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the form.');
      return;
    }
    mutation.mutate(parsed.data);
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a user</DialogTitle>
          <DialogDescription>
            Create the authentication identity and matching application account.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="invite-name">Full name</FieldLabel>
              <Input id="invite-name" name="fullName" maxLength={120} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="invite-email">Email address</FieldLabel>
              <Input id="invite-email" name="email" type="email" maxLength={320} required />
            </Field>
            <Field>
              <FieldLabel htmlFor="invite-role">Role</FieldLabel>
              <RoleSelect
                id="invite-role"
                actorRole={actorRole}
                value={role}
                onValueChange={setRole}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="invite-department">Department</FieldLabel>
              <DepartmentSelect
                id="invite-department"
                departments={departments}
                value={departmentId}
                onValueChange={setDepartmentId}
              />
            </Field>
            <FieldError>{error}</FieldError>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? (
                  <LoaderCircle data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Plus data-icon="inline-start" />
                )}
                {mutation.isPending ? 'Inviting…' : 'Create invitation'}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditDialog({
  user,
  onOpenChange,
  actor,
  departments,
  onSaved,
}: {
  user: ManagedUser | null;
  onOpenChange: (open: boolean) => void;
  actor: { id: string; role: AppRole };
  departments: readonly ManagedDepartment[];
  onSaved: () => Promise<unknown>;
}) {
  const [role, setRole] = useState<AppRole>('STAFF');
  const [departmentId, setDepartmentId] = useState<string | null>(null);
  const [fullName, setFullName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: string;
      input: { role: AppRole; departmentId: string | null; fullName: string };
    }) => usersApi.update(id, input),
    onError: (value) => setError(friendlyError(value)),
    onSuccess: async () => {
      await onSaved();
      onOpenChange(false);
      toast.success('User details updated.');
    },
  });
  const open = user !== null;
  const sync = (nextOpen: boolean) => {
    if (nextOpen && user) {
      setRole(user.role);
      setDepartmentId(user.department?.id ?? null);
      setFullName(user.fullName);
      setError(null);
    }
    onOpenChange(nextOpen);
  };
  return (
    <Dialog open={open} onOpenChange={sync}>
      <DialogContent
        onOpenAutoFocus={() => {
          if (user) {
            setRole(user.role);
            setDepartmentId(user.department?.id ?? null);
            setFullName(user.fullName);
            setError(null);
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Edit user</DialogTitle>
          <DialogDescription>
            Email addresses are immutable. Role and department changes apply on the next API
            request.
          </DialogDescription>
        </DialogHeader>
        {user ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const parsed = updateUserSchema.safeParse({ role, departmentId, fullName });
              if (!parsed.success) {
                setError(parsed.error.issues[0]?.message ?? 'Check the form.');
                return;
              }
              mutation.mutate({ id: user.id, input: { role, departmentId, fullName } });
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="edit-name">Full name</FieldLabel>
                <Input
                  id="edit-name"
                  value={fullName}
                  onChange={(event) => setFullName(event.target.value)}
                  maxLength={120}
                  required
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-role">Role</FieldLabel>
                <RoleSelect
                  id="edit-role"
                  actorRole={actor.role}
                  value={role}
                  onValueChange={setRole}
                  disabled={actor.id === user.id}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="edit-department">Department</FieldLabel>
                <DepartmentSelect
                  id="edit-department"
                  departments={departments}
                  value={departmentId}
                  onValueChange={setDepartmentId}
                  disabled={actor.id === user.id}
                />
              </Field>
              <FieldError>{error}</FieldError>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
