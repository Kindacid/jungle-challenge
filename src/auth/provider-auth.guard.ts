import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { ProviderIdentityPort } from './provider-identity.port.ts';

/**
 * No-op authentication guard. It resolves the provider identity (currently a
 * trusted no-op) and attaches it to the request, then always allows. Health and
 * metrics endpoints are not guarded. To enable real auth, swap the
 * ProviderIdentityPort implementation and make this guard reject unauthenticated
 * requests and mismatched providerIds — no call site changes.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(private readonly identity: ProviderIdentityPort) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      providerIdentity?: unknown;
    }>();
    req.providerIdentity = this.identity.resolve(req.headers);
    return true;
  }
}
