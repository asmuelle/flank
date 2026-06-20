import { z } from 'zod';
import type { TokenUsage } from './cogs';
import type { TriageClass } from './entities';

/** A material claim offered to synthesis as a candidate citation for a section. */
export interface CandidateClaim {
  readonly id: string;
  readonly quoteText: string;
  readonly sourceUrl: string;
  readonly triageClass: TriageClass;
  readonly rationale: string;
}

/** Regenerate ONE section (dossier or battlecard) from its prior content + new material claims. */
export interface SynthesisRequest {
  readonly surface: 'dossier' | 'battlecard';
  readonly kind: string;
  readonly competitorName: string;
  /** The stable prior section content (prompt-cached); null on the first version. */
  readonly previousContentMd: string | null;
  readonly candidateClaims: readonly CandidateClaim[];
}

/**
 * The model's ANSWER for a section: regenerated markdown + the candidate claim ids it cites. Usage
 * is transport telemetry (the cost input), carried separately and validated by TokenUsageSchema —
 * it never flows through {@link SynthesisResultSchema}.
 */
export interface SynthesisResult {
  readonly contentMd: string;
  readonly citedClaimIds: readonly string[];
  readonly usage?: TokenUsage;
}

/** Anything regenerating sections (deterministic mock or live Sonnet Batch) implements this. */
export interface SynthesisClient {
  synthesize(request: SynthesisRequest): Promise<SynthesisResult>;
}

/** Boundary validation for the synthesis model's answer — never trust LLM output (AGENTS.md). */
export const SynthesisResultSchema = z.object({
  contentMd: z.string().min(1),
  citedClaimIds: z.array(z.string().min(1)).min(1),
});
