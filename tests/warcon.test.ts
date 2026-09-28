import { describe, expect, test } from 'vitest';
import { CloudflareBlockedError, WarconAuthError, WarconClient } from '../src/warcon.js';

const opts = { baseUrl: 'http://warcon:3000', token: 'tok', timeoutMs: 1000 };

const reply = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });

describe('WarconClient', () => {
  test('sends the bearer token and returns parsed JSON', async () => {
    let seen: Request | null = null;
    const client = new WarconClient({
      ...opts,
      fetchImpl: async (url, init) => {
        seen = new Request(url as string, init);
        return reply({ ok: true, value: 7 });
      }
    });
    const body = await client.getJson<{ value: number }>('/api/thing');
    expect(body.value).toBe(7);
    expect(seen!.headers.get('authorization')).toBe('Bearer tok');
    expect(seen!.url).toBe('http://warcon:3000/api/thing');
  });

  test('adds Cloudflare service-token headers when both are set', async () => {
    let seen: Request | null = null;
    const client = new WarconClient({
      ...opts,
      cfClientId: 'cid',
      cfClientSecret: 'csec',
      fetchImpl: async (url, init) => {
        seen = new Request(url as string, init);
        return reply({ ok: true });
      }
    });
    await client.getJson('/api/thing');
    expect(seen!.headers.get('cf-access-client-id')).toBe('cid');
    expect(seen!.headers.get('cf-access-client-secret')).toBe('csec');
  });

  test('a redirect to cloudflareaccess.com is a CloudflareBlockedError', async () => {
    const client = new WarconClient({
      ...opts,
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://x.cloudflareaccess.com/login' }
        })
    });
    await expect(client.getJson('/api/thing')).rejects.toBeInstanceOf(CloudflareBlockedError);
  });

  test('a non-JSON body is a CloudflareBlockedError, not a parse crash', async () => {
    const client = new WarconClient({
      ...opts,
      fetchImpl: async () =>
        new Response('<html>login</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
    });
    await expect(client.getJson('/api/thing')).rejects.toBeInstanceOf(CloudflareBlockedError);
  });

  test('an HTML error page reports its status and path, not Cloudflare', async () => {
    const client = new WarconClient({
      ...opts,
      fetchImpl: async () =>
        new Response('<html>Not found</html>', {
          status: 404,
          headers: { 'content-type': 'text/html' }
        })
    });
    const err = await client.getJson('/api/servers/s1/kills').catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(CloudflareBlockedError);
    expect(String(err)).toContain('404');
    expect(String(err)).toContain('/api/servers/s1/kills');
  });

  test('401 and 403 are WarconAuthError', async () => {
    for (const status of [401, 403]) {
      const client = new WarconClient({
        ...opts,
        fetchImpl: async () => reply({ ok: false }, { status })
      });
      await expect(client.getJson('/api/thing')).rejects.toBeInstanceOf(WarconAuthError);
    }
  });

  test('other non-ok statuses throw a plain error naming the status', async () => {
    const client = new WarconClient({
      ...opts,
      fetchImpl: async () => reply({ ok: false }, { status: 503 })
    });
    await expect(client.getJson('/api/thing')).rejects.toThrow(/503/);
  });
});

describe('WarconClient.postAction', () => {
  test('POSTs JSON with the bearer token and reports success', async () => {
    let seen: Request | null = null;
    const client = new WarconClient({
      ...opts,
      fetchImpl: async (url, init) => {
        seen = new Request(url as string, init);
        return reply({ ok: true, action: 'kick' });
      }
    });
    const result = await client.postAction('/api/servers/s1/rcon/kick', { steamId: '765', reason: 'r' });
    expect(result).toEqual({ ok: true });
    expect(seen!.method).toBe('POST');
    expect(seen!.headers.get('authorization')).toBe('Bearer tok');
    expect(seen!.headers.get('content-type')).toBe('application/json');
    expect(await seen!.json()).toEqual({ steamId: '765', reason: 'r' });
  });

  test("a refusal resolves with Warcon's own message and status rather than throwing", async () => {
    const client = new WarconClient({
      ...opts,
      fetchImpl: async () => reply({ ok: false, error: { message: 'Player is not on the server.' } }, { status: 404 })
    });
    expect(await client.postAction('/api/servers/s1/rcon/kick', {})).toEqual({
      ok: false,
      status: 404,
      message: 'Player is not on the server.'
    });
  });

  test('a refusal without a JSON body still says what failed', async () => {
    const client = new WarconClient({
      ...opts,
      fetchImpl: async () => new Response('<html>oops</html>', { status: 502, headers: { 'content-type': 'text/html' } })
    });
    expect(await client.postAction('/api/servers/s1/rcon/kick', {})).toEqual({
      ok: false,
      status: 502,
      message: 'warcon request failed (502)'
    });
  });

  test('a network failure resolves as a failure, not a throw', async () => {
    const client = new WarconClient({
      ...opts,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      }
    });
    expect(await client.postAction('/api/servers/s1/rcon/kick', {})).toEqual({
      ok: false,
      status: 0,
      message: 'fetch failed'
    });
  });

  test('sends PUT when asked', async () => {
    let method = '';
    const client = new WarconClient({
      ...opts,
      fetchImpl: async (_url, init) => {
        method = init?.method ?? '';
        return reply({ ok: true });
      }
    });
    await client.postAction('/api/servers/s1/players/765/watch', { watched: true }, 'PUT');
    expect(method).toBe('PUT');
  });
});
