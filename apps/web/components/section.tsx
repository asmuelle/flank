import Link from 'next/link';
import type { CitationView, SectionView } from '../lib/views/sections';

export const SECTION_LABELS: Readonly<Record<string, string>> = {
  overview: 'Overview',
  pricing: 'Pricing',
  product: 'Product',
  gtm: 'Go-to-market',
  team: 'Team',
  why_we_win: 'Why we win',
  landmines: 'Landmines',
  pricing_counter: 'Pricing counter',
  objections: 'Objections',
};

const formatStamp = (iso: string): string => new Date(iso).toUTCString().replace(' GMT', ' UTC');

/** Split markdown-ish content into paragraphs; rendered as plain text (no HTML injection). */
const paragraphs = (content: string): readonly string[] =>
  content
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '');

function SectionCitation({ citation }: { readonly citation: CitationView }) {
  return (
    <figure className="citation">
      <blockquote cite={citation.sourceUrl}>{citation.quote}</blockquote>
      <figcaption className="provenance">
        <span className="provenance-status" data-verified={citation.verified}>
          {citation.verified ? 'span-verified' : 'unverified'}
        </span>
        <a href={citation.sourceUrl}>{citation.sourceUrl}</a>
        <time dateTime={citation.capturedAt}>{formatStamp(citation.capturedAt)}</time>
      </figcaption>
    </figure>
  );
}

export interface SectionCardProps {
  readonly section: SectionView;
  readonly versionCount: number;
  readonly diffHref: string;
}

export function SectionCard({ section, versionCount, diffHref }: SectionCardProps) {
  const label = SECTION_LABELS[section.kind] ?? section.kind;
  return (
    <article className="section-card" aria-labelledby={`section-${section.kind}`}>
      <header className="section-card-head">
        <h3 id={`section-${section.kind}`}>{label}</h3>
        <p className="section-card-meta mono">
          v{section.version}
          {versionCount > 1 ? (
            <>
              {' · '}
              <Link href={diffHref}>view changes</Link>
            </>
          ) : null}
        </p>
      </header>

      <div className="section-body">
        {paragraphs(section.contentMd).map((block, index) => (
          <p key={index}>{block}</p>
        ))}
      </div>

      {section.citations.length > 0 ? (
        <div className="section-citations">
          {section.citations.map((citation, index) => (
            <SectionCitation key={`${section.kind}-${index}`} citation={citation} />
          ))}
        </div>
      ) : null}
    </article>
  );
}
