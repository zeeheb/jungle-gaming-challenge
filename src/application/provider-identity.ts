import { ApplicationError } from './errors';

/**
 * Port for "which provider is calling?". Authentication itself is out of
 * scope (it is worth no points and must not be hand-made): ARCHITECTURE.md
 * describes the Keycloak design this port is meant for. Whatever implements
 * it, the rule that uses it stays the same: a provider only acts as itself.
 */
export interface ProviderIdentity {
  /**
   * The provider behind the request's credentials, or `undefined` when
   * authentication is disabled. Throws UnauthenticatedError when credentials
   * are required and missing or invalid.
   */
  resolve(authorization: string | undefined): Promise<string | undefined>;
}

export const PROVIDER_IDENTITY = Symbol('ProviderIdentity');

/** The current adapter: no authentication, every caller is trusted. */
export class AuthenticationDisabled implements ProviderIdentity {
  async resolve(): Promise<undefined> {
    return undefined;
  }
}

export class UnauthenticatedError extends ApplicationError {
  readonly code = 'UNAUTHENTICATED';
}

export class ProviderMismatchError extends ApplicationError {
  readonly code = 'PROVIDER_MISMATCH';
}

/** A provider authenticated as A cannot submit or read transactions of provider B. */
export function assertActsAsItself(authenticated: string | undefined, requested: string): void {
  if (authenticated !== undefined && authenticated !== requested) {
    throw new ProviderMismatchError(`Authenticated as ${authenticated}, cannot act as ${requested}`);
  }
}
