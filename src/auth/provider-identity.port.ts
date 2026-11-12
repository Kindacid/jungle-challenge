/**
 * The identity of the caller (a game provider) for a request. Authentication is
 * out of scope for scoring (see ARCHITECTURE.md), so the default implementation
 * is a trusted no-op. This port is the explicit extension point: a real build
 * would resolve the identity from a validated OIDC access token (e.g. Keycloak
 * client-credentials) and assert that `providerId` matches the token subject.
 */
export interface ProviderIdentity {
  providerId: string | null;
  authenticated: boolean;
}

export abstract class ProviderIdentityPort {
  /** Resolve the provider identity from transport headers. */
  abstract resolve(headers: Record<string, string | string[] | undefined>): ProviderIdentity;
}

/** Trusts the caller; carries no provider identity. Replace to enable real auth. */
export class NoopProviderIdentity extends ProviderIdentityPort {
  resolve(): ProviderIdentity {
    return { providerId: null, authenticated: false };
  }
}
