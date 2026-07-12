import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { AdapterError } from './errors';

const RssItemSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  pubDate: z.string(),
});

const RssDocumentSchema = z.object({
  rss: z.object({
    channel: z.object({
      item: z.union([RssItemSchema, z.array(RssItemSchema)]).optional(),
    }),
  }),
});

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  processEntities: true,
  trimValues: true,
});

const parseRss = (xml: string): z.infer<typeof RssDocumentSchema> => {
  if (xml.toUpperCase().includes('<!DOCTYPE')) {
    throw new AdapterError('RSS documents with a DTD are not accepted');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new AdapterError(`invalid RSS XML: ${validation.err.msg}`);
  }

  const parsed = RssDocumentSchema.safeParse(parser.parse(xml));
  if (!parsed.success) {
    throw new AdapterError(`not a valid RSS 2.0 document: ${parsed.error.message}`);
  }
  return parsed.data;
};

export const normalizeRss = (xml: string): string => {
  const rawItems = parseRss(xml).rss.channel.item;
  const items = rawItems === undefined ? [] : Array.isArray(rawItems) ? rawItems : [rawItems];
  return items
    .map(({ pubDate, title, description }) => `${pubDate} | ${title} — ${description}`.trim())
    .join('\n');
};
