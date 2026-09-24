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
