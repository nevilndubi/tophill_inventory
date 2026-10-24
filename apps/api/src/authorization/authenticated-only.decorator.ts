import { SetMetadata } from '@nestjs/common';

export const IS_AUTHENTICATED_ONLY_ROUTE = Symbol('is-authenticated-only-route');

export const AuthenticatedOnly = () => SetMetadata(IS_AUTHENTICATED_ONLY_ROUTE, true);
