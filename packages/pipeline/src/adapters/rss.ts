import { z } from 'zod';
import { AdapterError } from './errors';

const RssItemSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  pubDate: z.string(),
});

const decodeEntities = (text: string): string =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const extractTag = (block: string, tag: string): string => {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!match) return '';
  const inner = match[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(inner);
  return decodeEntities((cdata ? cdata[1] : inner).trim());
};

/**
 * Normalize an RSS 2.0 changelog feed into canonical text: one line per item,
 * in document order. Deliberately a constrained subset parser — fixtures and
 * the legal-first source graph (Invariant 4) use plain RSS, not arbitrary XML.
 */
export const normalizeRss = (xml: string): string => {
  if (!/<rss[\s>]/i.test(xml) || !/<channel[\s>]/i.test(xml)) {
    throw new AdapterError('not an RSS 2.0 document: missing <rss>/<channel>');
  }
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/gi) ?? [];
  const lines = blocks.map((block, index) => {
    const candidate = {
      title: extractTag(block, 'title'),
      description: extractTag(block, 'description'),
      pubDate: extractTag(block, 'pubDate'),
    };
    const parsed = RssItemSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new AdapterError(`invalid RSS item at index ${index}: ${parsed.error.message}`);
    }
    const { pubDate, title, description } = parsed.data;
    return `${pubDate} | ${title} — ${description}`.trim();
  });
  return lines.join('\n');
};
