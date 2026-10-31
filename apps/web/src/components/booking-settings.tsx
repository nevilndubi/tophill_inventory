'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BOOKING_SETTINGS_DEFAULTS, type BookingSettings } from '@app/shared';
import { AlertTriangle, LoaderCircle, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { ApiClientError } from '@/lib/api/client';
import { bookingApi } from '@/lib/api/booking';

const SETTING_FIELDS = [
  {
    key: 'maxDurationMinutes',
    label: 'Maximum booking duration',
    max: 1440,
    min: 5,
    unit: 'minutes',
  },
  {
    key: 'minDurationMinutes',
    label: 'Minimum booking duration',
    max: 120,
    min: 5,
    unit: 'minutes',
  },
  { key: 'minLeadMinutes', label: 'Minimum booking lead time', max: 1440, min: 0, unit: 'minutes' },
  {
    key: 'maxAdvanceDays',
    label: 'Maximum advance booking window',
    max: 365,
    min: 1,
    unit: 'days',
  },
  {
    key: 'defaultBufferMinutes',
    label: 'Default machine buffer',
    max: 240,
    min: 0,
    unit: 'minutes',
  },
  { key: 'noShowGraceMinutes', label: 'No-show grace period', max: 120, min: 0, unit: 'minutes' },
  { key: 'adhocGuardMinutes', label: 'Ad-hoc checkout guard', max: 240, min: 0, unit: 'minutes' },
] as const;
type SettingKey = (typeof SETTING_FIELDS)[number]['key'];
type FormValues = Record<SettingKey, string>;

const toFormValues = (settings: Pick<BookingSettings, SettingKey>): FormValues =>
  Object.fromEntries(SETTING_FIELDS.map(({ key }) => [key, String(settings[key])])) as FormValues;

const friendlyError = (error: unknown): string => {
  if (!(error instanceof ApiClientError)) return 'Settings could not be saved. Try again.';
  if (error.code === 'SETTINGS_CHANGED')
    return 'These settings changed elsewhere. Reload the latest values before saving.';
  if (error.code === 'POLICY_CONFLICT')
    return 'The minimum duration cannot exceed a saved machine or category maximum.';
  if (error.code === 'SETTINGS_INVALID')
    return 'Booking settings are temporarily unavailable. Try again later.';
  return 'Settings could not be saved. Try again.';
};

export function BookingSettingsManagement() {
  const client = useQueryClient();
  const query = useQuery({
    queryFn: bookingApi.settings,
    queryKey: ['booking-settings'],
  });
  const [values, setValues] = useState<FormValues | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const mutation = useMutation({
    mutationFn: (current: BookingSettings) =>
      bookingApi.updateSettings({
        ...Object.fromEntries(SETTING_FIELDS.map(({ key }) => [key, Number(values?.[key])])),
        expectedUpdatedAt: current.updatedAt,
      }),
    onError: (error) => toast.error(friendlyError(error)),
    onSuccess: async (settings) => {
      setValues(toFormValues(settings));
      client.setQueryData(['booking-settings'], settings);
      toast.success('Booking settings saved.');
    },
  });
  if (query.isPending) return <p role="status">Loading booking settings…</p>;
  if (query.isError || !query.data)
    return (
      <Alert variant="destructive" role="alert">
        <AlertTriangle aria-hidden="true" />
        <AlertTitle>Booking settings unavailable</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          Could not load the current settings.
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );

  const currentValues = values ?? toFormValues(query.data);
  const hasInvalidInput = SETTING_FIELDS.some(({ key, max, min }) => {
    const value = Number(currentValues[key]);
    return (
      currentValues[key].trim() === '' || !Number.isInteger(value) || value < min || value > max
    );
  });

  return (
    <div className="space-y-6">
      {mutation.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Could not save booking settings</AlertTitle>
          <AlertDescription>{friendlyError(mutation.error)}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>Global booking and checkout rules</CardTitle>
          <CardDescription>
            Machine and category maximums can make booking duration shorter. Changes take effect
            immediately; existing bookings are not modified.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {SETTING_FIELDS.map(({ key, label, max, min, unit }) => (
              <Field
                key={key}
                data-invalid={
                  currentValues[key].trim() === '' ||
                  !Number.isInteger(Number(currentValues[key])) ||
                  Number(currentValues[key]) < min ||
                  Number(currentValues[key]) > max
                }
              >
                <FieldLabel htmlFor={`booking-setting-${key}`}>
                  {label} ({unit})
                </FieldLabel>
                <Input
                  id={`booking-setting-${key}`}
                  type="number"
                  min={min}
                  max={max}
                  step={1}
                  inputMode="numeric"
                  aria-describedby={`booking-setting-${key}-hint`}
                  value={currentValues[key]}
                  onChange={(event) => {
                    setValues((before) => ({
                      ...(before ?? toFormValues(query.data)),
                      [key]: event.target.value,
                    }));
                  }}
                />
                <p id={`booking-setting-${key}-hint`} className="text-xs text-muted-foreground">
                  Allowed range: {min}–{max} {unit}.
                </p>
                {currentValues[key].trim() === '' ? (
                  <FieldError>Enter a whole number.</FieldError>
                ) : !Number.isInteger(Number(currentValues[key])) ||
                  Number(currentValues[key]) < min ||
                  Number(currentValues[key]) > max ? (
                  <FieldError>
                    Enter a whole number from {min} to {max}.
                  </FieldError>
                ) : null}
              </Field>
            ))}
          </div>
          <div className="mt-6 flex flex-wrap justify-end gap-3">
            <Button type="button" variant="outline" onClick={() => setResetOpen(true)}>
              <RotateCcw aria-hidden="true" />
              Reset fields to defaults
            </Button>
            <Button
              type="button"
              disabled={hasInvalidInput || mutation.isPending || values === null}
              onClick={() => mutation.mutate(query.data)}
            >
              {mutation.isPending ? (
                <LoaderCircle className="animate-spin" aria-hidden="true" />
              ) : null}
              Save settings
            </Button>
          </div>
        </CardContent>
      </Card>
      <AlertDialog open={resetOpen} onOpenChange={setResetOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset booking settings?</AlertDialogTitle>
            <AlertDialogDescription>
              This replaces the form values with the system defaults. Save settings to apply them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setValues(toFormValues(BOOKING_SETTINGS_DEFAULTS));
                setResetOpen(false);
              }}
            >
              Reset fields
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
