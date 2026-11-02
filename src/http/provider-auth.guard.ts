import {
  createParamDecorator,
  Inject,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PROVIDER_IDENTITY, type ProviderIdentity } from '../application/provider-identity';

/**
 * Extension point for authentication on the provider-facing routes. It asks
 * the ProviderIdentity port who is calling and keeps the answer for the
 * controller, which checks it against the providerId of the request. With the
 * current adapter (AuthenticationDisabled) everyone passes, as anonymous.
 * Health checks and /metrics are not guarded, as the challenge asks.
 */
export class ProviderAuthGuard implements CanActivate {
  constructor(@Inject(PROVIDER_IDENTITY) private readonly identity: ProviderIdentity) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const providerId = await this.identity.resolve(http.getRequest<Request>().header('authorization'));
    http.getResponse<Response>().locals['providerId'] = providerId;
    return true;
  }
}

/** The authenticated provider, or undefined while authentication is disabled. */
export const AuthenticatedProvider = createParamDecorator(
  (_: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getResponse<Response>().locals['providerId'] as string | undefined,
);
