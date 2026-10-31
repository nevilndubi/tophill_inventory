'use client';

import { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createCategorySchema, type CreateCategoryInput, type ManagedCategory } from '@app/shared';
import { Boxes, LoaderCircle, Pencil, Plus, Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
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
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { categoriesApi } from '@/lib/api/categories';
import { ApiClientError } from '@/lib/api/client';

type CategoryFormValues = {
  defaultMaxBookingMinutes: string;
  defaultServiceIntervalDays: string;
  description: string;
  name: string;
};

const emptyValues: CategoryFormValues = {
  defaultMaxBookingMinutes: '',
  defaultServiceIntervalDays: '',
  description: '',
  name: '',
};

const toInput = (values: CategoryFormValues): CreateCategoryInput => ({
  defaultMaxBookingMinutes:
    values.defaultMaxBookingMinutes === '' ? null : Number(values.defaultMaxBookingMinutes),
  defaultServiceIntervalDays:
    values.defaultServiceIntervalDays === '' ? null : Number(values.defaultServiceIntervalDays),
  description: values.description,
  name: values.name,
});

const categoryFormSchema = z
  .object({
    defaultMaxBookingMinutes: z.string(),
    defaultServiceIntervalDays: z.string(),
    description: z.string(),
    name: z.string(),
  })
  .strict()
  .transform(toInput)
  .pipe(createCategorySchema);

const valuesFor = (category: ManagedCategory): CategoryFormValues => ({
  defaultMaxBookingMinutes: category.defaultMaxBookingMinutes?.toString() ?? '',
  defaultServiceIntervalDays: category.defaultServiceIntervalDays?.toString() ?? '',
  description: category.description ?? '',
  name: category.name,
});

const friendlyError = (error: unknown): string => {
  if (!(error instanceof ApiClientError)) return 'The request could not be completed. Try again.';
  if (error.code === 'CATEGORY_NAME_TAKEN') return 'A category with this name already exists.';
  if (error.code === 'CATEGORY_IN_USE') return 'This category is still used by machines.';
  if (error.code === 'CATEGORY_NOT_FOUND') return 'This category no longer exists.';
  if (error.code === 'POLICY_CONFLICT')
    return 'The maximum booking duration cannot be shorter than the global minimum.';
  return 'The request could not be completed. Try again.';
};

const formatLimit = (value: number | null, unit: string) =>
  value === null ? 'Not set' : `${value.toLocaleString()} ${unit}`;

function CategoryForm({
  category,
  onClose,
}: {
  category: ManagedCategory | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<CategoryFormValues, unknown, CreateCategoryInput>({
    defaultValues: category ? valuesFor(category) : emptyValues,
    mode: 'onBlur',
    resolver: zodResolver(categoryFormSchema),
  });
  useEffect(() => form.reset(category ? valuesFor(category) : emptyValues), [category, form]);

  const mutation = useMutation({
    mutationFn: (input: CreateCategoryInput) =>
      category ? categoriesApi.update(category.id, input) : categoriesApi.create(input),
    onError: (error) => form.setError('name', { message: friendlyError(error) }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['categories'] });
      toast.success(category ? 'Category updated.' : 'Category created.');
      onClose();
    },
  });

  const submit = form.handleSubmit((input) => mutation.mutate(input));

  return (
    <form onSubmit={submit} noValidate>
      <FieldGroup>
        <Field data-invalid={Boolean(form.formState.errors.name)}>
          <FieldLabel htmlFor="category-name">Name</FieldLabel>
          <Input
            id="category-name"
            autoFocus
            maxLength={100}
            aria-invalid={Boolean(form.formState.errors.name)}
            aria-describedby="category-name-error"
            {...form.register('name')}
          />
          <FieldError id="category-name-error">{form.formState.errors.name?.message}</FieldError>
        </Field>
        <Field data-invalid={Boolean(form.formState.errors.description)}>
          <FieldLabel htmlFor="category-description">Description</FieldLabel>
          <Textarea
            id="category-description"
            maxLength={500}
            aria-invalid={Boolean(form.formState.errors.description)}
            aria-describedby="category-description-error"
            {...form.register('description')}
          />
          <FieldError id="category-description-error">
            {form.formState.errors.description?.message}
          </FieldError>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field data-invalid={Boolean(form.formState.errors.defaultServiceIntervalDays)}>
            <FieldLabel htmlFor="category-service-interval">
              Default service interval (days)
            </FieldLabel>
            <Input
              id="category-service-interval"
              inputMode="numeric"
              min={1}
              max={3650}
              type="number"
              aria-invalid={Boolean(form.formState.errors.defaultServiceIntervalDays)}
              aria-describedby="category-service-interval-error"
              {...form.register('defaultServiceIntervalDays')}
            />
            <FieldError id="category-service-interval-error">
              {form.formState.errors.defaultServiceIntervalDays?.message}
            </FieldError>
          </Field>
          <Field data-invalid={Boolean(form.formState.errors.defaultMaxBookingMinutes)}>
            <FieldLabel htmlFor="category-booking-limit">
              Default booking limit (minutes)
            </FieldLabel>
            <Input
              id="category-booking-limit"
              inputMode="numeric"
              min={5}
              max={1440}
              type="number"
              aria-invalid={Boolean(form.formState.errors.defaultMaxBookingMinutes)}
              aria-describedby="category-booking-limit-error"
              {...form.register('defaultMaxBookingMinutes')}
            />
            <FieldError id="category-booking-limit-error">
              {form.formState.errors.defaultMaxBookingMinutes?.message}
            </FieldError>
          </Field>
        </div>
      </FieldGroup>
      <DialogFooter className="mt-6">
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending && <LoaderCircle className="animate-spin" data-icon="inline-start" />}
          {category ? 'Save changes' : 'Create category'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function CategoryActions({
  category,
  onDelete,
  onEdit,
}: {
  category: ManagedCategory;
  onDelete: () => void;
  onEdit: () => void;
}) {
  const reasonId = `delete-reason-${category.id}`;
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {!category.is_deletable && (
        <span id={reasonId} className="text-xs text-muted-foreground">
          {category.machine_count === 0
            ? 'Referenced by archived or retired machines'
            : `In use by ${category.machine_count} active ${category.machine_count === 1 ? 'machine' : 'machines'}`}
        </span>
      )}
      <Button size="sm" variant="outline" onClick={onEdit} aria-label={`Edit ${category.name}`}>
        <Pencil data-icon="inline-start" /> Edit
      </Button>
      <Button
        size="sm"
        variant="destructive"
        disabled={!category.is_deletable}
        aria-describedby={!category.is_deletable ? reasonId : undefined}
        onClick={onDelete}
        aria-label={`Delete ${category.name}`}
      >
        <Trash2 data-icon="inline-start" /> Delete
      </Button>
    </div>
  );
}

export function CategoryManagement() {
  const queryClient = useQueryClient();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedCategory | null>(null);
  const [deleting, setDeleting] = useState<ManagedCategory | null>(null);
  const categories = useQuery({ queryFn: categoriesApi.list, queryKey: ['categories'] });
  const deletion = useMutation({
    mutationFn: (categoryId: string) => categoriesApi.delete(categoryId),
    onError: (error) => toast.error(friendlyError(error)),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['categories'] });
      setDeleting(null);
      toast.success('Category deleted.');
    },
  });

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-primary">
            Reference data
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Machine categories</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Maintain the shared categories and default service and booking policies used by
            machines.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus data-icon="inline-start" /> Add category
        </Button>
      </div>

      {categories.isError && (
        <Alert variant="destructive">
          <AlertTitle>Categories could not be loaded</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            Try again. No changes have been made.
            <Button size="sm" variant="outline" onClick={() => categories.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Categories</CardTitle>
          <CardDescription>
            Delete is available only when no machine references a category.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {categories.isLoading ? (
            <div className="space-y-3" aria-label="Loading categories">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton className="h-20 w-full" key={index} />
              ))}
            </div>
          ) : categories.data?.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <Boxes />
                <EmptyTitle>No machine categories</EmptyTitle>
                <EmptyDescription>
                  Create the first category to organise equipment.
                </EmptyDescription>
              </EmptyHeader>
              <Button onClick={openCreate}>
                <Plus data-icon="inline-start" /> Add category
              </Button>
            </Empty>
          ) : categories.data ? (
            <>
              <div className="hidden lg:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead>Service interval</TableHead>
                      <TableHead>Booking limit</TableHead>
                      <TableHead>Machines</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {categories.data.map((category) => (
                      <TableRow key={category.id}>
                        <TableCell className="font-medium">{category.name}</TableCell>
                        <TableCell className="max-w-72 text-muted-foreground">
                          {category.description ?? 'No description'}
                        </TableCell>
                        <TableCell>
                          {formatLimit(category.defaultServiceIntervalDays, 'days')}
                        </TableCell>
                        <TableCell>
                          {formatLimit(category.defaultMaxBookingMinutes, 'min')}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">{category.machine_count}</Badge>
                        </TableCell>
                        <TableCell>
                          <CategoryActions
                            category={category}
                            onEdit={() => {
                              setEditing(category);
                              setFormOpen(true);
                            }}
                            onDelete={() => setDeleting(category)}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="grid gap-4 lg:hidden">
                {categories.data.map((category) => (
                  <Card key={category.id}>
                    <CardHeader>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <CardTitle className="text-base">{category.name}</CardTitle>
                          <CardDescription>
                            {category.description ?? 'No description'}
                          </CardDescription>
                        </div>
                        <Badge variant="secondary">{category.machine_count} machines</Badge>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <dl className="grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <dt className="text-muted-foreground">Service interval</dt>
                          <dd className="font-medium">
                            {formatLimit(category.defaultServiceIntervalDays, 'days')}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-muted-foreground">Booking limit</dt>
                          <dd className="font-medium">
                            {formatLimit(category.defaultMaxBookingMinutes, 'min')}
                          </dd>
                        </div>
                      </dl>
                      <CategoryActions
                        category={category}
                        onEdit={() => {
                          setEditing(category);
                          setFormOpen(true);
                        }}
                        onDelete={() => setDeleting(category)}
                      />
                    </CardContent>
                  </Card>
                ))}
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Dialog open={formOpen} onOpenChange={(open) => (open ? setFormOpen(true) : closeForm())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : 'Add machine category'}</DialogTitle>
            <DialogDescription>
              Set category defaults. Individual machines may override them later.
            </DialogDescription>
          </DialogHeader>
          <CategoryForm category={editing} onClose={closeForm} />
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the unused category. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleting && deletion.mutate(deleting.id)}
              disabled={deletion.isPending}
            >
              {deletion.isPending && (
                <LoaderCircle className="animate-spin" data-icon="inline-start" />
              )}{' '}
              Delete category
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
