/** The panel sits behind Cloudflare Access and our request never reached Warcon. */
export class CloudflareBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudflareBlockedError';
  }
}

/** We reached Warcon and it refused our API key. */
export class WarconAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WarconAuthError';
  }
}

export interface WarconClientOptions {
  baseUrl: string;
  token: string;
  cfClientId?: string | null;
  cfClientSecret?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class WarconClient {
  constructor(private readonly opts: WarconClientOptions) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.opts.token}`,
      Accept: 'application/json'
    };
    if (this.opts.cfClientId && this.opts.cfClientSecret) {
      headers['CF-Access-Client-Id'] = this.opts.cfClientId;
      headers['CF-Access-Client-Secret'] = this.opts.cfClientSecret;
    }
    return headers;
  }

  /** `path` includes any query string, e.g. `/api/audit?category=rcon`. */
  async getJson<T>(path: string): Promise<T> {
    const res = await this.get(path);
    const contentType = res.headers.get('content-type') ?? '';
    if (!/application\/json/i.test(contentType)) {
      throw new CloudflareBlockedError(
        `blocked by Cloudflare Access (non-JSON response, content-type: ${contentType || 'none'})`
      );
    }
    return (await res.json()) as T;
  }

  /**
   * A CSV download (the leaderboard export). Cloudflare's login page is HTML, so anything
   * but `text/csv` is read as a block, the way `getJson` reads anything but JSON.
   */
  async getCsv(path: string): Promise<string> {
    const res = await this.get(path);
    const contentType = res.headers.get('content-type') ?? '';
    if (!/text\/csv/i.test(contentType)) {
      throw new CloudflareBlockedError(
        `blocked by Cloudflare Access (non-CSV response, content-type: ${contentType || 'none'})`
      );
    }
    return res.text();
  }

  /** A GET that reached Warcon and succeeded; every other outcome throws, named. */
  private async get(path: string): Promise<Response> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);

    let res: Response;
    try {
      res = await doFetch(`${this.opts.baseUrl}${path}`, {
        headers: this.headers(),
        redirect: 'manual',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location') ?? '';
      if (/cloudflareaccess\.com/i.test(location)) {
        throw new CloudflareBlockedError(
          `blocked by Cloudflare Access (redirected to ${location}) — service token missing, expired, or no Service Auth policy matches`
        );
      }
      throw new Error(`unexpected redirect ${res.status} to ${location}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new WarconAuthError(
        `warcon auth rejected (${res.status}) on ${path} — check WARCON_TOKEN and that the key has server.view and audit.read`
      );
    }

    // Status before content type: a 404 or 500 comes back as an HTML error page, and
    // calling that Cloudflare sends the reader after the wrong layer entirely.
    if (!res.ok) throw new Error(`warcon request failed (${res.status}) on ${path}`);
    return res;
  }

  /**
   * POST (or PUT) a panel action (e.g. `/api/servers/{id}/rcon/kick`). Unlike `getJson`, a refusal
   * or a network failure resolves with a message instead of throwing: the caller shows it
   * to a person, and Warcon's own wording ("not on the server", "needs Kick, kill, move")
   * says more than a status code.
   */
  async postAction(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<PostResult> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 10_000);

    let res: Response;
    try {
      res = await doFetch(`${this.opts.baseUrl}${path}`, {
        method,
        headers: { ...this.headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: controller.signal
      });
    } catch (err) {
      return { ok: false, status: 0, message: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) return { ok: true };
    let message = `warcon request failed (${res.status})`;
    try {
      const parsed = (await res.json()) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === 'string' && parsed.error.message) {
        message = parsed.error.message;
      }
    } catch {
      // not JSON (an HTML error page): keep the status line
    }
    return { ok: false, status: res.status, message };
  }
}

export type PostResult = { ok: true } | { ok: false; status: number; message: string };
