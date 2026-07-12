import { parseFragment, type DefaultTreeAdapterMap } from 'parse5';
import { AdapterError } from './errors';

type HtmlNode = DefaultTreeAdapterMap['node'];
type HtmlTextNode = DefaultTreeAdapterMap['textNode'];

const BLOCK_TAGS = new Set([
  'article',
  'div',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'section',
  'tr',
  'ul',
]);
const HIDDEN_TAGS = new Set(['head', 'script', 'style', 'template']);

const isTextNode = (node: HtmlNode): node is HtmlTextNode => node.nodeName === '#text';

const appendText = (node: HtmlNode, chunks: string[]): boolean => {
  if (isTextNode(node)) {
    chunks.push(node.value);
    return false;
  }
  if (node.nodeName === '#comment') return false;

  const tagName = 'tagName' in node ? node.tagName.toLowerCase() : undefined;
  if (tagName !== undefined && HIDDEN_TAGS.has(tagName)) return true;
  if (tagName === 'br') chunks.push('\n');

  let hasElement = tagName !== undefined;
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      hasElement = appendText(child, chunks) || hasElement;
    }
  }
  if (tagName !== undefined && BLOCK_TAGS.has(tagName)) chunks.push('\n');
  return hasElement;
};

/**
 * Normalize a pricing/docs HTML page into canonical text. parse5 handles malformed markup and
 * character references without regex tag filtering or repeated entity decoding.
 */
export const normalizePricingHtml = (html: string): string => {
  const fragment = parseFragment(html);
  const chunks: string[] = [];
  if (!appendText(fragment, chunks)) {
    throw new AdapterError('pricing payload does not look like HTML');
  }

  const lines = chunks
    .join('')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
  return lines.join('\n');
};
