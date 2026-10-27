'use client';

import { useMemo, useRef, useState } from 'react';
import {
  csvRow,
  MACHINE_IMPORT_HEADERS,
  MACHINE_IMPORT_MAX_BYTES,
  protectSpreadsheetCell,
  type MachineImportMode,
  type MachineImportReport,
  type MachineImportRowStatus,
} from '@app/shared';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiClientError } from '@/lib/api/client';
import { machinesApi } from '@/lib/api/machines';

const PAGE_SIZE = 25;
const statusLabels: Record<MachineImportRowStatus, string> = {
  create: 'Ready to create',
  rejected: 'Rejected',
  skipped_conflict: 'Skipped after conflict',
  skipped_existing: 'Already exists',
  skipped_existing_deleted: 'Exists but removed',
};

const saveBlob = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
};

const friendlyError = (error: unknown): string => {
  if (!(error instanceof ApiClientError)) return 'The file could not be processed. Try again.';
  const messages: Record<string, string> = {
    IMPORT_DUPLICATE_HEADERS: 'The file contains duplicate column headings.',
    IMPORT_FILE_CHANGED: 'The file changed after preview. Preview it again before importing.',
    IMPORT_FILE_TOO_LARGE: 'The file exceeds the 1 MiB limit.',
    IMPORT_INVALID_CSV: 'Use a comma-delimited CSV UTF-8 file and check its quotes.',
    IMPORT_INVALID_HEADERS: 'Use the current machine import template without changing its columns.',
    IMPORT_INVALID_ROWS: 'Resolve the rejected rows before using full import.',
    IMPORT_TOO_MANY_ROWS: 'The file contains more than 1,000 data rows.',
  };
  return messages[error.code] ?? error.message;
};

export function MachineImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<MachineImportReport | null>(null);
  const [busy, setBusy] = useState<MachineImportMode | 'download' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<'all' | MachineImportRowStatus>('all');
  const [page, setPage] = useState(1);

  const rows = useMemo(
    () => report?.rows.filter((row) => status === 'all' || row.status === status) ?? [],
    [report, status],
  );
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const visible = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const selectFile = (selected: File | undefined) => {
    setError(null);
    setReport(null);
    setPage(1);
    if (!selected) return;
    if (selected.size > MACHINE_IMPORT_MAX_BYTES) {
      setFile(null);
      setError('The file exceeds the 1 MiB limit.');
      return;
    }
    if (!selected.name.toLocaleLowerCase('en').endsWith('.csv')) {
      setFile(null);
      setError('Choose a .csv file exported as CSV UTF-8 (Comma delimited).');
      return;
    }
    setFile(selected);
  };

  const run = async (mode: MachineImportMode) => {
    if (!file) return;
    setBusy(mode);
    setError(null);
    try {
      const next = await machinesApi.importCsv(
        file,
        mode,
        mode === 'dry_run' ? undefined : report?.file_sha256,
      );
      setReport(next);
      setStatus(next.summary.rejected > 0 ? 'rejected' : 'all');
      setPage(1);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(null);
    }
  };

  const download = async (kind: 'example' | 'template') => {
    setBusy('download');
    setError(null);
    try {
      saveBlob(await machinesApi.template(kind), `machine-import-${kind}-v1.csv`);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(null);
    }
  };

  const downloadReport = () => {
    if (!report) return;
    const output = [
      csvRow(['row', 'status', ...MACHINE_IMPORT_HEADERS, 'error']),
      ...report.rows
        .filter((row) => row.status === 'rejected')
        .map((row) =>
          csvRow([
            String(row.row),
            row.status,
            ...MACHINE_IMPORT_HEADERS.map((header) =>
              protectSpreadsheetCell(String(row.preview[header] ?? '')),
            ),
            row.errors.map((item) => `${item.field}: ${item.message}`).join('; '),
          ]),
        ),
    ].join('\r\n');
    saveBlob(
      new Blob([`${output}\r\n`], { type: 'text/csv;charset=utf-8' }),
      'machine-import-errors.csv',
    );
  };

  return (
    <div className="space-y-6">
      <div>
        <p className="text-sm font-medium text-primary">Inventory registry</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Import machines</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
          Preview up to 1,000 machines before anything is written. The server validates the original
          file again when you confirm the import.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Import could not continue</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Card>
          <CardHeader>
            <CardTitle>1. Choose a CSV file</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <button
              type="button"
              className={`flex min-h-48 w-full flex-col items-center justify-center rounded-xl border-2 border-dashed p-6 text-center transition ${dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/60'}`}
              onClick={() => inputRef.current?.click()}
              onDragEnter={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                selectFile(event.dataTransfer.files[0]);
              }}
            >
              <Upload className="mb-3 size-8 text-primary" aria-hidden="true" />
              <span className="font-medium">Drop a CSV here or choose a file</span>
              <span className="mt-1 text-sm text-muted-foreground">
                CSV UTF-8, comma-delimited, maximum 1 MiB
              </span>
            </button>
            <input
              ref={inputRef}
              suppressHydrationWarning
              className="sr-only"
              type="file"
              accept=".csv,text/csv"
              aria-label="Choose machine import CSV"
              onChange={(event) => selectFile(event.target.files?.[0])}
            />
            {file ? (
              <p className="text-sm">
                <FileSpreadsheet className="mr-2 inline size-4" aria-hidden="true" />
                {file.name} · {Math.ceil(file.size / 1024)} KiB
              </p>
            ) : null}
            <Button disabled={!file || busy !== null} onClick={() => void run('dry_run')}>
              {busy === 'dry_run' ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Preview and validate
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Preparing your file</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              Use the versioned template. Keep dates as{' '}
              <strong className="text-foreground">YYYY-MM-DD</strong>.
            </p>
            <p>
              Format serial-number cells as Text in Excel. This preserves leading zeros and prevents
              scientific notation.
            </p>
            <p>
              Locations are resolved using both location department and location name. This can
              differ from the machine owner department.
            </p>
            <div className="flex flex-col gap-2 pt-2">
              <Button
                variant="outline"
                onClick={() => void download('template')}
                disabled={busy !== null}
              >
                <Download aria-hidden="true" />
                Download template
              </Button>
              <Button
                variant="ghost"
                onClick={() => void download('example')}
                disabled={busy !== null}
              >
                <Download aria-hidden="true" />
                Download three-row example
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {report ? (
        <Card>
          <CardHeader>
            <CardTitle>2. Validation report</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div
              className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
              aria-label="Import summary"
            >
              {Object.entries(report.summary).map(([key, count]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setStatus(key as MachineImportRowStatus);
                    setPage(1);
                  }}
                  className="rounded-lg border p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="block text-2xl font-semibold">{count}</span>
                  <span className="text-xs text-muted-foreground">
                    {statusLabels[key as MachineImportRowStatus]}
                  </span>
                </button>
              ))}
            </div>
            {report.committed_count > 0 ? (
              <Alert>
                <CheckCircle2 aria-hidden="true" />
                <AlertTitle>Import completed</AlertTitle>
                <AlertDescription>
                  {report.committed_count} machines were registered with generated asset tags and
                  initial history.
                </AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-sm">
                Show{' '}
                <select
                  className="h-9 rounded-md border bg-background px-2"
                  value={status}
                  onChange={(event) => {
                    setStatus(event.target.value as typeof status);
                    setPage(1);
                  }}
                >
                  <option value="all">All rows</option>
                  {Object.entries(statusLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {report.summary.rejected > 0 ? (
                <Button variant="outline" onClick={downloadReport}>
                  <Download aria-hidden="true" />
                  Download rejected-row report
                </Button>
              ) : null}
            </div>
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[48rem] text-sm">
                <caption className="sr-only">Machine import validation rows</caption>
                <thead className="bg-muted/50 text-left">
                  <tr>
                    <th className="p-3">Row</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Name</th>
                    <th className="p-3">Manufacturer / serial</th>
                    <th className="p-3">Messages</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.row} className="border-t align-top">
                      <td className="p-3 font-mono">{row.row}</td>
                      <td className="p-3">{statusLabels[row.status]}</td>
                      <td className="p-3">{String(row.preview.name ?? '')}</td>
                      <td className="p-3">
                        {String(row.preview.manufacturer ?? '')}
                        <br />
                        <span className="text-muted-foreground">
                          {String(row.preview.serial_number ?? '')}
                        </span>
                      </td>
                      <td className="p-3">
                        <ul className="space-y-1">
                          {[...row.errors, ...row.warnings].map((item, index) => (
                            <li
                              key={`${item.code}-${index}`}
                              className={
                                row.errors.includes(item)
                                  ? 'text-destructive'
                                  : 'text-amber-700 dark:text-amber-300'
                              }
                            >
                              {item.field}: {item.message}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <nav
              className="flex items-center justify-between"
              aria-label="Import preview pagination"
            >
              <Button
                variant="outline"
                disabled={page === 1}
                onClick={() => setPage((value) => value - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {pageCount}
              </span>
              <Button
                variant="outline"
                disabled={page >= pageCount}
                onClick={() => setPage((value) => value + 1)}
              >
                Next
              </Button>
            </nav>
            {report.committed_count === 0 ? (
              <div className="rounded-lg border bg-muted/30 p-4">
                <h2 className="font-semibold">3. Confirm import</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Full import is atomic. Import valid rows commits only accepted rows and reports
                  concurrent duplicates as skipped.
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    disabled={!report.can_commit || busy !== null}
                    onClick={() => void run('commit')}
                  >
                    {busy === 'commit' ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : null}
                    Import all rows
                  </Button>
                  <Button
                    variant="outline"
                    disabled={report.summary.create === 0 || busy !== null}
                    onClick={() => void run('partial')}
                  >
                    {busy === 'partial' ? (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    ) : null}
                    Import valid rows
                  </Button>
                </div>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
