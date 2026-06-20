import { MemoryFlankStore } from '@flank/pipeline';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspace } from './resolver';
import { signSession } from './session-crypto';

const SECRET = 'resolver-test-secret-resolver-test-secret';
const NOW = Date.UTC(2026, 5, 20, 12);
const FUTURE = NOW + 60_000;

const seeded = async (): Promise<MemoryFlankStore> => {
  const store = new MemoryFlankStore();
  await store.seedWorkspace({ id: 'ws-a', name: 'Acme', planTier: 'growth' });
  await store.seedWorkspace({ id: 'ws-b', name: 'Beta', planTier: 'growth' });
  await store.seedUser({
    id: 'u-1',
    email: 'lead@acme.test',
    name: 'Lead',
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

const token = (uid = 'u-1', exp = FUTURE) => signSession({ uid, exp }, SECRET);

describe('resolveWorkspace', () => {
  let store: MemoryFlankStore;
  beforeEach(async () => {
    store = await seeded();
  });

  it('reports no_session when the cookie is absent', async () => {
    const result = await resolveWorkspace({
      token: null,
      workspaceHint: null,
      secret: SECRET,
      store,
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'no_session' });
  });

  it('reports no_session for a token signed with the wrong secret', async () => {
    const forged = signSession(
      { uid: 'u-1', exp: FUTURE },
      'a-totally-different-secret-aaaaaaaaaa',
    );
    const result = await resolveWorkspace({
      token: forged,
      workspaceHint: null,
      secret: SECRET,
      store,
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'no_session' });
  });

  it('reports no_session for an expired token', async () => {
    const result = await resolveWorkspace({
      token: token('u-1', NOW - 1),
      workspaceHint: null,
      secret: SECRET,
      store,
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'no_session' });
  });

  it('reports no_workspace when the verified user has no memberships', async () => {
    const result = await resolveWorkspace({
      token: token(),
      workspaceHint: null,
      secret: SECRET,
      store,
      nowMs: NOW,
    });
    expect(result).toEqual({ ok: false, reason: 'no_workspace' });
  });

  it('resolves the only membership with no hint', async () => {
    await grant(store, 'm-a', 'ws-a', NOW - 500);
    const result = await resolveWorkspace({
      token: token(),
      workspaceHint: null,
      secret: SECRET,
      store,
      nowMs: NOW,
    });
    expect(result).toMatchObject({ ok: true, userId: 'u-1', workspaceId: 'ws-a', role: 'member' });
  });

  it('honors a hint that matches a live membership', async () => {
    await grant(store, 'm-a', 'ws-a', NOW - 500); // earliest -> default
    await grant(store, 'm-b', 'ws-b', NOW - 100);
    const result = await resolveWorkspace({
      token: token(),
      workspaceHint: 'ws-b',
      secret: SECRET,
      store,
      nowMs: NOW,
    });
    expect(result).toMatchObject({ ok: true, workspaceId: 'ws-b' });
  });

  it('falls back to the first membership when the hint is not a member workspace', async () => {
    await grant(store, 'm-a', 'ws-a', NOW - 500);
    await grant(store, 'm-b', 'ws-b', NOW - 100);
    const result = await resolveWorkspace({
      token: token(),
      workspaceHint: 'ws-not-mine',
      secret: SECRET,
      store,
      nowMs: NOW,
    });
    // hint cannot widen access: unmatched -> earliest membership (ws-a)
    expect(result).toMatchObject({ ok: true, workspaceId: 'ws-a' });
  });
});
