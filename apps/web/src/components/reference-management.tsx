'use client';

import { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createDepartmentSchema,
  createLocationSchema,
  type CreateDepartmentInput,
  type CreateLocationInput,
  type ManagedDepartmentReference,
  type ManagedLocation,
} from '@app/shared';
import { Building2, LoaderCircle, MapPin, Pencil, Plus, Trash2 } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { CategoryManagement } from './category-management';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { departmentsApi, locationsApi } from '@/lib/api/reference';
import { ApiClientError } from '@/lib/api/client';

type Section = 'categories' | 'departments' | 'locations';
const sections = new Set<Section>(['categories', 'departments', 'locations']);
const errorMessage = (error: unknown) => {
  if (!(error instanceof ApiClientError)) return 'The request could not be completed. Try again.';
  const messages: Record<string, string> = {
    DEPARTMENT_CODE_TAKEN: 'A department with this code already exists.',
    DEPARTMENT_IN_USE: 'This department still has dependent records.',
    DEPARTMENT_NAME_TAKEN: 'A department with this name already exists.',
    LOCATION_IN_USE: 'This location is still used by machines.',
    LOCATION_NAME_TAKEN: 'This department already has a location with that name.',
    MANAGER_NOT_ELIGIBLE: 'That person is no longer eligible to manage this department.',
    USER_NOT_FOUND: 'That manager is no longer available.',
  };
  return messages[error.code] ?? 'The request could not be completed. Try again.';
};

export function ReferenceManagement({ initialSection }: { initialSection: Section }) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const selectSection = (value: string) => {
    if (!sections.has(value as Section)) return;
    const params = new URLSearchParams(search.toString());
    params.set('section', value);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };
  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-sm font-semibold uppercase tracking-wide text-primary">Administration</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Reference data</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          Manage categories, departments and the physical locations used throughout inventory
          records.
        </p>
      </header>
      <Tabs value={initialSection} onValueChange={selectSection}>
        <TabsList
          aria-label="Reference data sections"
          className="w-full justify-start overflow-x-auto"
        >
          <TabsTrigger value="categories">Categories</TabsTrigger>
          <TabsTrigger value="departments">Departments</TabsTrigger>
          <TabsTrigger value="locations">Locations</TabsTrigger>
        </TabsList>
        <TabsContent value="categories">
          <CategoryManagement />
        </TabsContent>
        <TabsContent value="departments">
          <DepartmentManagement />
        </TabsContent>
        <TabsContent value="locations">
          <LocationManagement />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function LoadingRows({ label }: { label: string }) {
  return (
    <div className="flex flex-col gap-3" aria-label={label}>
      {Array.from({ length: 4 }).map((_, index) => (
        <Skeleton className="h-20 w-full" key={index} />
      ))}
    </div>
  );
}

type DepartmentFormValues = { code: string; managerUserId: string; name: string };
const departmentFormSchema = z
  .object({ code: z.string(), managerUserId: z.string(), name: z.string() })
  .transform((value) =>
    createDepartmentSchema.parse({ ...value, managerUserId: value.managerUserId || null }),
  );
function DepartmentDialog({
  department,
  onClose,
}: {
  department: ManagedDepartmentReference | null | undefined;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const form = useForm<DepartmentFormValues, unknown, CreateDepartmentInput>({
    defaultValues: {
      code: department?.code ?? '',
      managerUserId: department?.manager?.id ?? '',
      name: department?.name ?? '',
    },
    resolver: zodResolver(departmentFormSchema),
  });
  const managerUserId = useWatch({ control: form.control, name: 'managerUserId' });
  useEffect(
    () =>
      form.reset({
        code: department?.code ?? '',
        managerUserId: department?.manager?.id ?? '',
        name: department?.name ?? '',
      }),
    [department, form],
  );
  const candidates = useQuery({
    enabled: Boolean(department?.id),
    queryFn: () => departmentsApi.eligibleManagers(department!.id),
    queryKey: ['departments', department?.id, 'eligible-managers'],
  });
  const mutation = useMutation({
    mutationFn: (input: CreateDepartmentInput) =>
      department ? departmentsApi.update(department.id, input) : departmentsApi.create(input),
    onError: (error) => form.setError('name', { message: errorMessage(error) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['departments'] });
      toast.success(department ? 'Department updated.' : 'Department created.');
      onClose();
    },
  });
  return (
    <Dialog
      open={department !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{department ? `Edit ${department.name}` : 'Add department'}</DialogTitle>
          <DialogDescription>
            Department codes are editable and appear in reports.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={form.handleSubmit((value) => mutation.mutate(value))}>
          <FieldGroup>
            <Field data-invalid={Boolean(form.formState.errors.name)}>
              <FieldLabel htmlFor="department-name">Name</FieldLabel>
              <Input
                autoFocus
                id="department-name"
                aria-invalid={Boolean(form.formState.errors.name)}
                {...form.register('name')}
              />
              <FieldError>{form.formState.errors.name?.message}</FieldError>
            </Field>
            <Field data-invalid={Boolean(form.formState.errors.code)}>
              <FieldLabel htmlFor="department-code">Code</FieldLabel>
              <Input
                id="department-code"
                aria-invalid={Boolean(form.formState.errors.code)}
                {...form.register('code')}
              />
              <FieldError>{form.formState.errors.code?.message}</FieldError>
              <p className="text-xs text-muted-foreground">
                Changing this code does not move locations or machines, but it changes future report
                labels.
              </p>
            </Field>
            {department && (
              <Field>
                <FieldLabel htmlFor="department-manager">Manager</FieldLabel>
                <Select
                  value={managerUserId || 'none'}
                  onValueChange={(value) =>
                    form.setValue('managerUserId', value === 'none' ? '' : value)
                  }
                >
                  <SelectTrigger id="department-manager">
                    <SelectValue placeholder="No manager" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="none">No manager</SelectItem>
                      {candidates.data?.map((candidate) => (
                        <SelectItem key={candidate.id} value={candidate.id}>
                          {candidate.full_name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Managers must have the Department Manager role and belong to this department.
                </p>
              </Field>
            )}
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={mutation.isPending} type="submit">
              {mutation.isPending && (
                <LoaderCircle className="animate-spin" data-icon="inline-start" />
              )}
              {department ? 'Save changes' : 'Create department'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DepartmentManagement() {
  const client = useQueryClient();
  const [editing, setEditing] = useState<ManagedDepartmentReference | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<ManagedDepartmentReference | null>(null);
  const query = useQuery({ queryFn: departmentsApi.list, queryKey: ['departments'] });
  const deletion = useMutation({
    mutationFn: departmentsApi.delete,
    onError: (error) => toast.error(errorMessage(error)),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['departments'] });
      setDeleting(null);
      toast.success('Department deleted.');
    },
  });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Departments</h2>
          <p className="text-muted-foreground">
            Manage ownership groups and their optional department manager.
          </p>
        </div>
        <Button onClick={() => setEditing(null)}>
          <Plus data-icon="inline-start" /> Add department
        </Button>
      </div>
      {query.isError && (
        <Alert variant="destructive">
          <AlertTitle>Departments could not be loaded</AlertTitle>
          <AlertDescription>
            <Button size="sm" variant="outline" onClick={() => query.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Departments</CardTitle>
          <CardDescription>
            A department with dependent users, locations or machines cannot be deleted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <LoadingRows label="Loading departments" />
          ) : query.data?.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <Building2 />
                <EmptyTitle>No departments</EmptyTitle>
                <EmptyDescription>Create the first department.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-3">
              {query.data?.map((department) => (
                <div className="rounded-lg border p-4" key={department.id}>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <h3 className="font-semibold">
                        {department.name}{' '}
                        <span className="text-muted-foreground">({department.code})</span>
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {department.manager?.full_name ?? 'No manager'} · {department.user_count}{' '}
                        users · {department.location_count} locations · {department.machine_count}{' '}
                        machines
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Edit ${department.name}`}
                        onClick={() => setEditing(department)}
                      >
                        <Pencil data-icon="inline-start" /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={!department.is_deletable}
                        title={
                          !department.is_deletable
                            ? 'Dependent users, locations or machines prevent deletion'
                            : undefined
                        }
                        aria-label={`Delete ${department.name}`}
                        onClick={() => setDeleting(department)}
                      >
                        <Trash2 data-icon="inline-start" /> Delete
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <DepartmentDialog department={editing} onClose={() => setEditing(undefined)} />
      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the empty department. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && deletion.mutate(deleting.id)}>
              Delete department
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type LocationFormValues = {
  building: string;
  departmentId: string;
  floor: string;
  name: string;
  room: string;
};
const locationFormSchema = z
  .object({
    building: z.string(),
    departmentId: z.string(),
    floor: z.string(),
    name: z.string(),
    room: z.string(),
  })
  .transform((value) => createLocationSchema.parse(value));
function LocationDialog({
  activeDepartment,
  departments,
  location,
  onClose,
}: {
  activeDepartment: string;
  departments: readonly ManagedDepartmentReference[];
  location: ManagedLocation | null | undefined;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const form = useForm<LocationFormValues, unknown, CreateLocationInput>({
    defaultValues: {
      building: location?.building ?? '',
      departmentId: location?.department.id ?? activeDepartment,
      floor: location?.floor ?? '',
      name: location?.name ?? '',
      room: location?.room ?? '',
    },
    resolver: zodResolver(locationFormSchema),
  });
  const selectedDepartmentId = useWatch({ control: form.control, name: 'departmentId' });
  useEffect(
    () =>
      form.reset({
        building: location?.building ?? '',
        departmentId: location?.department.id ?? activeDepartment,
        floor: location?.floor ?? '',
        name: location?.name ?? '',
        room: location?.room ?? '',
      }),
    [activeDepartment, form, location],
  );
  const mutation = useMutation({
    mutationFn: (input: CreateLocationInput) =>
      location
        ? locationsApi.update(location.id, {
            building: input.building,
            floor: input.floor,
            name: input.name,
            room: input.room,
          })
        : locationsApi.create(input),
    onError: (error) => form.setError('name', { message: errorMessage(error) }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['locations'] });
      toast.success(location ? 'Location updated.' : 'Location created.');
      onClose();
    },
  });
  return (
    <Dialog
      open={location !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{location ? `Edit ${location.name}` : 'Add location'}</DialogTitle>
          <DialogDescription>
            A location stays in its original department. Create a new location to move it.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={form.handleSubmit((input) => mutation.mutate(input))}>
          <FieldGroup>
            <Field data-invalid={Boolean(form.formState.errors.departmentId)}>
              <FieldLabel htmlFor="location-department">Department</FieldLabel>
              <Select
                disabled={Boolean(location)}
                value={selectedDepartmentId}
                onValueChange={(value) => form.setValue('departmentId', value)}
              >
                <SelectTrigger id="location-department">
                  <SelectValue placeholder="Select department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {departments.map((department) => (
                      <SelectItem key={department.id} value={department.id}>
                        {department.name} ({department.code})
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldError>{form.formState.errors.departmentId?.message}</FieldError>
            </Field>
            <Field data-invalid={Boolean(form.formState.errors.name)}>
              <FieldLabel htmlFor="location-name">Name</FieldLabel>
              <Input autoFocus id="location-name" {...form.register('name')} />
              <FieldError>{form.formState.errors.name?.message}</FieldError>
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              {(['building', 'floor', 'room'] as const).map((field) => (
                <Field key={field}>
                  <FieldLabel htmlFor={`location-${field}`}>
                    {field[0]!.toUpperCase() + field.slice(1)}
                  </FieldLabel>
                  <Input id={`location-${field}`} {...form.register(field)} />
                  <FieldError>{form.formState.errors[field]?.message}</FieldError>
                </Field>
              ))}
            </div>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={mutation.isPending} type="submit">
              {mutation.isPending && (
                <LoaderCircle className="animate-spin" data-icon="inline-start" />
              )}
              {location ? 'Save changes' : 'Create location'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LocationManagement() {
  const client = useQueryClient();
  const [departmentId, setDepartmentId] = useState('all');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ManagedLocation | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<ManagedLocation | null>(null);
  const departments = useQuery({ queryFn: departmentsApi.list, queryKey: ['departments'] });
  const locations = useQuery({
    queryFn: () =>
      locationsApi.list({
        departmentId: departmentId === 'all' ? undefined : departmentId,
        search: search || undefined,
      }),
    queryKey: ['locations', departmentId, search],
  });
  const deletion = useMutation({
    mutationFn: locationsApi.delete,
    onError: (error) => toast.error(errorMessage(error)),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['locations'] });
      setDeleting(null);
      toast.success('Location deleted.');
    },
  });
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold">Locations</h2>
          <p className="text-muted-foreground">
            Manage physical rooms and areas within departments.
          </p>
        </div>
        <Button disabled={!departments.data?.length} onClick={() => setEditing(null)}>
          <Plus data-icon="inline-start" /> Add location
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="location-filter">Department</FieldLabel>
          <Select value={departmentId} onValueChange={setDepartmentId}>
            <SelectTrigger id="location-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">All departments</SelectItem>
                {departments.data?.map((department) => (
                  <SelectItem key={department.id} value={department.id}>
                    {department.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
        <Field>
          <FieldLabel htmlFor="location-search">Search by name</FieldLabel>
          <Input
            id="location-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </Field>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Locations</CardTitle>
          <CardDescription>Results are sorted by department, then location name.</CardDescription>
        </CardHeader>
        <CardContent>
          {locations.isLoading ? (
            <LoadingRows label="Loading locations" />
          ) : locations.isError ? (
            <Alert variant="destructive">
              <AlertTitle>Locations could not be loaded</AlertTitle>
              <AlertDescription>
                <Button size="sm" variant="outline" onClick={() => locations.refetch()}>
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : locations.data?.items.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <MapPin />
                <EmptyTitle>No matching locations</EmptyTitle>
                <EmptyDescription>Change the filter or create a location.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid gap-3">
              {locations.data?.items.map((location) => (
                <div className="rounded-lg border p-4" key={location.id}>
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                      <h3 className="font-semibold">{location.name}</h3>
                      <p className="text-sm text-muted-foreground">
                        {location.department.name} ({location.department.code}) ·{' '}
                        {[location.building, location.floor, location.room]
                          .filter(Boolean)
                          .join(' · ') || 'No room details'}{' '}
                        · {location.machine_count} machines
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={`Edit ${location.name}`}
                        onClick={() => setEditing(location)}
                      >
                        <Pencil data-icon="inline-start" /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={!location.is_deletable}
                        title={!location.is_deletable ? 'Machines prevent deletion' : undefined}
                        aria-label={`Delete ${location.name}`}
                        onClick={() => setDeleting(location)}
                      >
                        <Trash2 data-icon="inline-start" /> Delete
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <LocationDialog
        activeDepartment={departmentId === 'all' ? '' : departmentId}
        departments={departments.data ?? []}
        location={editing}
        onClose={() => setEditing(undefined)}
      />
      <AlertDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the empty location. It cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleting && deletion.mutate(deleting.id)}>
              Delete location
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
