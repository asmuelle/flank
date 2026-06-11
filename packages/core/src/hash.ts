import { createHash } from 'node:crypto';

/**
 * Content hash over normalized text. The hash gate (Invariant 2): an LLM call
 * on source content is only permitted when this value changed between fetches.
 */
export const contentHash = (normalizedText: string): string =>
  createHash('sha256').update(normalizedText, 'utf8').digest('hex');
