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

    const contentType = res.headers.get('content-type') ?? '';
    if (!/application\/json/i.test(contentType)) {
      throw new CloudflareBlockedError(
        `blocked by Cloudflare Access (non-JSON response, content-type: ${contentType || 'none'})`
      );
    }

    if (!res.ok) throw new Error(`warcon request failed (${res.status}) on ${path}`);

    return (await res.json()) as T;
  }
}
