import { Injectable, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { ApiResponse, apiResponse } from './response-envelope';

@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<
  T | ApiResponse<T>,
  ApiResponse<T>
> {
  intercept(
    _context: ExecutionContext,
    next: { handle: () => Observable<T | ApiResponse<T>> },
  ): Observable<ApiResponse<T>> {
    return next
      .handle()
      .pipe(map((value) => (value instanceof ApiResponse ? value : apiResponse(value))));
  }
}
