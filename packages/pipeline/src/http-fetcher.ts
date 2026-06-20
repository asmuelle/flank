import {
  isBlockedIpAddress,
  isIpAddress,
  isProhibitedSourceHost,
  type Fetcher,
  type FetchRequest,
  type FetchResult,
  type SourceAdapter,
} from '@flank/core';

const DEFAULT_USER_AGENT = 'FlankBot/1.0 (+https://flank.example/bot)';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Raised by the fetch layer. Ingest treats it as a first-class fetch failure (Invariant 7). */
export class FetchError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'FetchError';
  }
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;
type ResolveHost = (host: string) => Promise<readonly string[]>;

export interface HttpFetcherOptions {
  readonly fetchImpl?: FetchImpl;
  readonly resolveHost?: ResolveHost;
  readonly userAgent?: string;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

const defaultResolveHost: ResolveHost = async (host) => {
  // Lazy import keeps node:dns off the module's top-level (web transpiles this package's barrel).
  const { lookup } = await import('node:dns/promises');
  const results = await lookup(host, { all: true });
  return results.map((entry) => entry.address);
};

const acceptHeaderFor = (adapter: SourceAdapter): string => {
  switch (adapter) {
    case 'rss':
      return 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8';
    case 'json':
      return 'application/json';
    default:
      return 'text/html, application/xhtml+xml;q=0.9, */*;q=0.5';
  }
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const stripBrackets = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

/**
 * Direct-GET fetcher for the legal-first source graph (rss/json/html adapters). Hardened against
 * SSRF: rejects non-http(s) schemes and prohibited hosts (Invariant 4), resolves each host and
 * refuses any private/loopback/link-local/metadata address, and re-validates every redirect hop so
 * a public URL cannot bounce to an internal one. Timeout via AbortController; courtesy User-Agent.
 * Unblocker adapters (firecrawl/zyte) are deferred (fetch track #6).
 */
export class HttpFetcher implements Fetcher {
  private readonly fetchImpl: FetchImpl;
  private readonly resolveHost: ResolveHost;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly maxRedirects: number;

  constructor(options: HttpFetcherOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
    this.resolveHost = options.resolveHost ?? defaultResolveHost;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  }

  async fetch(request: FetchRequest): Promise<FetchResult> {
    if (request.adapter === 'firecrawl' || request.adapter === 'zyte') {
      throw new FetchError(
        `unblocker adapter '${request.adapter}' is not configured yet (fetch track #6)`,
      );
    }
    return this.get(request.url, request.adapter, 0);
  }

  private async get(
    url: string,
    adapter: SourceAdapter,
    redirectCount: number,
  ): Promise<FetchResult> {
    const target = this.assertSafeUrl(url);
    await this.assertResolvesPublic(target.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': this.userAgent, accept: acceptHeaderFor(adapter) },
      });
    } catch (error) {
      throw new FetchError(
        controller.signal.aborted
          ? `fetch timed out after ${this.timeoutMs}ms: ${url}`
          : `fetch failed: ${url}: ${messageOf(error)}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirectCount >= this.maxRedirects) {
        throw new FetchError(`too many redirects (> ${this.maxRedirects}) for ${url}`);
      }
      const location = response.headers.get('location');
      if (location === null || location === '') {
        throw new FetchError(`redirect ${response.status} without a Location header: ${url}`);
      }
      return this.get(new URL(location, url).toString(), adapter, redirectCount + 1);
    }

    const rawContent = await response.text();
    return Object.freeze({ rawContent, httpStatus: response.status, finalUrl: url });
  }

  private assertSafeUrl(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new FetchError(`invalid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new FetchError(`unsupported scheme '${parsed.protocol}' (only http/https): ${url}`);
    }
    if (isProhibitedSourceHost(stripBrackets(parsed.hostname))) {
      throw new FetchError(`host '${parsed.hostname}' is a prohibited source (Invariant 4)`);
    }
    return parsed;
  }

  private async assertResolvesPublic(hostname: string): Promise<void> {
    const host = stripBrackets(hostname);
    if (isIpAddress(host)) {
      if (isBlockedIpAddress(host)) {
        throw new FetchError(`refusing to fetch blocked address ${host} (SSRF guard)`);
      }
      return;
    }
    const addresses = await this.resolveHost(host);
    if (addresses.length === 0) {
      throw new FetchError(`cannot resolve host ${host}`);
    }
    for (const address of addresses) {
      if (isBlockedIpAddress(address)) {
        throw new FetchError(`${host} resolves to blocked address ${address} (SSRF guard)`);
      }
    }
  }
}
