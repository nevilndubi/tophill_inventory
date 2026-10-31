'use client';

import { useEffect, useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createMachineSchema,
  type CreateMachineInput,
  type ManagedMachine,
  type UpdateMachineInput,
} from '@app/shared';
import { AlertTriangle, Calculator, LoaderCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { categoriesApi } from '@/lib/api/categories';
import { bookingApi } from '@/lib/api/booking';
import { ApiClientError } from '@/lib/api/client';
import { machinesApi } from '@/lib/api/machines';
import { departmentsApi, locationsApi } from '@/lib/api/reference';

type FormValues = {
  allowBookingWhenNeedsService: '' | 'true' | 'false';
  bufferMinutes: string;
  categoryId: string;
  commissionedOn: string;
  departmentId: string;
  description: string;
  isBookable: '' | 'true' | 'false';
  lastServicedAt: string;
  locationId: string;
  manufacturer: string;
  maxBookingMinutes: string;
  model: string;
  name: string;
  purchaseDate: string;
  requiresApproval: '' | 'true' | 'false';
  serialNumber: string;
  serviceIntervalDays: string;
  warrantyExpiresOn: string;
};

const EMPTY_VALUES: FormValues = {
  allowBookingWhenNeedsService: '',
  bufferMinutes: '',
  categoryId: '',
  commissionedOn: '',
  departmentId: '',
  description: '',
  isBookable: '',
  lastServicedAt: '',
  locationId: '',
  manufacturer: '',
  maxBookingMinutes: '',
  model: '',
  name: '',
  purchaseDate: '',
  requiresApproval: '',
  serialNumber: '',
  serviceIntervalDays: '',
  warrantyExpiresOn: '',
};

const dateTimeForInput = (value: string | null): string => value ?? '';

const valuesFor = (machine: ManagedMachine): FormValues => ({
  allowBookingWhenNeedsService: String(machine.allowBookingWhenNeedsService) as 'true' | 'false',
  bufferMinutes: machine.bufferMinutes?.toString() ?? '',
  categoryId: machine.category.id,
  commissionedOn: machine.commissionedOn ?? '',
  departmentId: machine.department.id,
  description: machine.description ?? '',
  isBookable: String(machine.isBookable) as 'true' | 'false',
  lastServicedAt: dateTimeForInput(machine.lastServicedAt),
  locationId: machine.location.id,
  manufacturer: machine.manufacturer,
  maxBookingMinutes: machine.maxBookingMinutes?.toString() ?? '',
  model: machine.model,
  name: machine.name,
  purchaseDate: machine.purchaseDate ?? '',
  requiresApproval: String(machine.requiresApproval) as 'true' | 'false',
  serialNumber: machine.serialNumber,
  serviceIntervalDays: machine.serviceIntervalDays?.toString() ?? '',
  warrantyExpiresOn: machine.warrantyExpiresOn ?? '',
});

const nullableNumber = (value: string): number | null => (value === '' ? null : Number(value));
const optionalBoolean = (value: '' | 'true' | 'false'): boolean | undefined =>
  value === '' ? undefined : value === 'true';
const nullableDate = (value: string): string | null => (value === '' ? null : value);
const nullableDateTime = (value: string): string | null => (value === '' ? null : value);

const toCreateInput = (value: FormValues): CreateMachineInput => ({
  bufferMinutes: nullableNumber(value.bufferMinutes),
  categoryId: value.categoryId,
  commissionedOn: nullableDate(value.commissionedOn),
  departmentId: value.departmentId,
  description: value.description,
  lastServicedAt: nullableDateTime(value.lastServicedAt),
  locationId: value.locationId,
  manufacturer: value.manufacturer,
  maxBookingMinutes: nullableNumber(value.maxBookingMinutes),
  model: value.model,
  name: value.name,
  purchaseDate: nullableDate(value.purchaseDate),
  serialNumber: value.serialNumber,
  serviceIntervalDays: nullableNumber(value.serviceIntervalDays),
  warrantyExpiresOn: nullableDate(value.warrantyExpiresOn),
  ...(optionalBoolean(value.allowBookingWhenNeedsService) === undefined
    ? {}
    : { allowBookingWhenNeedsService: optionalBoolean(value.allowBookingWhenNeedsService) }),
  ...(optionalBoolean(value.isBookable) === undefined
    ? {}
    : { isBookable: optionalBoolean(value.isBookable) }),
  ...(optionalBoolean(value.requiresApproval) === undefined
    ? {}
    : { requiresApproval: optionalBoolean(value.requiresApproval) }),
});

const formSchema = z
  .object({
    allowBookingWhenNeedsService: z.enum(['', 'true', 'false']),
    bufferMinutes: z.string(),
    categoryId: z.string(),
    commissionedOn: z.string(),
    departmentId: z.string(),
    description: z.string(),
    isBookable: z.enum(['', 'true', 'false']),
    lastServicedAt: z.string(),
    locationId: z.string(),
    manufacturer: z.string(),
    maxBookingMinutes: z.string(),
    model: z.string(),
    name: z.string(),
    purchaseDate: z.string(),
    requiresApproval: z.enum(['', 'true', 'false']),
    serialNumber: z.string(),
    serviceIntervalDays: z.string(),
    warrantyExpiresOn: z.string(),
  })
  .strict()
  .transform(toCreateInput)
  .pipe(createMachineSchema);

const FRIENDLY_ERRORS: Record<string, string> = {
  MACHINE_CATEGORY_NOT_FOUND: 'Choose an existing category.',
  MACHINE_DATES_INVALID: 'Check the lifecycle dates and their order.',
  MACHINE_DEPARTMENT_NOT_FOUND: 'Choose an existing department.',
  MACHINE_IDENTITY_TAKEN: 'This manufacturer and serial number are already registered.',
  MACHINE_LOCATION_NOT_FOUND: 'Choose an existing location.',
  MACHINE_NOT_FOUND: 'This machine no longer exists.',
  MACHINE_VALUES_INVALID: 'One or more values are outside the allowed range.',
  POLICY_CONFLICT: 'The maximum booking duration cannot be shorter than the global minimum.',
};

const friendlyError = (error: unknown): string =>
  error instanceof ApiClientError
    ? (FRIENDLY_ERRORS[error.code] ?? 'The machine could not be saved. Try again.')
    : 'The machine could not be saved. Try again.';

const changedFields = (before: FormValues, afterInput: CreateMachineInput): UpdateMachineInput => {
  const beforeInput = createMachineSchema.parse(toCreateInput(before));
  return Object.fromEntries(
    Object.entries(afterInput).filter(
      ([key, value]) => value !== beforeInput[key as keyof CreateMachineInput],
    ),
  ) as UpdateMachineInput;
};

function SelectField({
  children,
  error,
  id,
  label,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  error?: string;
  label: string;
}) {
  return (
    <Field data-invalid={Boolean(error)}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <select
        id={id}
        aria-invalid={Boolean(error)}
        aria-describedby={`${id}-error`}
        className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        {...props}
      >
        {children}
      </select>
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </Field>
  );
}

export function MachineForm({ machine = null }: { machine?: ManagedMachine | null }) {
  const initial = useMemo(() => (machine ? valuesFor(machine) : EMPTY_VALUES), [machine]);
  const router = useRouter();
  const queryClient = useQueryClient();
  const [locationPage, setLocationPage] = useState(1);
  const [locationSearch, setLocationSearch] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const form = useForm<FormValues, unknown, CreateMachineInput>({
    defaultValues: initial,
    mode: 'onBlur',
    resolver: zodResolver(formSchema),
  });

  const categories = useQuery({
    queryFn: categoriesApi.list,
    queryKey: ['categories'],
    staleTime: 5 * 60_000,
  });
  const departments = useQuery({
    queryFn: departmentsApi.list,
    queryKey: ['departments'],
    staleTime: 5 * 60_000,
  });
  const locations = useQuery({
    queryFn: () =>
      locationsApi.list({ page: locationPage, pageSize: 50, search: locationSearch || undefined }),
    queryKey: ['locations', { page: locationPage, pageSize: 50, search: locationSearch }],
    staleTime: 5 * 60_000,
  });
  const bookingPolicy = useQuery({
    enabled: Boolean(machine),
    queryFn: () => bookingApi.policy(machine!.id),
    queryKey: ['machine', machine?.id, 'booking-policy'],
  });

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (form.formState.isDirty && !form.formState.isSubmitSuccessful) event.preventDefault();
    };
    const guardLink = (event: MouseEvent) => {
      if (!form.formState.isDirty || form.formState.isSubmitSuccessful) return;
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (target && !window.confirm('Discard your unsaved changes?')) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', guardLink, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      document.removeEventListener('click', guardLink, true);
    };
  }, [form.formState.isDirty, form.formState.isSubmitSuccessful]);

  const mutation = useMutation({
    mutationFn: async (values: CreateMachineInput) => {
      if (!machine) return machinesApi.create(values);
      const delta = changedFields(initial, values);
      if (Object.keys(delta).length === 0) return machine;
      return machinesApi.update(machine.id, delta);
    },
    onError: (error) => {
      const message = friendlyError(error);
      setSubmitError(message);
      if (error instanceof ApiClientError && error.code === 'MACHINE_IDENTITY_TAKEN') {
        form.setError('serialNumber', { message });
        form.setFocus('serialNumber');
      }
    },
    onSuccess: async (saved) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['machines'] }),
        queryClient.invalidateQueries({ queryKey: ['machine', saved.id] }),
        queryClient.invalidateQueries({ queryKey: ['machine', saved.id, 'booking-policy'] }),
      ]);
      if (machine) {
        toast.success('Machine updated.');
        router.push(`/machines/${saved.id}`);
      } else {
        sessionStorage.setItem('machine-created-asset-tag', saved.assetTag);
        router.push(`/machines/${saved.id}`);
      }
    },
  });

  const submit = form.handleSubmit(
    (input) => {
      setSubmitError(null);
      if (machine && Object.keys(changedFields(initial, input)).length === 0) {
        setSubmitError('No changes to save.');
        return;
      }
      if (!mutation.isPending) mutation.mutate(input);
    },
    (errors) => {
      const first = Object.keys(errors)[0] as keyof FormValues | undefined;
      if (first) form.setFocus(first);
    },
  );
  const groupedLocations = locations.data?.items.reduce<
    Record<string, typeof locations.data.items>
  >((groups, location) => {
    const name = location.department.name;
    groups[name] = [...(groups[name] ?? []), location];
    return groups;
  }, {});

  const textField = (name: keyof FormValues, label: string, props = {}) => (
    <Field data-invalid={Boolean(form.formState.errors[name])}>
      <FieldLabel htmlFor={`machine-${name}`}>{label}</FieldLabel>
      <Input
        id={`machine-${name}`}
        aria-invalid={Boolean(form.formState.errors[name])}
        aria-describedby={`machine-${name}-error`}
        {...props}
        {...form.register(name)}
      />
      <FieldError id={`machine-${name}-error`}>{form.formState.errors[name]?.message}</FieldError>
    </Field>
  );

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      {submitError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Could not save machine</AlertTitle>
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Identity and placement</CardTitle>
          <CardDescription>
            Asset tags are generated after registration. A location may belong to another
            department.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <div className="grid gap-4 md:grid-cols-2">
              {textField('name', 'Machine name', { maxLength: 120 })}
              <SelectField
                id="machine-categoryId"
                label="Category"
                error={form.formState.errors.categoryId?.message}
                {...form.register('categoryId')}
              >
                <option value="">Select category</option>
                {categories.data?.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </SelectField>
              {textField('manufacturer', 'Manufacturer', { maxLength: 120 })}
              {textField('model', 'Model', { maxLength: 120 })}
              {textField('serialNumber', 'Serial number', { maxLength: 120 })}
              <SelectField
                id="machine-departmentId"
                label="Owning department"
                error={form.formState.errors.departmentId?.message}
                {...form.register('departmentId')}
              >
                <option value="">Select department</option>
                {departments.data?.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name} ({department.code})
                  </option>
                ))}
              </SelectField>
            </div>
            <Field>
              <FieldLabel htmlFor="location-search">Search locations</FieldLabel>
              <Input
                id="location-search"
                role="combobox"
                aria-controls="machine-locationId"
                aria-expanded="true"
                value={locationSearch}
                onChange={(event) => {
                  setLocationSearch(event.target.value);
                  setLocationPage(1);
                }}
                placeholder="Search across every department"
              />
            </Field>
            <SelectField
              id="machine-locationId"
              label="Location"
              error={form.formState.errors.locationId?.message}
              {...form.register('locationId')}
            >
              <option value="">Select location</option>
              {Object.entries(groupedLocations ?? {}).map(([department, entries]) => (
                <optgroup key={department} label={department}>
                  {entries.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </SelectField>
            {(locations.data?.total ?? 0) > (locations.data?.pageSize ?? 50) ? (
              <nav aria-label="Location choices" className="flex items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={(locations.data?.page ?? 1) <= 1}
                  onClick={() => setLocationPage((page) => Math.max(1, page - 1))}
                >
                  Previous locations
                </Button>
                <span className="text-xs text-muted-foreground">
                  Page {locations.data?.page ?? locationPage}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    (locations.data?.page ?? 1) * (locations.data?.pageSize ?? 50) >=
                    (locations.data?.total ?? 0)
                  }
                  onClick={() => setLocationPage((page) => page + 1)}
                >
                  More locations
                </Button>
              </nav>
            ) : null}
            <Field data-invalid={Boolean(form.formState.errors.description)}>
              <FieldLabel htmlFor="machine-description">Description</FieldLabel>
              <Textarea
                id="machine-description"
                maxLength={2000}
                {...form.register('description')}
              />
              <FieldError>{form.formState.errors.description?.message}</FieldError>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lifecycle and service</CardTitle>
          <CardDescription>Calendar dates are stored without timezone conversion.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {textField('purchaseDate', 'Purchase date', { type: 'date' })}
            {textField('commissionedOn', 'Commissioned date', { type: 'date' })}
            {textField('warrantyExpiresOn', 'Warranty expiry', { type: 'date' })}
            {textField('lastServicedAt', 'Last serviced at (ISO-8601 with offset)', {
              placeholder: '2026-10-26T09:00:00+03:00',
              type: 'text',
            })}
            {textField('serviceIntervalDays', 'Service interval (days)', {
              min: 1,
              max: 3650,
              type: 'number',
            })}
            <Field>
              <FieldLabel>Next service due</FieldLabel>
              <div className="flex min-h-10 items-center gap-2 rounded-md border bg-muted px-3 text-sm text-muted-foreground">
                <Calculator className="size-4" aria-hidden="true" /> Calculated automatically
              </div>
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Booking policy</CardTitle>
          <CardDescription>
            Leave an override blank to inherit the category maximum or global default. Machine
            buffer overrides replace the global default.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {(['isBookable', 'requiresApproval', 'allowBookingWhenNeedsService'] as const).map(
              (name) => (
                <SelectField
                  key={name}
                  id={`machine-${name}`}
                  label={
                    {
                      isBookable: 'Bookable',
                      requiresApproval: 'Requires approval',
                      allowBookingWhenNeedsService: 'Allow booking when needs service',
                    }[name]
                  }
                  error={form.formState.errors[name]?.message}
                  {...form.register(name)}
                >
                  {!machine ? <option value="">System default</option> : null}
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </SelectField>
              ),
            )}
            {textField('maxBookingMinutes', 'Maximum booking override (minutes)', {
              min: 5,
              max: 1440,
              type: 'number',
            })}
            {textField('bufferMinutes', 'Machine buffer override (minutes)', {
              min: 0,
              max: 240,
              type: 'number',
            })}
          </div>
          {machine ? (
            <div className="mt-4 rounded-md border p-4">
              <h3 className="font-medium">Currently effective policy</h3>
              {bookingPolicy.isPending ? (
                <p className="mt-2 text-sm text-muted-foreground" role="status">
                  Loading effective policy…
                </p>
              ) : bookingPolicy.isError ? (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-sm">
                  <p role="alert">Effective policy could not be loaded.</p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void bookingPolicy.refetch()}
                  >
                    Try again
                  </Button>
                </div>
              ) : (
                <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground">Maximum duration</dt>
                    <dd>
                      {bookingPolicy.data.maxDurationMinutes.value} minutes (
                      {bookingPolicy.data.maxDurationMinutes.source})
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Buffer</dt>
                    <dd>
                      {bookingPolicy.data.bufferMinutes.value} minutes (
                      {bookingPolicy.data.bufferMinutes.source})
                    </dd>
                  </div>
                </dl>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex flex-wrap justify-end gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            if (!form.formState.isDirty || window.confirm('Discard your unsaved changes?'))
              router.back();
          }}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
          {machine ? 'Save changes' : 'Register machine'}
        </Button>
      </div>
    </form>
  );
}
