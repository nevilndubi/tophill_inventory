import type { ArgumentsHost } from '@nestjs/common';
import { jest } from '@jest/globals';
import type { PinoLogger } from 'nestjs-pino';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../auth/auth.types';
import { PermissionDeniedException } from '../../authorization/permission-denied.exception';
import type { RequestWithId } from '../http/request-id';
import { ApiExceptionFilter } from './api-exception.filter';

describe(ApiExceptionFilter.name, () => {
  it('logs safe structured context for every permission denial', () => {
    const logger = {
      error: jest.fn(),
      warn: jest.fn(),
    };
    const response = {
      json: jest.fn(),
      setHeader: jest.fn(),
      status: jest.fn(),
    };
    response.status.mockReturnValue(response);
    const request = {
      authorizationContext: { permission: 'booking:approve', scope: 'OWN_DEPARTMENT' },
      headers: {},
      method: 'GET',
      originalUrl: '/api/v1/test',
      requestId: 'permission-filter-request',
      user: {
        department: null,
        email: 'must-not-be-logged',
        fullName: 'Test User',
        id: '11111111-1111-4111-8111-111111111111',
        isActive: true,
        role: 'DEPT_MANAGER',
      },
    } as unknown as RequestWithId & AuthenticatedRequest;
    const host = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response as unknown as Response,
      }),
    } as ArgumentsHost;
    const filter = new ApiExceptionFilter(logger as unknown as PinoLogger);

    filter.catch(new PermissionDeniedException(), host);

    expect(logger.warn).toHaveBeenCalledWith(
      {
        permission: 'booking:approve',
        requestId: 'permission-filter-request',
        role: 'DEPT_MANAGER',
        route: 'GET /api/v1/test',
        userId: '11111111-1111-4111-8111-111111111111',
      },
      'Permission denied',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(request.user?.email);
  });
});
