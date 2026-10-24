import { CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from './auth.types';
import { InvalidAuthenticationException } from './auth.errors';
import { IS_PUBLIC_ROUTE } from './public.decorator';
import { JwtVerifierService } from './jwt-verifier.service';
import { UserSessionService } from './user-session.service';

const BEARER_TOKEN_PATTERN = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenVerifier: JwtVerifierService,
    private readonly userSession: UserSessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (
      request.method === 'OPTIONS' ||
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_ROUTE, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    ) {
      return true;
    }

    const authorization = request.headers.authorization;
    const match =
      typeof authorization === 'string' ? BEARER_TOKEN_PATTERN.exec(authorization) : null;

    if (match?.[1] === undefined) {
      throw new InvalidAuthenticationException();
    }

    const verified = await this.tokenVerifier.verify(match[1]);
    request.user = await this.userSession.resolve(verified.subject);
    return true;
  }
}
