import encodeQR from 'qr';
import {
  MACHINE_CONDITIONS,
  machineAssetTagSchema,
  type ManagedMachine,
  type MachineCondition,
} from '@app/shared';
import { z } from 'zod';
import { applicationOriginSchema } from '@/env/schema';

export const MAX_LABEL_SELECTION = 48;
export const LABEL_SELECTION_STORAGE_KEY = 'tophill:machine-label-selection:v1';
const EMPTY_LABEL_SELECTION: LabelMachine[] = [];
const selectionListeners = new Set<() => void>();
let selectionSnapshot: LabelMachine[] | null = null;

const labelMachineSchema = z
  .object({
    assetTag: machineAssetTagSchema,
    condition: z.enum(MACHINE_CONDITIONS),
    department: z.object({ code: z.string(), id: z.uuid(), name: z.string() }).strict(),
    id: z.uuid(),
    location: z.object({ id: z.uuid(), name: z.string() }).strict(),
    name: z.string().min(1).max(120),
    registryStatus: z.literal('ACTIVE'),
  })
  .strict();

export type LabelMachine = {
  assetTag: string;
  condition: MachineCondition;
  department: { code: string; id: string; name: string };
  id: string;
  location: { id: string; name: string };
  name: string;
  registryStatus: 'ACTIVE';
};

export const toLabelMachine = (machine: ManagedMachine): LabelMachine =>
  labelMachineSchema.parse({
    assetTag: machine.assetTag,
    condition: machine.condition,
    department: machine.department,
    id: machine.id,
    location: machine.location,
    name: machine.name,
    registryStatus: machine.registryStatus,
  });

export const buildCanonicalAssetUrl = (origin: string, rawAssetTag: string): string => {
  const parsedOrigin = applicationOriginSchema.parse(origin);
  const assetTag = machineAssetTagSchema.parse(rawAssetTag);
  return `${parsedOrigin}/scan/${assetTag}`;
};

export const displayAppOrigin = (origin: string): string =>
  applicationOriginSchema.parse(origin).replace(/^https?:\/\//u, '');

export const needsPrintOriginWarning = (origin: string): boolean => {
  const url = new URL(applicationOriginSchema.parse(origin));
  return url.protocol !== 'https:' || url.hostname === 'localhost';
};

export const createQrMatrix = (payload: string): boolean[][] =>
  encodeQR(payload, 'raw', { border: 4, ecc: 'medium' });

export const qrMatrixPath = (matrix: readonly (readonly boolean[])[]): string => {
  const commands: string[] = [];
  matrix.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) commands.push(`M${x} ${y}h1v1h-1z`);
    });
  });
  return commands.join('');
};

export const isLabelSelectable = (
  machine: Pick<ManagedMachine, 'condition' | 'registryStatus'>,
): boolean => machine.condition !== 'RETIRED' && machine.registryStatus === 'ACTIVE';

export const readLabelSelection = (): LabelMachine[] => {
  if (typeof window === 'undefined') return [];
  if (selectionSnapshot !== null) return selectionSnapshot;
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(LABEL_SELECTION_STORAGE_KEY) ?? '[]');
    const parsed = z.array(labelMachineSchema).max(MAX_LABEL_SELECTION).safeParse(value);
    selectionSnapshot = parsed.success ? parsed.data : [];
  } catch {
    selectionSnapshot = [];
  }
  return selectionSnapshot;
};

export const subscribeLabelSelection = (listener: () => void): (() => void) => {
  selectionListeners.add(listener);
  return () => selectionListeners.delete(listener);
};

export const getLabelSelectionSnapshot = (): LabelMachine[] => readLabelSelection();
export const getServerLabelSelectionSnapshot = (): LabelMachine[] => EMPTY_LABEL_SELECTION;

export const writeLabelSelection = (machines: readonly LabelMachine[]): LabelMachine[] => {
  const unique = [...new Map(machines.map((machine) => [machine.id, machine])).values()].slice(
    0,
    MAX_LABEL_SELECTION,
  );
  const parsed = z.array(labelMachineSchema).max(MAX_LABEL_SELECTION).parse(unique);
  if (typeof window !== 'undefined') {
    sessionStorage.setItem(LABEL_SELECTION_STORAGE_KEY, JSON.stringify(parsed));
  }
  selectionSnapshot = parsed;
  selectionListeners.forEach((listener) => listener());
  return parsed;
};

export const clearLabelSelection = (): void => {
  if (typeof window !== 'undefined') sessionStorage.removeItem(LABEL_SELECTION_STORAGE_KEY);
  selectionSnapshot = [];
  selectionListeners.forEach((listener) => listener());
};
