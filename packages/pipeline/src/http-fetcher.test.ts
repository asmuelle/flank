import type { FetchRequest } from '@flank/core';
import { describe, expect, it } from 'vitest';
import { FetchError, HttpFetcher, type HttpFetcherOptions } from './http-fetcher';

const PRICING: Pick<FetchRequest, 'sourceType' | 'adapter'> = {
  sourceType: 'pricing',
  adapter: 'html',
};
const PUBLIC_IP = '93.184.216.34';

const req = (url: string, over: Partial<FetchRequest> = {}): FetchRequest => ({
  url,
  sourceType: PRICING.sourceType,
  adapter: PRICING.adapter,
  ...over,
});

const fetcherWith = (
  responses: Record<string, Response>,
  options: Partial<HttpFetcherOptions> = {},
): { fetcher: HttpFetcher; calls: string[] } => {
  const calls: string[] = [];
  const fetcher = new HttpFetcher({
    resolveHost: async () => [PUBLIC_IP],
    fetchImpl: async (url) => {
      calls.push(url);
      const response = responses[url];
      if (response === undefined) throw new Error(`unexpected url ${url}`);
      return response;
    },
    ...options,
  });
  return { fetcher, calls };
};

describe('HttpFetcher', () => {
  it('fetches a 200 and returns content, status and final url', async () => {
    const { fetcher } = fetcherWith({
      'https://rival.example/pricing': new Response('<html>$59</html>', { status: 200 }),
    });

    const result = await fetcher.fetch(req('https://rival.example/pricing'));

    expect(result.rawContent).toBe('<html>$59</html>');
    expect(result.httpStatus).toBe(200);
    expect(result.finalUrl).toBe('https://rival.example/pricing');
  });

  it('sends a courtesy User-Agent and an adapter-appropriate Accept header', async () => {
    let captured: RequestInit | undefined;
    const fetcher = new HttpFetcher({
      resolveHost: async () => [PUBLIC_IP],
      fetchImpl: async (_url, init) => {
        captured = init;
        return new Response('ok', { status: 200 });
      },
    });

    await fetcher.fetch(req('https://rival.example/feed', { adapter: 'rss' }));

    const headers = captured?.headers as Record<string, string>;
    expect(headers['user-agent']).toContain('FlankBot');
    expect(headers.accept).toContain('rss');
  });

  it('returns a non-2xx response as a result rather than throwing', async () => {
    const { fetcher } = fetcherWith({
      'https://rival.example/gone': new Response('not found', { status: 404 }),
    });

    const result = await fetcher.fetch(req('https://rival.example/gone'));

    expect(result.httpStatus).toBe(404);
  });

  it('rejects a non-http(s) scheme without fetching', async () => {
    const { fetcher, calls } = fetcherWith({});
    await expect(fetcher.fetch(req('ftp://rival.example/x'))).rejects.toBeInstanceOf(FetchError);
    expect(calls).toEqual([]);
  });

  it('rejects a prohibited source host (Invariant 4) without fetching', async () => {
    const { fetcher, calls } = fetcherWith({});
    await expect(fetcher.fetch(req('https://www.g2.com/products/x'))).rejects.toThrow(/prohibited/);
    expect(calls).toEqual([]);
  });

  it('refuses a host that resolves to a private address (SSRF) without fetching', async () => {
    const calls: string[] = [];
    const fetcher = new HttpFetcher({
      resolveHost: async () => ['10.0.0.5'],
      fetchImpl: async (url) => {
        calls.push(url);
        return new Response('', { status: 200 });
      },
    });

    await expect(fetcher.fetch(req('https://rival.example/x'))).rejects.toThrow(/SSRF/);
    expect(calls).toEqual([]);
  });

  it('refuses a blocked IP literal without resolving DNS', async () => {
    const fetcher = new HttpFetcher({
      resolveHost: async () => {
        throw new Error('DNS should not be called for an IP literal');
      },
      fetchImpl: async () => new Response('', { status: 200 }),
    });

    await expect(fetcher.fetch(req('http://169.254.169.254/latest/meta-data'))).rejects.toThrow(
      /SSRF/,
    );
  });

  it('follows a redirect to a public host', async () => {
    const { fetcher, calls } = fetcherWith({
      'https://rival.example/p': new Response(null, {
        status: 302,
        headers: { location: 'https://rival.example/p2' },
      }),
      'https://rival.example/p2': new Response('final', { status: 200 }),
    });

    const result = await fetcher.fetch(req('https://rival.example/p'));

    expect(result.rawContent).toBe('final');
    expect(calls).toEqual(['https://rival.example/p', 'https://rival.example/p2']);
  });

  it('re-validates redirect targets and blocks a bounce to an internal address', async () => {
    const fetcher = new HttpFetcher({
      resolveHost: async (host) => (host === 'rival.example' ? [PUBLIC_IP] : ['10.0.0.9']),
      fetchImpl: async (url) =>
        url === 'https://rival.example/p'
          ? new Response(null, { status: 302, headers: { location: 'https://internal.invalid/' } })
          : new Response('should not reach', { status: 200 }),
    });

    await expect(fetcher.fetch(req('https://rival.example/p'))).rejects.toThrow(/SSRF/);
  });

  it('caps redirect chains', async () => {
    const fetcher = new HttpFetcher({
      resolveHost: async () => [PUBLIC_IP],
      maxRedirects: 2,
      fetchImpl: async (url) => {
        const n = Number(new URL(url).searchParams.get('n') ?? '0');
        return new Response(null, {
          status: 302,
          headers: { location: `https://rival.example/?n=${n + 1}` },
        });
      },
    });

    await expect(fetcher.fetch(req('https://rival.example/?n=0'))).rejects.toThrow(/too many/);
  });

  it('times out a hanging request', async () => {
    const fetcher = new HttpFetcher({
      resolveHost: async () => [PUBLIC_IP],
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });

    await expect(fetcher.fetch(req('https://rival.example/slow'))).rejects.toThrow(/timed out/);
  });

  it('refuses unblocker adapters until they are configured (#6)', async () => {
    const { fetcher } = fetcherWith({});
    await expect(
      fetcher.fetch(req('https://rival.example/x', { adapter: 'firecrawl' })),
    ).rejects.toThrow(/not configured/);
  });
});
