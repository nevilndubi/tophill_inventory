export type ResponseMeta = Record<string, unknown>;

export class ApiResponse<T> {
  constructor(
    public readonly data: T,
    public readonly meta?: ResponseMeta,
  ) {}
}

export const apiResponse = <T>(data: T, meta?: ResponseMeta): ApiResponse<T> =>
  new ApiResponse(data, meta);
