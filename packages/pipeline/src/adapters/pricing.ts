import { AdapterError } from './errors';

const decodeEntities = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&copy;/g, '©')
    .replace(/&nbsp;/g, ' ');

/**
 * Normalize a pricing/docs HTML page into canonical text. Scripts, styles and
 * markup are stripped so A/B-test config churn in <script> blocks never
 * produces a delta — only rendered text changes do (false-positive discipline,
 * Invariant 3 starts here).
 */
export const normalizePricingHtml = (html: string): string => {
  if (!/<[a-z!]/i.test(html)) {
    throw new AdapterError('pricing payload does not look like HTML');
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/(p|h[1-6]|li|tr|section|article|div|nav|footer|header|main|ul|ol)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const lines = decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
  return lines.join('\n');
};
