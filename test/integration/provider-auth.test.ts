import type { MikroORM } from '@mikro-orm/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  PROVIDER_IDENTITY,
  UnauthenticatedError,
  type ProviderIdentity,
} from '../../src/application/provider-identity';
import { keyOf, openWallet, submit, wagerBody } from '../support/api-fixtures';
import { startApp, type TestApp } from '../support/app';
import { setupTestDatabase } from '../support/database';

// Authentication is not implemented, but its extension point is real: this
// test plugs a fake identity adapter (standing in for JWT validation against
// Keycloak) and shows the rest of the app enforcing it.

const TOKENS: Record<string, string> = { 'Bearer token-of-provider-a': 'provider-a' };

const fakeIdentity: ProviderIdentity = {
  async resolve(authorization) {
    const providerId = authorization === undefined ? undefined : TOKENS[authorization];
    if (!providerId) {
      throw new UnauthenticatedError('Missing or invalid credentials');
    }
    return providerId;
  },
};

let db: MikroORM;
let open: TestApp; // the app as shipped: authentication disabled
let secured: TestApp;

beforeAll(async () => {
  db = await setupTestDatabase();
  open = await startApp();
  secured = await startApp((builder) => builder.overrideProvider(PROVIDER_IDENTITY).useValue(fakeIdentity));
});

afterAll(async () => {
  await open.close();
  await secured.close();
  await db.close(true);
});

const asProviderA = { Authorization: 'Bearer token-of-provider-a' };

describe('provider identity extension point', () => {
  it('lets every caller in while authentication is disabled', async () => {
    const wallet = await openWallet(open.api);

    expect((await submit(open.api, wagerBody(wallet, { providerId: 'any-provider' }))).status).toBe(200);
  });

  it('answers 401 without valid credentials once an identity adapter is plugged in', async () => {
    const wallet = await openWallet(secured.api);

    const response = await submit(secured.api, wagerBody(wallet));

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('lets a provider act as itself and answers 403 when it acts as another', async () => {
    const wallet = await openWallet(secured.api);
    const own = wagerBody(wallet, { providerId: 'provider-a' });
    const foreign = wagerBody(wallet, { providerId: 'provider-b' });
    const post = (body: ReturnType<typeof wagerBody>) =>
      secured.api.post('/wagering/transactions', body, { 'Idempotency-Key': keyOf(body), ...asProviderA });

    const accepted = await post(own);
    expect(accepted.status).toBe(200);
    const forbidden = await post(foreign);
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error.code).toBe('PROVIDER_MISMATCH');

    // reading is scoped the same way
    const ownPath = `/providers/provider-a/wagering/transactions/${own.externalTransactionId}`;
    expect((await secured.api.get(ownPath, asProviderA)).status).toBe(200);
    expect((await secured.api.get(`/providers/provider-b/wagering/transactions/x`, asProviderA)).status).toBe(403);
    expect((await secured.api.get(`/wagering/transactions/${accepted.body.transactionId}`, asProviderA)).status).toBe(200);
  });

  it('keeps the health checks and the metrics open', async () => {
    expect((await secured.api.get('/health/live')).status).toBe(200);
    expect((await secured.api.getText('/metrics')).status).toBe(200);
  });
});
