import type { AlertPayload } from './alerts';

export interface SlackMessage {
  /** Plain-text fallback (notification preview). */
  readonly text: string;
  /** Slack Block Kit blocks. */
  readonly blocks: readonly unknown[];
}

export interface EmailMessage {
  readonly subject: string;
  /** Plain-text body — the accessible fallback. */
  readonly text: string;
  /** HTML body — every interpolated (scraped) value is escaped; links are scheme-checked. */
  readonly html: string;
}

/** Escape the five HTML-significant characters. Alert content is scraped competitor text (untrusted). */
const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Escape Slack mrkdwn control characters (& < > — `&` first). In mrkdwn `<url|label>` is a clickable
 * link and `<!channel>`/`<!everyone>` are broadcast pings, so scraped competitor text MUST be escaped
 * before it goes into a mrkdwn field — otherwise a hostile source page injects phishing links or @channel
 * pings into the victim workspace's Slack (the email path's escapeHtml is the analogue).
 */
const escapeMrkdwn = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Only http(s) URLs may become an href — never `javascript:`/`data:` from a scraped source field. */
const safeHref = (url: string): string => (/^https?:\/\//i.test(url) ? url : '#');

const formatStamp = (date: Date): string => date.toUTCString().replace(' GMT', ' UTC');

/**
 * Render an alert as a Slack Block Kit message. Slack markdown (`mrkdwn`) is not HTML, so the quote
 * is emitted as a `>` blockquote; the plain-text fallback carries the same facts for the push preview.
 */
export const renderSlackAlert = (alert: AlertPayload): SlackMessage => {
  // The header is a plain_text block (Slack renders it literally — no link/mention parsing), so the
  // raw headline is safe there; every mrkdwn field and the mrkdwn-parsed fallback escape scraped text.
  const headline = `${alert.competitorName} — ${alert.whatChanged}`;
  const text = `${escapeMrkdwn(headline)}\n${escapeMrkdwn(alert.rationale)}\n“${escapeMrkdwn(alert.quote)}”\n${alert.sourceUrl}`;
  const blocks: readonly unknown[] = [
    { type: 'header', text: { type: 'plain_text', text: headline, emoji: false } },
    { type: 'section', text: { type: 'mrkdwn', text: escapeMrkdwn(alert.rationale) } },
    { type: 'section', text: { type: 'mrkdwn', text: `> ${escapeMrkdwn(alert.quote)}` } },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `<${safeHref(alert.sourceUrl)}|source>` },
        { type: 'mrkdwn', text: formatStamp(alert.capturedAt) },
      ],
    },
  ];
  return Object.freeze({ text, blocks: Object.freeze(blocks) });
};

/**
 * Render an alert as an email. The subject + plain text are the accessible core; the HTML escapes
 * every scraped value and only links a scheme-checked source URL (XSS boundary).
 */
export const renderEmailAlert = (alert: AlertPayload): EmailMessage => {
  const subject = `[Flank] ${alert.competitorName}: ${alert.whatChanged}`;
  const stamp = formatStamp(alert.capturedAt);
  const text = [
    `${alert.competitorName} — ${alert.whatChanged}`,
    '',
    alert.rationale,
    '',
    `"${alert.quote}"`,
    `Source: ${alert.sourceUrl}`,
    `Captured: ${stamp}`,
  ].join('\n');

  const href = safeHref(alert.sourceUrl);
  const html = [
    `<h2>${escapeHtml(alert.competitorName)} — ${escapeHtml(alert.whatChanged)}</h2>`,
    `<p>${escapeHtml(alert.rationale)}</p>`,
    `<blockquote>${escapeHtml(alert.quote)}</blockquote>`,
    `<p><a href="${escapeHtml(href)}">${escapeHtml(alert.sourceUrl)}</a></p>`,
    `<p><small>Captured ${escapeHtml(stamp)}</small></p>`,
  ].join('\n');

  return Object.freeze({ subject, text, html });
};
