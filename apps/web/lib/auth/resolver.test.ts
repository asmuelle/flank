import { MemoryFlankStore } from '@flank/pipeline';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspace } from './resolver';

const NOW = Date.UTC(2026, 5, 20, 12);

const seeded = async (): Promise<MemoryFlankStore> => {
  const store = new MemoryFlankStore();
  await store.seedWorkspace({ id: 'ws-a', name: 'Acme', planTier: 'growth' });
  await store.seedWorkspace({ id: 'ws-b', name: 'Beta', planTier: 'growth' });
  await store.seedUser({
    id: 'u-1',
    email: 'lead@acme.test',
    name: 'Lead',
    externalSubject: 'fk-sub-1',
    createdAt: new Date(NOW - 1_000),
  });
  return store;
};

const grant = (store: MemoryFlankStore, id: string, workspaceId: string, createdAt: number) =>
  store.seedMembership({
    id,
    userId: 'u-1',
    workspaceId,
    role: 'member',
    createdAt: new Date(createdAt),
  });

describe('resolveWorkspace', () => {
  let store: MemoryFlankStore;
  beforeEach(async () => {
    store = await seeded();
  });

  it('reports no_session when the request is unauthenticated (no user id)', async () => {
    const result = await resolveWorkspace({ userId: null, workspaceHint: null, store });
    expect(result).toEqual({ ok: false, reason: 'no_session' });
  });

  it('reports no_workspace when the authenticated user has no memberships', async () => {
    const result = await resolveWorkspace({ userId: 'u-1', workspaceHint: null, store });
    expect(result).toEqual({ ok: false, reason: 'no_workspace' });
  });

  it('reports no_workspace for an authenticated user that does not exist locally', async () => {
    // A freshly provisioned IdP identity with no grant yet — fail closed, never widen access.
    const result = await resolveWorkspace({ userId: 'u-unknown', workspaceHint: null, store });
    expect(result).toEqual({ ok: false, reason: 'no_workspace' });
  });

  it('resolves the only membership with no hint', async () => {
    await grant(store, 'm-a', 'ws-a', NOW - 500);
    const result = await resolveWorkspace({ userId: 'u-1', workspaceHint: null, store });
    expect(result).toMatchObject({ ok: true, userId: 'u-1', workspaceId: 'ws-a', role: 'member' });
  });

  it('honors a hint that matches a live membership', async () => {
    await grant(store, 'm-a', 'ws-a', NOW - 500); // earliest -> default
    await grant(store, 'm-b', 'ws-b', NOW - 100);
    const result = await resolveWorkspace({ userId: 'u-1', workspaceHint: 'ws-b', store });
    expect(result).toMatchObject({ ok: true, workspaceId: 'ws-b' });
  });

  it('falls back to the first membership when the hint is not a member workspace', async () => {
    await grant(store, 'm-a', 'ws-a', NOW - 500);
    await grant(store, 'm-b', 'ws-b', NOW - 100);
    const result = await resolveWorkspace({ userId: 'u-1', workspaceHint: 'ws-not-mine', store });
    // hint cannot widen access: unmatched -> earliest membership (ws-a)
    expect(result).toMatchObject({ ok: true, workspaceId: 'ws-a' });
  });
});
