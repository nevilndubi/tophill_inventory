import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MachineAttachments } from './machine-attachments';

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  delete: vi.fn(),
  download: vi.fn(),
  list: vi.fn(),
  requestUpload: vi.fn(),
  role: 'ADMIN',
  upload: vi.fn(),
}));

vi.mock('./authenticated-user-provider', () => ({
  useAuthenticatedUser: () => ({ user: { role: mocks.role } }),
}));
vi.mock('@/lib/api/attachments', () => ({
  attachmentsApi: {
    confirm: mocks.confirm,
    delete: mocks.delete,
    download: mocks.download,
    list: mocks.list,
    requestUpload: mocks.requestUpload,
  },
  uploadToSignedUrl: mocks.upload,
}));

const attachment = {
  fileName: 'Ventilator manual.pdf',
  id: '11111111-1111-4111-8111-111111111111',
  sizeBytes: 2048,
  typeLabel: 'PDF document',
  uploadedAt: '2026-10-27T10:00:00.000Z',
  uploader: { fullName: 'Test technician' },
};

const renderPanel = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MachineAttachments machineId="22222222-2222-4222-8222-222222222222" />
    </QueryClientProvider>,
  );
};

describe('MachineAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.role = 'ADMIN';
    mocks.list.mockResolvedValue([attachment]);
    mocks.download.mockResolvedValue({
      expiresAt: '2026-10-27T10:05:00.000Z',
      url: 'https://storage.test/signed-redacted',
    });
    mocks.requestUpload.mockResolvedValue({
      expiresAt: '2026-10-27T10:15:00.000Z',
      intentToken: 'intent-redacted',
      uploadUrl: 'https://storage.test/upload-redacted',
    });
    mocks.upload.mockImplementation(
      async (_url: string, _file: File, progress: (value: { percent: number }) => void) => {
        progress({ percent: 100 });
      },
    );
    mocks.confirm.mockResolvedValue(attachment);
    mocks.delete.mockResolvedValue(attachment);
    vi.stubGlobal('open', vi.fn());
  });

  it('shows minimized metadata, private-download action and mutation controls for approved roles', async () => {
    renderPanel();
    expect(await screen.findByText(attachment.fileName)).toBeInTheDocument();
    expect(screen.getByText(/PDF document · 2.0 MiB|PDF document · 2 KiB/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add file' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Open PDF' }));
    expect(mocks.download).toHaveBeenCalledWith(attachment.id);
    expect(window.open).toHaveBeenCalledWith(
      'https://storage.test/signed-redacted',
      '_blank',
      'noopener,noreferrer',
    );
  });

  it.each(['SUPER_ADMIN', 'ADMIN', 'BIOMED_TECH'])(
    'allows %s to upload and delete',
    async (role) => {
      mocks.role = role;
      renderPanel();
      expect(await screen.findByRole('button', { name: 'Add file' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    },
  );

  it.each(['DEPT_MANAGER', 'STAFF', 'VIEWER'])('keeps %s read-only', async (role) => {
    mocks.role = role;
    renderPanel();
    expect(await screen.findByText(/read-only access/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add file' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('rejects wrong types and oversized files before requesting an upload', async () => {
    renderPanel();
    const input = await screen.findByLabelText('Choose attachment');
    fireEvent.change(input, {
      target: { files: [new File(['plain'], 'fake.png', { type: 'text/plain' })] },
    });
    expect(await screen.findByText(/Choose a JPEG, PNG, WebP or PDF/i)).toBeInTheDocument();
    expect(mocks.requestUpload).not.toHaveBeenCalled();

    const oversized = new File(['x'], 'large.png', { type: 'image/png' });
    Object.defineProperty(oversized, 'size', { value: 10 * 1024 * 1024 + 1 });
    fireEvent.change(input, { target: { files: [oversized] } });
    expect(await screen.findByText(/no larger than 10 MiB/i)).toBeInTheDocument();
    expect(mocks.requestUpload).not.toHaveBeenCalled();
  });

  it('uploads directly, confirms once and refreshes the metadata list', async () => {
    mocks.list.mockResolvedValue([]);
    renderPanel();
    const input = await screen.findByLabelText('Choose attachment');
    const file = new File(['%PDF-1.7'], '../manual.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() =>
      expect(mocks.confirm).toHaveBeenCalledWith({ intentToken: 'intent-redacted' }),
    );
    expect(mocks.requestUpload).toHaveBeenCalledWith(
      '22222222-2222-4222-8222-222222222222',
      expect.objectContaining({ mimeType: 'application/pdf', sizeBytes: file.size }),
    );
    expect(mocks.upload).toHaveBeenCalledWith(
      'https://storage.test/upload-redacted',
      file,
      expect.any(Function),
      expect.any(AbortSignal),
    );
  });
});
