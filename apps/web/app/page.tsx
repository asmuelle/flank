import { CoverageReceipt } from '../components/coverage-receipt';
import { Timeline } from '../components/timeline';
import { loadBrief } from '../lib/brief';

export default async function BriefPage() {
  const brief = await loadBrief();
  const held = brief.entries.filter((entry) => entry.awaitingConfirmation).length;

  return (
    <div className="brief">
      <header className="masthead">
        <p className="masthead-kicker mono">Flank · competitor radar · M1 fixture brief</p>
        <h1>{brief.competitorName}</h1>
        <p className="masthead-sub">
          <span className="mono">{brief.competitorDomain}</span> · {brief.sourceCount} sources
          tracked · {brief.entries.length} deltas on record · {held} held for confirmation
        </p>
      </header>

      <main>
        <section aria-labelledby="timeline-heading" className="timeline-section">
          <h2 id="timeline-heading">Change timeline</h2>
          <p className="section-note">
            Every entry below is a hash-gated diff with span-pinned provenance: the exact quote, its
            character offsets, the source URL, and the capture time. Pricing deltas stay pending
            until a clean re-fetch confirms them — no single-fetch pricing alert, ever.
          </p>
          <Timeline entries={brief.entries} />
        </section>

        <CoverageReceipt coverage={brief.coverage} triageMode={brief.triageMode} />
      </main>

      <footer className="colophon">
        <p className="mono">
          read-only brief rendered from checked-in fixtures · deterministic mock triage · no
          database · no API keys
        </p>
      </footer>
    </div>
  );
}
