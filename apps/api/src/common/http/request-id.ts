import { randomUUID } from 'node:crypto';
import type { Request } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

export type RequestWithId = Request & {
  requestId?: string;
};

type RequestIdCarrier = {
  headers: Record<string, string | string[] | undefined>;
  id?: unknown;
  requestId?: unknown;
};

const normalizeRequestId = (value: unknown): string | undefined => {
  const candidate = Array.isArray(value) ? value[0] : value;

  if (typeof candidate !== 'string') {
    return undefined;
  }

  const trimmed = candidate.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(trimmed) ? trimmed : undefined;
};

export const getOrCreateRequestId = (request: RequestIdCarrier): string =>
  normalizeRequestId(request.requestId) ??
  normalizeRequestId(request.id) ??
  normalizeRequestId(request.headers[REQUEST_ID_HEADER]) ??
  randomUUID();
