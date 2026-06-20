import { describe, expect, it } from 'vitest';
import { diffLines, diffStats } from './diff';

describe('diffLines', () => {
  it('marks every line same for identical input', () => {
    const lines = diffLines('a\nb\nc', 'a\nb\nc');
    expect(lines.map((l) => l.op)).toEqual(['same', 'same', 'same']);
    expect(lines.map((l) => [l.fromLine, l.toLine])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('treats empty text as zero lines (not a single blank line)', () => {
    expect(diffLines('', '')).toEqual([]);
    expect(diffLines('', 'x')).toEqual([{ op: 'add', text: 'x', fromLine: null, toLine: 1 }]);
    expect(diffLines('x', '')).toEqual([{ op: 'del', text: 'x', fromLine: 1, toLine: null }]);
  });

  it('detects a single replaced middle line', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc');
    expect(lines.map((l) => `${l.op}:${l.text}`)).toEqual(['same:a', 'del:b', 'add:B', 'same:c']);
  });

  it('detects an insertion preserving surrounding context', () => {
    const lines = diffLines('a\nc', 'a\nb\nc');
    expect(lines.map((l) => `${l.op}:${l.text}`)).toEqual(['same:a', 'add:b', 'same:c']);
    const added = lines.find((l) => l.op === 'add');
    expect(added).toMatchObject({ fromLine: null, toLine: 2 });
  });

  it('detects a deletion', () => {
    const lines = diffLines('a\nb\nc', 'a\nc');
    expect(lines.map((l) => `${l.op}:${l.text}`)).toEqual(['same:a', 'del:b', 'same:c']);
  });

  it('is deterministic across repeated runs', () => {
    const a = 'one\ntwo\nthree\nfour';
    const b = 'one\ntwo-changed\nthree\nfive';
    expect(diffLines(a, b)).toEqual(diffLines(a, b));
  });
});

describe('diffStats', () => {
  it('counts additions and removals', () => {
    const lines = diffLines('a\nb\nc', 'a\nB\nc\nd');
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });
  });

  it('reports zero changes for identical input', () => {
    expect(diffStats(diffLines('x\ny', 'x\ny'))).toEqual({ added: 0, removed: 0 });
  });
});
