import type { SourceType } from '@flank/core';
import { AdapterError } from './errors';
import { normalizeGreenhouse } from './greenhouse';
import { normalizePricingHtml } from './pricing';
import { normalizeRss } from './rss';

export { AdapterError } from './errors';
export { normalizeGreenhouse } from './greenhouse';
export { normalizePricingHtml } from './pricing';
export { normalizeRss } from './rss';

/**
 * Adapter registry for the legal-first source graph (Invariant 4): RSS feeds,
 * public job-board JSON, and direct-fetch HTML. There is deliberately no
 * G2/Capterra adapter — those are license-only.
 */
export const normalizeForSource = (sourceType: SourceType, rawContent: string): string => {
  switch (sourceType) {
    case 'changelog':
    case 'blog':
    case 'status':
      return normalizeRss(rawContent);
    case 'jobs':
      return normalizeGreenhouse(rawContent);
    case 'pricing':
    case 'docs':
      return normalizePricingHtml(rawContent);
    case 'reviews':
      throw new AdapterError('review streams are license-only (Invariant 4) — no adapter exists');
    case 'appstore':
      throw new AdapterError('app-store adapter lands in M2');
  }
};
