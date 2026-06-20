import type { SourceAdapter, SourceType } from './entities';

/** What to fetch: the source URL plus its type (parser) and adapter (transport). */
export interface FetchRequest {
  readonly url: string;
  readonly sourceType: SourceType;
  readonly adapter: SourceAdapter;
}

/** The raw bytes of a fetch, with the real HTTP status and the final URL after any redirects. */
export interface FetchResult {
  readonly rawContent: string;
  readonly httpStatus: number;
  readonly finalUrl: string;
}

/**
 * Transport port for retrieving source content. Implementations live in the pipeline (real HTTP,
 * unblockers). Keeping the port here lets the ingest orchestration depend on the contract, not the
 * I/O — and lets tests inject a deterministic fetcher.
 */
export interface Fetcher {
  fetch(request: FetchRequest): Promise<FetchResult>;
}
