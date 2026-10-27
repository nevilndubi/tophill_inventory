'use client';

import { useMemo, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ArrowLeft, Printer, Ruler, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { MachineLabel, TestPrintCell } from '@/components/machine-label';
import { PrintOriginWarning } from '@/components/print-origin-warning';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { publicEnv } from '@/env/public';
import {
  clearLabelSelection,
  getLabelSelectionSnapshot,
  getServerLabelSelectionSnapshot,
  subscribeLabelSelection,
  type LabelMachine,
} from '@/lib/machines/asset-labels';

const chunksOf = (machines: readonly LabelMachine[], size: number): LabelMachine[][] => {
  const chunks: LabelMachine[][] = [];
  for (let index = 0; index < machines.length; index += size) {
    chunks.push(machines.slice(index, index + size));
  }
  return chunks;
};

export function BulkMachineLabels() {
  const machines = useSyncExternalStore(
    subscribeLabelSelection,
    getLabelSelectionSnapshot,
    getServerLabelSelectionSnapshot,
  );
  const [topOffset, setTopOffset] = useState(0);
  const [testPrint, setTestPrint] = useState(false);
  const sheets = useMemo(() => chunksOf(machines, 24), [machines]);

  const clear = () => {
    clearLabelSelection();
  };

  return (
    <div className="space-y-6">
      <div className="print-controls flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2">
            <Link href="/machines">
              <ArrowLeft aria-hidden="true" /> Back to machines
            </Link>
          </Button>
          <h1 className="text-3xl font-semibold tracking-tight">Bulk asset labels</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            A4 preset: 3 columns × 8 rows per sheet, up to 48 selected machines.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" onClick={() => setTestPrint((value) => !value)}>
            <Ruler aria-hidden="true" /> {testPrint ? 'Use selected labels' : 'Test print'}
          </Button>
          <Button type="button" variant="outline" onClick={clear} disabled={machines.length === 0}>
            <Trash2 aria-hidden="true" /> Clear selection
          </Button>
          <Button
            type="button"
            onClick={() => window.print()}
            disabled={!testPrint && machines.length === 0}
          >
            <Printer aria-hidden="true" /> Print {testPrint ? 'test sheet' : 'labels'}
          </Button>
        </div>
      </div>
      <PrintOriginWarning origin={publicEnv.NEXT_PUBLIC_APP_ORIGIN} />
      <div className="print-controls grid gap-4 rounded-lg border bg-card p-4 md:grid-cols-[12rem_1fr] md:items-end">
        <label className="grid gap-1 text-sm font-medium" htmlFor="label-top-offset">
          Top offset (mm)
          <Input
            id="label-top-offset"
            type="number"
            min={-5}
            max={5}
            step={0.5}
            value={topOffset}
            onChange={(event) =>
              setTopOffset(Math.max(-5, Math.min(5, Number(event.target.value) || 0)))
            }
          />
        </label>
        <p className="text-sm text-muted-foreground">
          Calibrate with Test print first. Print at 100% scale, disable “Fit to page”, and compare
          the 70 mm × 37 mm cells against a ruler.
        </p>
      </div>

      {!testPrint && machines.length === 0 ? (
        <Empty className="print-controls">
          <EmptyHeader>
            <EmptyTitle>No machines selected</EmptyTitle>
            <EmptyDescription>
              Return to Machines and select individual rows, this page, or up to 48 matching
              machines.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}

      <div
        className="label-sheet-stack space-y-8 overflow-auto"
        style={{ '--label-top-offset': `${topOffset}mm` } as CSSProperties}
      >
        {testPrint ? (
          <section className="label-sheet label-sheet--test" aria-label="A4 label alignment test">
            {Array.from({ length: 24 }, (_, index) => (
              <TestPrintCell key={index} index={index} />
            ))}
          </section>
        ) : (
          sheets.map((sheet, sheetIndex) => (
            <section
              className="label-sheet"
              aria-label={`Asset label sheet ${sheetIndex + 1}`}
              key={sheet[0]?.id ?? sheetIndex}
            >
              {sheet.map((machine) => (
                <MachineLabel
                  appOrigin={publicEnv.NEXT_PUBLIC_APP_ORIGIN}
                  key={machine.id}
                  machine={machine}
                  preset="sheet"
                />
              ))}
            </section>
          ))
        )}
      </div>
      {machines.length > 0 && !testPrint ? (
        <Alert className="print-controls">
          <AlertTitle>{machines.length} labels selected</AlertTitle>
          <AlertDescription>
            The selection is stored only for this browser session and clears when you sign out.
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
