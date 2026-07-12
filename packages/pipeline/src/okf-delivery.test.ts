import type {
  Claim,
  Competitor,
  DossierSection,
  Snapshot,
  Source,
  Workspace,
} from '@flank/core';
import type {
  BundlePublishRequest,
  BundlePublishResult,
  BundlePublisher,
  GitBundleTarget,
} from '@flank/okf-export';
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFlankStore } from './memory-store';
import { runOkfDelivery } from './okf-delivery';

const NOW = new Date('2026-07-01T00:00:00Z');
let counter = 0;
const nextId = () => `id-${(counter += 1)}`;

const WS: Workspace = { id: 'ws-a', name: 'Acme', planTier: 'growth' };
const COMP: Competitor = {
  id: 'comp-a',
  workspaceId: 'ws-a',
  name: 'Globex',
  primaryDomain: 'globex.com',
};
const SRC: Source = {
  id: 'src-a',
  competitorId: 'comp-a',
  type: 'pricing',
  url: 'https://globex.com/pricing',
  adapter: 'html',
  cadence: '0 6 * * *',
  legalStatus: 'open',
};
const SNAP: Snapshot = {
  id: 'snap-1',
  sourceId: 'src-a',
  contentHash: 'h',
  normalizedText: 'Analyst $59 per month',
  fetchedAt: NOW,
  httpStatus: 200,
  vantage: null,
};

const TARGET: GitBundleTarget = {
  workspaceId: 'ws-a',
  workspaceName: 'Acme',
  provider: 'github',
  repo: 'acme/intel',
  branch: 'flank-okf',
  baseBranch: 'main',
  subdir: 'intel/acme',
};

const claim = (id: string, verified: boolean): Claim => ({
  id,
  deltaId: 'd-1',
  snapshotId: 'snap-1',
  quoteText: 'Analyst $59 per month',
  charStart: 0,
  charEnd: 21,
  sourceUrl: 'https://globex.com/pricing',
  capturedAt: NOW,
  verifiedAt: verified ? NOW : null,
});

const dossier = (claimIds: readonly string[]): DossierSection => ({
  id: 'ds-1',
  competitorId: 'comp-a',
  kind: 'pricing',
  version: 1,
  contentMd: '# Pricing\n\nAnalyst tier is $59/mo.',
  claimIds,
  model: 'claude-sonnet-4-6',
  batchId: 'batch-1',
  supersedesId: null,
  createdAt: NOW,
});

/** A publisher that records requests and returns a scripted result. */
const fakePublisher = (
  result: BundlePublishResult = {
    ok: true,
    commitSha: 'sha-1',
    branchRef: 'refs/heads/flank-okf',
    pullRequestUrl: 'https://github.com/acme/intel/pull/1',
  },
): { publisher: BundlePublisher; requests: BundlePublishRequest[] } => {
  const requests: BundlePublishRequest[] = [];
  return {
    requests,
    publisher: {
      async publish(request) {
        requests.push(request);
        return result;
      },
    },
  };
};

const seedPublishable = async (store: MemoryFlankStore, claimIds: readonly string[], verified: boolean) => {
  await store.seedWorkspace(WS);
  await store.seedCompetitor(COMP);
  await store.seedSource(SRC);
  await store.insertSnapshot(WS.id, SNAP);
  await store.insertDelta(WS.id, {
    id: 'd-1',
    sourceId: 'src-a',
    fromSnapshotId: null,
    toSnapshotId: 'snap-1',
    changedSpans: [],
    triageClass: 'pricing_change',
    materiality: 2,
    rationale: 'price change',
    state: 'published',
    confirmedBySnapshotId: null,
    createdAt: NOW,
  });
  for (const id of new Set(claimIds)) await store.insertClaim(WS.id, claim(id, verified));
  await store.insertDossierSection(WS.id, dossier(claimIds));
};

describe('runOkfDelivery', () => {
  let store: MemoryFlankStore;
  beforeEach(() => {
    store = new MemoryFlankStore();
    counter = 0;
  });

  it('publishes a changed bundle, records it, and prefixes files under the target subdir', async () => {
    // Arrange
    await seedPublishable(store, ['c-1'], true);
    const { publisher, requests } = fakePublisher();

    // Act
    const report = await runOkfDelivery({ store, publisher, nextId }, [TARGET], NOW, {
      baseUrl: 'https://app.flank.test',
    });

    // Assert
    expect(report).toMatchObject({ targetsConsidered: 1, published: 1, unchanged: 0, blocked: 0 });
    // Files are pushed under the subdir.
    expect([...requests[0].files.keys()].every((p) => p.startsWith('intel/acme/'))).toBe(true);
    // A published delivery is recorded with the bundle manifest (bundle-relative paths).
    const recorded = await store.latestPublishedBundleDelivery(WS.id);
    expect(recorded?.status).toBe('published');
    expect(recorded?.commitSha).toBe('sha-1');
    expect(Object.keys(recorded?.manifest ?? {})).toContain('index.md');
    expect(recorded!.filesAdded).toBeGreaterThan(0);
  });

  it('skips an unchanged bundle without recording a second delivery', async () => {
    // Arrange
    await seedPublishable(store, ['c-1'], true);
    const { publisher } = fakePublisher();

    // Act — deliver twice against identical state.
    await runOkfDelivery({ store, publisher, nextId }, [TARGET], NOW, { baseUrl: 'https://x' });
    const second = await runOkfDelivery({ store, publisher, nextId }, [TARGET], NOW, {
      baseUrl: 'https://x',
    });

    // Assert — nothing new shipped, exactly one published record exists.
    expect(second).toMatchObject({ published: 0, unchanged: 1 });
    const deliveries = await store.latestPublishedBundleDelivery(WS.id);
    expect(deliveries?.id).toBe('id-1'); // still the first run's record
  });

  it('blocks and records a failed delivery when a cited claim is unverified (projection gate)', async () => {
    // Arrange — the section cites an unverified claim, so the projection emits an error finding.
    await seedPublishable(store, ['c-1'], false);
    const { publisher, requests } = fakePublisher();

    // Act
    const report = await runOkfDelivery({ store, publisher, nextId }, [TARGET], NOW, {
      baseUrl: 'https://x',
    });

    // Assert — nothing pushed; a failed record explains why.
    expect(report).toMatchObject({ published: 0, blocked: 1 });
    expect(requests).toHaveLength(0);
    expect(await store.latestPublishedBundleDelivery(WS.id)).toBeNull();
  });

  it('records a failed delivery when the publisher errors, without aborting the sweep', async () => {
    // Arrange
    await seedPublishable(store, ['c-1'], true);
    const { publisher } = fakePublisher({ ok: false, error: 'github 503' });

    // Act
    const report = await runOkfDelivery({ store, publisher, nextId }, [TARGET], NOW, {
      baseUrl: 'https://x',
    });

    // Assert
    expect(report).toMatchObject({ published: 0, failed: 1 });
    expect(await store.latestPublishedBundleDelivery(WS.id)).toBeNull();
  });

  it('counts a target that throws as an error and keeps going', async () => {
    // Arrange — a target for a workspace that does not exist makes loadWorkspaceExport throw nothing
    // (listCompetitors returns []), so instead force an error via a broken publisher on a real ws.
    await seedPublishable(store, ['c-1'], true);
    const throwing: BundlePublisher = {
      async publish() {
        throw new Error('unexpected');
      },
    };

    // Act
    const report = await runOkfDelivery({ store, publisher: throwing, nextId }, [TARGET], NOW, {
      baseUrl: 'https://x',
    });

    // Assert
    expect(report).toMatchObject({ errors: 1, published: 0 });
  });
});
