import { describe, expect, it } from 'vitest';
import type { AlertPayload } from './alerts';
import { renderEmailAlert, renderSlackAlert } from './alert-render';

const payload = (over: Partial<AlertPayload> = {}): AlertPayload => ({
  deltaId: 'd-1',
  competitorName: 'Acme Analytics',
  whatChanged: 'feature_launch (materiality 2/3)',
  quote: 'We now ship an Enterprise tier.',
  sourceUrl: 'https://acme.example/blog',
  capturedAt: new Date('2026-06-12T07:00:00Z'),
  rationale: 'Acme moves upmarket.',
  ...over,
});

describe('renderSlackAlert', () => {
  it('carries the headline, rationale, quote, and a source link', () => {
    const message = renderSlackAlert(payload());
    expect(message.text).toContain('Acme Analytics');
    expect(message.text).toContain('We now ship an Enterprise tier.');
    expect(message.text).toContain('https://acme.example/blog');
    const json = JSON.stringify(message.blocks);
    expect(json).toContain('Enterprise tier');
    expect(json).toContain('acme.example/blog');
  });

  it('does not link a non-http source url', () => {
    const message = renderSlackAlert(payload({ sourceUrl: 'javascript:alert(1)' }));
    expect(JSON.stringify(message.blocks)).not.toContain('javascript:');
  });

  it('neutralizes mrkdwn link/mention injection in scraped quote + rationale', () => {
    const message = renderSlackAlert(
      payload({
        quote: '<https://attacker.example/reset|Reset your password>',
        rationale: '<!channel> urgent re-auth',
      }),
    );
    const json = JSON.stringify(message.blocks) + message.text;
    // No raw mrkdwn link or broadcast token survives — control chars are entity-escaped.
    expect(json).not.toContain('<https://attacker.example');
    expect(json).not.toContain('<!channel>');
    expect(json).toContain('&lt;');
  });
});

describe('renderEmailAlert', () => {
  it('builds subject, plain text, and html with the core facts', () => {
    const message = renderEmailAlert(payload());
    expect(message.subject).toBe('[Flank] Acme Analytics: feature_launch (materiality 2/3)');
    expect(message.text).toContain('Acme moves upmarket.');
    expect(message.text).toContain('https://acme.example/blog');
    expect(message.html).toContain('<h2>');
    expect(message.html).toContain('href="https://acme.example/blog"');
  });

  it('escapes hostile scraped content and never emits a script tag (XSS boundary)', () => {
    const message = renderEmailAlert(
      payload({
        quote: '<script>alert("xss")</script>',
        competitorName: 'Evil & Co "Inc"',
      }),
    );
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).toContain('Evil &amp; Co &quot;Inc&quot;');
  });

  it('neutralizes a javascript: source url in the href', () => {
    const message = renderEmailAlert(payload({ sourceUrl: 'javascript:alert(1)' }));
    expect(message.html).toContain('href="#"');
    expect(message.html).not.toContain('href="javascript:');
  });
});
