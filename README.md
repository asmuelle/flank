# Flank

> The living competitor radar for B2B SaaS: always-on agents maintain versioned, citation-pinned dossiers and self-refreshing battlecards per rival, pushing only material deltas — what changed, why it matters, how to respond — at 1/50th to 1/100th of a Klue contract.

**Category:** LLM wiki / auto-research (living documents + delta alerts, à la Karpathy)

## Concept

The living competitor radar for B2B SaaS: always-on agents maintain versioned, citation-pinned dossiers and self-refreshing battlecards per rival, pushing only material deltas — what changed, why it matters, how to respond — at 1/50th to 1/100th of a Klue contract.

## Target User

Self-serve wedge: founders and PMMs at seed-to-Series-B SaaS (5-200 employees) rotting in Google Alerts noise. Expansion: PMMs and sales leaders at 20-500 employee SaaS. Immediate beachhead: churned and orphaned Klue/Crayon accounts actively re-pricing CI after Klue's 40% staff cut — buyers who already believe AI can do this job and just lost their vendor.

## Auto-Research Mechanic (the living document + delta engine)

Per-competitor standing agent over a fixed source graph: pricing pages, changelogs/release notes, docs diffs, app-store listings, job boards (Greenhouse/Lever/Ashby), G2/Capterra review streams, status pages, blog/PR/RSS, funding databases, SEO/ad-copy snapshots. Content-hash diffing plus Exa-style monitors means the LLM only sees changed content; Haiku-class triage classifies deltas for materiality (pricing change, feature launch, repositioning, leadership hire, hiring signal); one nightly frontier pass updates the dossier and regenerates only affected battlecard sections, never the whole artifact. Every claim pinned at extraction (quote + URL + timestamp) and span-verified before publish — direct attack on the 37% citation-misattribution problem. Deal-context alerts fire when a tracked competitor attaches to an open CRM opportunity. Full longitudinal change timeline per competitor. COGS single-digit dollars per account via batch (50% off) stacked with cache reads.

## Product Surface

Web SaaS (dossier library, change-log timeline, battlecards) + Slack app and email digest as the daily touchpoint — deltas must land where the team lives or it becomes the Google Alerts failure mode. HubSpot/Salesforce sidebar widget and Notion export at team tier.

## Why Now (2026 timing)

Klue laid off 40% of staff (June 2025) with internal docs citing deals lost to ChatGPT — the category is being repriced right now and churned accounts are in-market. Google Alerts abandoned by 92% of MI professionals. Unit costs fell ~80% 2025→2026, making $79-449 comfortably profitable. Gemini's Deep Research API is explicitly single-turn with no cross-run memory, so 'what changed since last run, with provenance' is structurally unowned territory.

## Tech Stack & Unit Economics

Crawl/diff layer: sitemap+RSS+changelog feeds first; Firecrawl change-tracking or self-hosted Playwright behind Zyte/Bright Data unblockers for Cloudflare-protected pricing/docs pages; Greenhouse/Lever/Ashby public JSON endpoints for hiring signals (free, legal); app-store RSS/APIs; Exa websets/monitors for new-page and news discovery; skip or license G2 data (scraping is legal exposure). Storage: Postgres + pgvector for dossier versions and claim spans, S3 for raw HTML snapshots, SimHash/content-hash dedupe so LLMs only see changed spans. Models: Claude Haiku 4.5 for delta triage/materiality classification on changed content only; Claude Sonnet 4.6 nightly dossier/battlecard regeneration via Batch API (50% discount) with prompt caching on the stable dossier context; citation grounding via exact-quote extraction with character offsets, string-verified against the stored snapshot before publish (catches misattribution, NOT recall misses). Orchestration: Temporal or Inngest standing workflows per competitor; per-source adaptive cadence (daily for pricing/changelog, weekly for jobs/reviews). Delivery: Next.js dashboard, Slack Bolt app, Resend email digests; Salesforce/HubSpot canvas widget at Team tier. Unit economics per $199 Growth account (15 competitors, ~150 sources, daily cadence): crawl/proxy/unblocker $6-15, Exa/SERP API $3-8, LLM (Haiku triage ~5M tok + Sonnet batch ~10M in/2M out with caching) $4-8, infra/storage $2 = roughly $15-30/mo COGS, i.e. 85-92% gross margin — viable, but the pitched $8 assumes free crawling and omits review/ads/funding data; licensing any of those (G2 API, SEMrush, Crunchbase) adds $20-50+/account-equivalent and erodes margin fast at Starter tier.
