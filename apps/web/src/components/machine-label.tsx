'use client';

import { AssetQrCode } from '@/components/asset-qr-code';
import type { LabelMachine } from '@/lib/machines/asset-labels';
import { displayAppOrigin } from '@/lib/machines/asset-labels';
import { cn } from '@/lib/utils';

export function MachineLabel({
  appOrigin,
  machine,
  preset,
}: {
  appOrigin: string;
  machine: LabelMachine;
  preset: 'sheet' | 'single';
}) {
  const scanFallback = `Can't scan? Open ${displayAppOrigin(appOrigin)}/scan and enter the tag above`;
  return (
    <article
      className={cn(
        'machine-label grid overflow-hidden border-2 border-black bg-white text-black',
        preset === 'single' ? 'machine-label--single' : 'machine-label--sheet',
      )}
      data-label-preset={preset}
    >
      <AssetQrCode
        appOrigin={appOrigin}
        assetTag={machine.assetTag}
        className="machine-label__qr block bg-white"
      />
      <div className="machine-label__copy min-w-0">
        <p className="machine-label__tag font-mono font-black tabular-nums">{machine.assetTag}</p>
        <h2 className="machine-label__name font-bold">{machine.name}</h2>
        <p className="machine-label__fallback">{scanFallback}</p>
      </div>
    </article>
  );
}

export function TestPrintCell({ index }: { index: number }) {
  return (
    <div className="machine-label machine-label--sheet machine-label--test border border-dashed border-black bg-white p-2 text-black">
      <p className="font-mono text-lg font-black tabular-nums">
        HM-{String(index + 1).padStart(6, '0')}
      </p>
      <p className="mt-1 text-xs">Alignment test — cell {index + 1}</p>
    </div>
  );
}
