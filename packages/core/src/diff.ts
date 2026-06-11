import type { Span } from './entities';

interface LineToken {
  readonly text: string;
  readonly start: number;
}

const tokenizeLines = (text: string): readonly LineToken[] => {
  const tokens: LineToken[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    tokens.push({ text: line, start: offset });
    offset += line.length + 1;
  }
  return tokens;
};

/** For each line in `newLines`, true when it is part of the longest common subsequence. */
const lcsKeepFlags = (oldLines: readonly string[], newLines: readonly string[]): boolean[] => {
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] =
        oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const keep = new Array<boolean>(n).fill(false);
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (oldLines[i] === newLines[j]) {
      keep[j] = true;
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return keep;
};

/**
 * Deterministic line-based span diff: returns the regions of `newText` that are
 * not present in `oldText`, with character offsets into `newText`. Same input
 * pair always yields the same spans (AGENTS.md testing priority 2).
 */
export const diffChangedSpans = (oldText: string, newText: string): readonly Span[] => {
  if (oldText === newText) return Object.freeze([]);
  const newTokens = tokenizeLines(newText);
  const keep = lcsKeepFlags(
    tokenizeLines(oldText).map((t) => t.text),
    newTokens.map((t) => t.text),
  );
  const spans: Span[] = [];
  let run: LineToken[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const first = run[0];
    const last = run[run.length - 1];
    const charStart = first.start;
    const charEnd = last.start + last.text.length;
    spans.push(Object.freeze({ charStart, charEnd, text: newText.slice(charStart, charEnd) }));
    run = [];
  };
  newTokens.forEach((token, index) => {
    if (keep[index]) {
      flush();
    } else {
      run = [...run, token];
    }
  });
  flush();
  return Object.freeze(spans.filter((span) => span.text.trim() !== ''));
};
