import { describe, expect, it } from 'vitest';
import {
  diffManifests,
  isEmptyDiff,
  manifestFromRecord,
  manifestOf,
  manifestToRecord,
} from './manifest';

describe('manifestOf', () => {
  it('hashes each file and is stable for identical content', () => {
    // Arrange
    const files = new Map([
      ['index.md', 'one'],
      ['a.md', 'two'],
    ]);

    // Act
    const first = manifestOf(files);
    const second = manifestOf(new Map([...files]));

    // Assert
    expect(first.get('index.md')).toMatch(/^[0-9a-f]{64}$/);
    expect(manifestToRecord(first)).toEqual(manifestToRecord(second));
  });
});

describe('manifestToRecord / manifestFromRecord', () => {
  it('round-trips and sorts keys deterministically', () => {
    // Arrange
    const manifest = manifestOf(
      new Map([
        ['z.md', 'z'],
        ['a.md', 'a'],
      ]),
    );

    // Act
    const record = manifestToRecord(manifest);

    // Assert — keys sorted, restore is faithful.
    expect(Object.keys(record)).toEqual(['a.md', 'z.md']);
    expect(manifestToRecord(manifestFromRecord(record))).toEqual(record);
  });
});

describe('diffManifests', () => {
  it('classifies added, modified, removed, and unchanged paths, each sorted', () => {
    // Arrange
    const previous = manifestOf(
      new Map([
        ['keep.md', 'same'],
        ['change.md', 'old'],
        ['gone.md', 'bye'],
      ]),
    );
    const next = manifestOf(
      new Map([
        ['keep.md', 'same'],
        ['change.md', 'new'],
        ['fresh.md', 'hi'],
      ]),
    );

    // Act
    const diff = diffManifests(previous, next);

    // Assert
    expect(diff).toEqual({
      added: ['fresh.md'],
      modified: ['change.md'],
      removed: ['gone.md'],
      unchanged: ['keep.md'],
    });
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it('reports an empty diff when nothing changed', () => {
    // Arrange
    const manifest = manifestOf(new Map([['index.md', 'x']]));

    // Act
    const diff = diffManifests(manifest, manifestOf(new Map([['index.md', 'x']])));

    // Assert
    expect(isEmptyDiff(diff)).toBe(true);
    expect(diff.unchanged).toEqual(['index.md']);
  });

  it('treats an empty previous manifest as an all-added first delivery', () => {
    // Act
    const diff = diffManifests(new Map(), manifestOf(new Map([['index.md', 'x']])));

    // Assert
    expect(diff.added).toEqual(['index.md']);
    expect(isEmptyDiff(diff)).toBe(false);
  });
});
