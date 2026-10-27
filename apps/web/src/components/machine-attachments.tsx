'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MIME_TYPES,
  can,
  type ManagedMachineAttachment,
} from '@app/shared';
import { FileText, ImageIcon, LoaderCircle, Trash2, Upload, X } from 'lucide-react';
import { useAuthenticatedUser } from '@/components/authenticated-user-provider';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiClientError } from '@/lib/api/client';
import { attachmentsApi, uploadToSignedUrl } from '@/lib/api/attachments';
import { formatNairobiDateTime } from '@/lib/machines/formatting';

const isImage = (attachment: ManagedMachineAttachment) => attachment.typeLabel !== 'PDF document';
const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(bytes / 1024))} KiB`;

const friendlyError = (error: unknown): string => {
  if (!(error instanceof ApiClientError)) return 'The attachment operation could not be completed.';
  const messages: Record<string, string> = {
    ATTACHMENT_CONFIRMATION_CONFLICT: 'This upload can no longer be confirmed. Try again.',
    ATTACHMENT_INVALID_CONTENT: 'The file contents do not match the selected file type.',
    ATTACHMENT_INVALID_TYPE: 'Choose a JPEG, PNG, WebP or PDF file.',
    ATTACHMENT_LIMIT_REACHED: 'This machine already has the maximum of 20 attachments.',
    ATTACHMENT_OBJECT_MISSING: 'The uploaded file could not be found. Try again.',
    ATTACHMENT_SIZE_MISMATCH: 'The uploaded file size changed. Try again.',
    ATTACHMENT_TOO_LARGE: 'Choose a file no larger than 10 MiB.',
    ATTACHMENT_UPLOAD_EXPIRED: 'The upload took too long to confirm. Try again.',
    MACHINE_NOT_FOUND: 'This machine is no longer in the active registry.',
    STORAGE_UNAVAILABLE: 'File storage is temporarily unavailable. Try again shortly.',
  };
  return messages[error.code] ?? 'The attachment operation could not be completed.';
};

function AttachmentPreview({ attachment }: { attachment: ManagedMachineAttachment }) {
  const download = useQuery({
    enabled: isImage(attachment),
    queryFn: () => attachmentsApi.download(attachment.id),
    queryKey: ['attachment-url', attachment.id],
    refetchInterval: 4 * 60 * 1000,
    staleTime: 4 * 60 * 1000,
  });
  if (!isImage(attachment)) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center rounded-md bg-muted">
        <FileText className="size-12 text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }
  if (download.isPending) return <Skeleton className="aspect-[4/3] w-full" />;
  if (download.isError) {
    return (
      <div className="flex aspect-[4/3] items-center justify-center rounded-md bg-muted text-sm text-muted-foreground">
        Preview unavailable
      </div>
    );
  }
  return (
    <Image
      alt={attachment.fileName}
      className="aspect-[4/3] w-full rounded-md object-cover"
      height={240}
      src={download.data.url}
      unoptimized
      width={320}
    />
  );
}

function AttachmentCard({
  attachment,
  canDelete,
  onDelete,
  deleting,
}: {
  attachment: ManagedMachineAttachment;
  canDelete: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const [opening, setOpening] = useState(false);
  const open = async () => {
    setOpening(true);
    try {
      const signed = await attachmentsApi.download(attachment.id);
      window.open(signed.url, '_blank', 'noopener,noreferrer');
    } finally {
      setOpening(false);
    }
  };
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <AttachmentPreview attachment={attachment} />
        <div className="min-w-0">
          <p className="truncate font-medium" title={attachment.fileName}>
            {attachment.fileName}
          </p>
          <p className="text-sm text-muted-foreground">
            {attachment.typeLabel} · {formatBytes(attachment.sizeBytes)}
          </p>
          <p className="text-xs text-muted-foreground">
            Uploaded {formatNairobiDateTime(attachment.uploadedAt)} by{' '}
            {attachment.uploader.fullName}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={opening} onClick={() => void open()} size="sm" variant="outline">
            {opening ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
            {attachment.typeLabel === 'PDF document' ? 'Open PDF' : 'Open original'}
          </Button>
          {canDelete ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button disabled={deleting} size="sm" variant="destructive">
                  <Trash2 aria-hidden="true" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete {attachment.fileName}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes the attachment permanently. The audit history remains.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Keep file</AlertDialogCancel>
                  <AlertDialogAction onClick={onDelete}>Delete attachment</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export function MachineAttachments({ machineId }: { machineId: string }) {
  const { user } = useAuthenticatedUser();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const aborter = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mayUpload = can(user.role, 'attachment:upload');
  const attachments = useQuery({
    queryFn: () => attachmentsApi.list(machineId),
    queryKey: ['machine-attachments', machineId],
  });
  const deletion = useMutation({
    mutationFn: (id: string) => attachmentsApi.delete(id),
    onError: (cause) => setError(friendlyError(cause)),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ['machine-attachments', machineId] });
    },
  });

  useEffect(
    () => () => {
      aborter.current?.abort();
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    },
    [previewUrl],
  );

  const clearPreview = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSelectedName(null);
    if (fileInput.current) fileInput.current.value = '';
  };

  const upload = async (file: File) => {
    setError(null);
    if (!ATTACHMENT_MIME_TYPES.some((type) => type === file.type)) {
      setError('Choose a JPEG, PNG, WebP or PDF file.');
      return;
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      setError('Choose a file no larger than 10 MiB.');
      return;
    }
    clearPreview();
    setSelectedName(file.name);
    if (file.type.startsWith('image/')) setPreviewUrl(URL.createObjectURL(file));
    const controller = new AbortController();
    aborter.current = controller;
    setProgress(0);
    try {
      const signed = await attachmentsApi.requestUpload(machineId, {
        fileName: file.name,
        mimeType: file.type as (typeof ATTACHMENT_MIME_TYPES)[number],
        sizeBytes: file.size,
      });
      await uploadToSignedUrl(
        signed.uploadUrl,
        file,
        (value) => setProgress(value.percent),
        controller.signal,
      );
      await attachmentsApi.confirm({ intentToken: signed.intentToken });
      await queryClient.invalidateQueries({ queryKey: ['machine-attachments', machineId] });
      clearPreview();
    } catch (cause: unknown) {
      if (!(cause instanceof DOMException && cause.name === 'AbortError')) {
        setError(friendlyError(cause));
      }
    } finally {
      aborter.current = null;
      setProgress(null);
    }
  };

  if (attachments.isPending) {
    return (
      <div aria-label="Loading attachments" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Skeleton className="h-72" />
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (attachments.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Unable to load files</AlertTitle>
        <AlertDescription>
          <Button onClick={() => void attachments.refetch()} size="sm" variant="outline">
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-semibold">Files</h2>
          <p className="text-sm text-muted-foreground">
            Private photos and documents. Up to 20 files, 10 MiB each.
          </p>
        </div>
        {mayUpload ? (
          <>
            <input
              accept={ATTACHMENT_MIME_TYPES.join(',')}
              aria-label="Choose attachment"
              className="sr-only"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
              ref={fileInput}
              type="file"
            />
            <Button disabled={progress !== null} onClick={() => fileInput.current?.click()}>
              <Upload aria-hidden="true" /> Add file
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">You have read-only access to files.</p>
        )}
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>File action failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {progress !== null ? (
        <Card aria-live="polite">
          <CardHeader>
            <CardTitle>Uploading {selectedName}</CardTitle>
          </CardHeader>
          <CardContent className="flex items-center gap-4">
            {previewUrl ? (
              <Image
                alt={`Preview of ${selectedName ?? 'selected image'}`}
                className="size-20 rounded-md object-cover"
                height={80}
                src={previewUrl}
                unoptimized
                width={80}
              />
            ) : (
              <FileText className="size-10 text-muted-foreground" aria-hidden="true" />
            )}
            <div className="min-w-0 flex-1">
              <div
                aria-label={`Upload ${progress}% complete`}
                aria-valuemax={100}
                aria-valuemin={0}
                aria-valuenow={progress}
                className="h-2 overflow-hidden rounded-full bg-muted"
                role="progressbar"
              >
                <div className="h-full bg-primary" style={{ width: `${progress}%` }} />
              </div>
              <p className="mt-1 text-sm">{progress}%</p>
            </div>
            <Button onClick={() => aborter.current?.abort()} size="sm" variant="outline">
              <X aria-hidden="true" /> Cancel
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {attachments.data.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <ImageIcon aria-hidden="true" />
            <EmptyTitle>No files yet</EmptyTitle>
            <EmptyDescription>
              {mayUpload ? 'Add a photo, manual or service document.' : 'No files are available.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {attachments.data.map((attachment) => (
            <AttachmentCard
              attachment={attachment}
              canDelete={mayUpload}
              deleting={deletion.isPending}
              key={attachment.id}
              onDelete={() => deletion.mutate(attachment.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
