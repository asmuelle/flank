import type { DiffLine, DiffStats } from '../lib/views/diff';

const GUTTER = (n: number | null): string => (n === null ? '·' : String(n));

function DiffRow({ line }: { readonly line: DiffLine }) {
  if (line.op === 'add') {
    return (
      <li className="diff-row" data-op="add">
        <span className="diff-gutter mono" aria-hidden="true">
          {GUTTER(line.fromLine)} {GUTTER(line.toLine)}
        </span>
        <ins className="diff-text">{line.text === '' ? ' ' : line.text}</ins>
      </li>
    );
  }
  if (line.op === 'del') {
    return (
      <li className="diff-row" data-op="del">
        <span className="diff-gutter mono" aria-hidden="true">
          {GUTTER(line.fromLine)} {GUTTER(line.toLine)}
        </span>
        <del className="diff-text">{line.text === '' ? ' ' : line.text}</del>
      </li>
    );
  }
  return (
    <li className="diff-row" data-op="same">
      <span className="diff-gutter mono" aria-hidden="true">
        {GUTTER(line.fromLine)} {GUTTER(line.toLine)}
      </span>
      <span className="diff-text">{line.text === '' ? ' ' : line.text}</span>
    </li>
  );
}

export interface VersionDiffProps {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly lines: readonly DiffLine[];
  readonly stats: DiffStats;
}

export function VersionDiff({ fromVersion, toVersion, lines, stats }: VersionDiffProps) {
  return (
    <div className="diff">
      <p className="diff-summary mono">
        v{fromVersion} → v{toVersion} · <span className="diff-added">+{stats.added}</span>{' '}
        <span className="diff-removed">−{stats.removed}</span>
      </p>
      <ol
        className="diff-lines"
        aria-label={`Diff from version ${fromVersion} to version ${toVersion}`}
      >
        {lines.map((line, index) => (
          <DiffRow key={index} line={line} />
        ))}
      </ol>
    </div>
  );
}
