export type DiffOp = 'same' | 'add' | 'del';

export interface DiffLine {
  readonly op: DiffOp;
  readonly text: string;
  /** 1-based line number in the `from` text, or null for additions. */
  readonly fromLine: number | null;
  /** 1-based line number in the `to` text, or null for deletions. */
  readonly toLine: number | null;
}

export interface DiffStats {
  readonly added: number;
  readonly removed: number;
}

const splitLines = (text: string): readonly string[] => (text === '' ? [] : text.split('\n'));

/**
 * Deterministic line diff via the classic LCS dynamic program. Pure and total: identical inputs
 * always yield the same ops, and ties resolve toward deletions-before-additions so two equal-length
 * edits render stably. Mirrors the determinism contract the snapshot diff (Invariant 2) relies on.
 */
export const diffLines = (from: string, to: string): readonly DiffLine[] => {
  const a = splitLines(from);
  const b = splitLines(to);
  const n = a.length;
  const m = b.length;

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i], fromLine: i + 1, toLine: j + 1 });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ op: 'del', text: a[i], fromLine: i + 1, toLine: null });
      i++;
    } else {
      out.push({ op: 'add', text: b[j], fromLine: null, toLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    out.push({ op: 'del', text: a[i], fromLine: i + 1, toLine: null });
    i++;
  }
  while (j < m) {
    out.push({ op: 'add', text: b[j], fromLine: null, toLine: j + 1 });
    j++;
  }
  return Object.freeze(out);
};

export const diffStats = (lines: readonly DiffLine[]): DiffStats => ({
  added: lines.filter((line) => line.op === 'add').length,
  removed: lines.filter((line) => line.op === 'del').length,
});
