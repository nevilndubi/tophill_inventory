import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  type ExceptionFilter,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Response } from 'express';
import { getOrCreateRequestId, REQUEST_ID_HEADER, type RequestWithId } from '../http/request-id';

type ErrorResponse = {
  code?: unknown;
  message?: unknown;
  details?: unknown;
};

const isErrorResponse = (value: unknown): value is ErrorResponse =>
  typeof value === 'object' && value !== null;

const statusCodeToErrorCode = (status: number): string =>
  typeof HttpStatus[status] === 'string' ? HttpStatus[status] : 'HTTP_ERROR';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(
    @InjectPinoLogger(ApiExceptionFilter.name)
    private readonly logger: PinoLogger,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const request = context.getRequest<RequestWithId>();
    const response = context.getResponse<Response>();
    const requestId = getOrCreateRequestId(request);
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : undefined;
    const normalized = this.normalizeError(status, exceptionResponse);

    request.requestId = requestId;
    response.setHeader(REQUEST_ID_HEADER, requestId);

    if (status >= 500) {
      this.logger.error(
        {
          err: exception,
          method: request.method,
          requestId,
          url: request.originalUrl,
        },
        'Unhandled request error',
      );
    }

    response.status(status).json({
      error: {
        ...normalized,
        requestId,
      },
    });
  }

  private normalizeError(
    status: number,
    exceptionResponse: string | object | undefined,
  ): { code: string; message: string; details: unknown } {
    if (typeof exceptionResponse === 'string') {
      return {
        code: statusCodeToErrorCode(status),
        message: exceptionResponse,
        details: {},
      };
    }

    if (isErrorResponse(exceptionResponse)) {
      return {
        code:
          typeof exceptionResponse.code === 'string'
            ? exceptionResponse.code
            : statusCodeToErrorCode(status),
        message:
          typeof exceptionResponse.message === 'string'
            ? exceptionResponse.message
            : 'Request failed',
        details: exceptionResponse.details ?? {},
      };
    }

    return {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
      details: {},
    };
  }
}
