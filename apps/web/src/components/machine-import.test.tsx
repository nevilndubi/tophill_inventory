import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MachineImportReport } from '@app/shared';
import { MachineImport } from './machine-import';

const mocks = vi.hoisted(() => ({ importCsv: vi.fn(), template: vi.fn() }));

vi.mock('@/lib/api/machines', () => ({
  machinesApi: { importCsv: mocks.importCsv, template: mocks.template },
}));

const report: MachineImportReport = {
  can_commit: false,
  committed_count: 0,
  file_sha256: 'a'.repeat(64),
  mode: 'dry_run',
  rows: [
    {
      errors: [],
      preview: { manufacturer: 'acme', name: 'Ventilator', serial_number: 'sn-1' },
      row: 2,
      status: 'create',
      warnings: [],
    },
    {
      errors: [
        { code: 'IMPORT_FIELD_INVALID', field: 'purchase_date', message: 'Expected YYYY-MM-DD' },
      ],
      preview: { manufacturer: 'acme', name: 'Monitor', serial_number: 'sn-2' },
      row: 3,
      status: 'rejected',
      warnings: [],
    },
  ],
  summary: {
    create: 1,
    rejected: 1,
    skipped_conflict: 0,
    skipped_existing: 0,
    skipped_existing_deleted: 0,
  },
  template_version: 'v1',
};

describe('MachineImport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.importCsv.mockResolvedValue(report);
    mocks.template.mockResolvedValue(new Blob(['header']));
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn(() => 'blob:download'),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
  });

  it('downloads the versioned template and example separately', async () => {
    render(<MachineImport />);
    await userEvent.click(screen.getByRole('button', { name: /Download template/i }));
    await userEvent.click(screen.getByRole('button', { name: /Download three-row example/i }));
    expect(mocks.template).toHaveBeenNthCalledWith(1, 'template');
    expect(mocks.template).toHaveBeenNthCalledWith(2, 'example');
  });

  it('validates a cleanly selected CSV and renders rejected rows first', async () => {
    render(<MachineImport />);
    const file = new File(['name,category'], 'machines.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Choose machine import CSV'), {
      target: { files: [file] },
    });
    await userEvent.click(screen.getByRole('button', { name: /Preview and validate/i }));
    await waitFor(() => expect(mocks.importCsv).toHaveBeenCalledWith(file, 'dry_run', undefined));
    expect(screen.getByText('Monitor')).toBeInTheDocument();
    expect(screen.getByText(/Expected YYYY-MM-DD/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Import all rows/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Import valid rows/i })).toBeEnabled();
  });

  it('binds commit to the previewed SHA-256 and prevents double submission', async () => {
    const clean = {
      ...report,
      can_commit: true,
      rows: [report.rows[0]!],
      summary: { ...report.summary, rejected: 0 },
    };
    mocks.importCsv
      .mockResolvedValueOnce(clean)
      .mockImplementation(
        async () =>
          new Promise<MachineImportReport>((resolve) =>
            setTimeout(() => resolve({ ...clean, committed_count: 1, mode: 'commit' }), 5),
          ),
      );
    render(<MachineImport />);
    const file = new File(['content'], 'machines.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('Choose machine import CSV'), {
      target: { files: [file] },
    });
    await userEvent.click(screen.getByRole('button', { name: /Preview and validate/i }));
    const commit = await screen.findByRole('button', { name: /Import all rows/i });
    await userEvent.click(commit);
    expect(commit).toBeDisabled();
    await waitFor(() =>
      expect(mocks.importCsv).toHaveBeenLastCalledWith(file, 'commit', clean.file_sha256),
    );
  });

  it('rejects non-CSV and files over one MiB before calling the API', () => {
    render(<MachineImport />);
    const input = screen.getByLabelText('Choose machine import CSV');
    fireEvent.change(input, { target: { files: [new File(['x'], 'machines.xlsx')] } });
    expect(screen.getByText(/Choose a .csv file/i)).toBeInTheDocument();
    const oversized = new File(['x'], 'machines.csv');
    Object.defineProperty(oversized, 'size', { value: 1_048_577 });
    fireEvent.change(input, { target: { files: [oversized] } });
    expect(screen.getByText(/exceeds the 1 MiB/i)).toBeInTheDocument();
    expect(mocks.importCsv).not.toHaveBeenCalled();
  });
});
