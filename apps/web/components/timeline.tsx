import type { TimelineEntryView, CitationView } from '../lib/brief';

const CLASS_LABELS: Readonly<Record<string, string>> = {
  pricing_change: 'Pricing change',
  feature_launch: 'Feature launch',
  repositioning: 'Repositioning',
  leadership_hire: 'Leadership hire',
  hiring_signal: 'Hiring signal',
  noise: 'Noise',
};

const SIGNAL_KIND: Readonly<Record<string, string>> = {
  pricing_change: 'threat',
  repositioning: 'shift',
  leadership_hire: 'opportunity',
  hiring_signal: 'opportunity',
  feature_launch: 'shift',
  noise: 'quiet',
};

const formatStamp = (iso: string): string => new Date(iso).toUTCString().replace(' GMT', ' UTC');

function Citation({ citation }: { readonly citation: CitationView }) {
  return (
    <figure className="citation">
      <blockquote cite={citation.sourceUrl}>{citation.quote}</blockquote>
      <figcaption className="provenance">
        <span className="provenance-status" data-verified={citation.verified}>
          {citation.verified ? 'span-verified' : 'unverified'}
        </span>
        <span>
          chars {citation.charStart}–{citation.charEnd}
        </span>
        <a href={citation.sourceUrl}>{citation.sourceUrl}</a>
        <time dateTime={citation.capturedAt}>{formatStamp(citation.capturedAt)}</time>
      </figcaption>
    </figure>
  );
}

export function TimelineEntry({ entry }: { readonly entry: TimelineEntryView }) {
  return (
    <article
      className="delta"
      data-signal={SIGNAL_KIND[entry.triageClass] ?? 'quiet'}
      aria-labelledby={`delta-${entry.id}`}
    >
      <header className="delta-head">
        <p className="delta-kicker">
          <span className="delta-class">
            {CLASS_LABELS[entry.triageClass] ?? entry.triageClass}
          </span>
          <span className="delta-materiality" aria-label={`materiality ${entry.materiality} of 3`}>
            {'●'.repeat(entry.materiality)}
            {'○'.repeat(3 - entry.materiality)}
          </span>
        </p>
        <h3 id={`delta-${entry.id}`}>{entry.rationale}</h3>
        <p className="delta-meta">
          <span className="mono">{entry.sourceType}</span>
          <time className="mono" dateTime={entry.occurredAt}>
            {formatStamp(entry.occurredAt)}
          </time>
          {entry.awaitingConfirmation ? (
            <strong className="delta-hold">held for re-fetch confirmation — not alerted</strong>
          ) : (
            <span className="delta-state mono">{entry.state}</span>
          )}
        </p>
      </header>
      {entry.citations.map((citation) => (
        <Citation key={`${entry.id}-${citation.charStart}`} citation={citation} />
      ))}
    </article>
  );
}

export function Timeline({ entries }: { readonly entries: readonly TimelineEntryView[] }) {
  return (
    <ol className="timeline" aria-label="Change timeline, newest first">
      {entries.map((entry) => (
        <li key={entry.id}>
          <TimelineEntry entry={entry} />
        </li>
      ))}
    </ol>
  );
}
