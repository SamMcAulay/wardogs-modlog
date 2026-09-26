# Wardogs Moderation Log Bot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Discord bot that polls the Warcon panel and reports team kills, kicks and bans, watched-player joins and high K/D into a staff channel, pinging a mod role only when a human is needed now.

**Architecture:** One Node process. Four independent polling sources each turn a Warcon API response into typed events; a pure escalation module decides which events ping the mod role; a Discord sink posts embeds over REST. A small JSON file on a Docker volume holds cursors so restarts neither replay nor lose events.

**Tech Stack:** TypeScript (ESM, Node 22), `@discordjs/rest` (no gateway — the bot only posts), `dotenv`, `vitest`, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-24-wardogs-modlog-design.md` — read it alongside this plan. Every task references its sections.

## Global Constraints

- **New repository**, `wardogs-modlog`. Nothing in this plan modifies the WDstats status fleet.
- **Node 22**, ESM (`"type": "module"`), all relative imports end in `.js`.
- **Warcon API key capabilities are `server.view` + `audit.read` only.** Never call a route needing `automation.manage`, `players.notes` or `rcon.raw`. See spec §4.1.
- **No Discord gateway connection.** Posting is REST-only; no intents, no presence.
- **Cursors advance only over events that posted successfully** (spec §9).
- **Cold start posts nothing** — record position, write state, report nothing (spec §7).
- **`PANEL_PUBLIC_URL` builds links for humans; `WARCON_BASE_URL` makes API calls.** Never swap them: the latter is `http://warcon:3000`, unreachable from a browser.
- Every `.env` value containing `#` must be quoted, or dotenv truncates it.
- **Every alert names its server first** — `SERVER_LABELS` label, short-id fallback (spec §8.5). Added 2026-09-25 as Amendment A; the amendment blocks inside Tasks 9–12 are binding.
- Test runner: `npx vitest run`. Typecheck: `npx tsc --noEmit`.

---

### Task 1: Repository scaffold and configuration

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `loadConfig(env?: NodeJS.ProcessEnv): Config` and the `Config` interface, used by every later task.

- [ ] **Step 1: Create the project files**

`package.json`:

```json
{
  "name": "wardogs-modlog",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "preflight": "tsx src/preflight.ts",
    "mock": "node scripts/mock-warcon.mjs"
  },
  "dependencies": {
    "@discordjs/rest": "^2.4.0",
    "discord-api-types": "^0.37.100",
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "@types/node": "^22.7.5",
    "tsx": "^4.19.1",
    "typescript": "^5.6.3",
    "vitest": "^2.1.3"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] }
});
```

`.gitignore`:

```
node_modules/
dist/
.env
state.json
```

- [ ] **Step 2: Write the failing test**

`tests/config.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  WARCON_BASE_URL: 'http://warcon:3000/',
  PANEL_PUBLIC_URL: 'https://panel.example.com/',
  WARCON_TOKEN: 'tok',
  DISCORD_TOKEN: 'dtok',
  DISCORD_CHANNEL_ID: '111',
  DISCORD_MOD_ROLE_ID: '222'
};

describe('loadConfig', () => {
  test('applies documented defaults', () => {
    const c = loadConfig({ ...base });
    expect(c.pollIntervalMs).toBe(30000);
    expect(c.kdPollIntervalMs).toBe(3600000);
    expect(c.teamKillPingAt).toBe(3);
    expect(c.kdThreshold).toBe(4.0);
    expect(c.kdMinMatches).toBe(5);
    expect(c.kdMinMinutes).toBe(60);
    expect(c.kdRange).toBe('30d');
    expect(c.kdCooldownDays).toBe(7);
    expect(c.feedQuietMinutes).toBe(30);
    expect(c.statePath).toBe('/data/state.json');
    expect(c.serverIds).toEqual([]);
  });

  test('strips trailing slashes from both origins', () => {
    const c = loadConfig({ ...base });
    expect(c.warconBaseUrl).toBe('http://warcon:3000');
    expect(c.panelPublicUrl).toBe('https://panel.example.com');
  });

  test('parses SERVER_IDS into a trimmed list', () => {
    const c = loadConfig({ ...base, SERVER_IDS: 'a , b,, c ' });
    expect(c.serverIds).toEqual(['a', 'b', 'c']);
  });

  test('names every missing required variable at once', () => {
    expect(() => loadConfig({})).toThrow(/WARCON_BASE_URL[\s\S]*DISCORD_MOD_ROLE_ID/);
  });

  test('rejects a non-positive numeric override', () => {
    expect(() => loadConfig({ ...base, POLL_INTERVAL_MS: '0' })).toThrow(/POLL_INTERVAL_MS/);
  });

  test('requires both Cloudflare values or neither', () => {
    expect(() => loadConfig({ ...base, CF_ACCESS_CLIENT_ID: 'x' })).toThrow(
      /CF_ACCESS_CLIENT_SECRET/
    );
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 4: Implement `src/config.ts`**

```ts
import 'dotenv/config';

export interface Config {
  warconBaseUrl: string;
  panelPublicUrl: string;
  warconToken: string;
  cfAccessClientId: string | null;
  cfAccessClientSecret: string | null;
  discordToken: string;
  discordChannelId: string;
  discordModRoleId: string;
  serverIds: string[];
  pollIntervalMs: number;
  kdPollIntervalMs: number;
  requestTimeoutMs: number;
  statePath: string;
  teamKillPingAt: number;
  kdThreshold: number;
  kdMinMatches: number;
  kdMinMinutes: number;
  kdRange: string;
  kdCooldownDays: number;
  feedQuietMinutes: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];

  const req = (key: string): string => {
    const value = (env[key] ?? '').trim();
    if (!value) missing.push(key);
    return value;
  };
  const opt = (key: string): string | null => {
    const value = (env[key] ?? '').trim();
    return value === '' ? null : value;
  };
  const num = (key: string, fallback: number): number => {
    const raw = (env[key] ?? '').trim();
    if (raw === '') return fallback;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${key} must be a positive number, got: ${raw}`);
    }
    return parsed;
  };

  const warconBaseUrl = req('WARCON_BASE_URL').replace(/\/+$/, '');
  const panelPublicUrl = req('PANEL_PUBLIC_URL').replace(/\/+$/, '');
  const warconToken = req('WARCON_TOKEN');
  const discordToken = req('DISCORD_TOKEN');
  const discordChannelId = req('DISCORD_CHANNEL_ID');
  const discordModRoleId = req('DISCORD_MOD_ROLE_ID');

  const cfAccessClientId = opt('CF_ACCESS_CLIENT_ID');
  const cfAccessClientSecret = opt('CF_ACCESS_CLIENT_SECRET');
  if (cfAccessClientId && !cfAccessClientSecret) missing.push('CF_ACCESS_CLIENT_SECRET');
  if (cfAccessClientSecret && !cfAccessClientId) missing.push('CF_ACCESS_CLIENT_ID');

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables:\n  ${missing.join('\n  ')}`);
  }

  return {
    warconBaseUrl,
    panelPublicUrl,
    warconToken,
    cfAccessClientId,
    cfAccessClientSecret,
    discordToken,
    discordChannelId,
    discordModRoleId,
    serverIds: (env.SERVER_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    pollIntervalMs: num('POLL_INTERVAL_MS', 30_000),
    kdPollIntervalMs: num('KD_POLL_INTERVAL_MS', 3_600_000),
    requestTimeoutMs: num('REQUEST_TIMEOUT_MS', 10_000),
    statePath: (env.STATE_PATH ?? '').trim() || '/data/state.json',
    teamKillPingAt: num('TEAM_KILL_PING_AT', 3),
    kdThreshold: num('KD_THRESHOLD', 4.0),
    kdMinMatches: num('KD_MIN_MATCHES', 5),
    kdMinMinutes: num('KD_MIN_MINUTES', 60),
    kdRange: (env.KD_RANGE ?? '').trim() || '30d',
    kdCooldownDays: num('KD_COOLDOWN_DAYS', 7),
    feedQuietMinutes: num('FEED_QUIET_MINUTES', 30)
  };
}
```

- [ ] **Step 5: Create `.env.example`**

```
# Warcon panel
WARCON_BASE_URL=http://warcon:3000
PANEL_PUBLIC_URL=https://panel.example.com
WARCON_TOKEN=

# Cloudflare Access service token — leave both empty on the VPS
CF_ACCESS_CLIENT_ID=
CF_ACCESS_CLIENT_SECRET=

# Discord
DISCORD_TOKEN=
DISCORD_CHANNEL_ID=
DISCORD_MOD_ROLE_ID=

# Empty means every server the key can see
SERVER_IDS=

POLL_INTERVAL_MS=30000
KD_POLL_INTERVAL_MS=3600000
REQUEST_TIMEOUT_MS=10000
STATE_PATH=/data/state.json

TEAM_KILL_PING_AT=3
KD_THRESHOLD=4.0
KD_MIN_MATCHES=5
KD_MIN_MINUTES=60
KD_RANGE=30d
KD_COOLDOWN_DAYS=7
FEED_QUIET_MINUTES=30
```

- [ ] **Step 6: Install and verify**

Run: `npm install && npx vitest run tests/config.test.ts && npx tsc --noEmit`
Expected: all config tests PASS, typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: project scaffold and configuration"
```

---

### Task 2: Warcon API client

**Files:**
- Create: `src/warcon.ts`
- Test: `tests/warcon.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 1.
- Produces: `WarconClient` with `getJson<T>(path: string): Promise<T>`, plus `CloudflareBlockedError` and `WarconAuthError`. Later tasks call `getJson` with an already-built path and query string.

- [ ] **Step 1: Write the failing test**

`tests/warcon.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/warcon.test.ts`
Expected: FAIL — cannot resolve `../src/warcon.js`.

- [ ] **Step 3: Implement `src/warcon.ts`**

This is a deliberate port of the status fleet's client (`WDstats/src/warcon.ts`), generalised from one endpoint to any path. The Cloudflare detection and the auth/Cloudflare distinction are the valuable parts — keep them exactly.

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/warcon.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/warcon.ts tests/warcon.test.ts
git commit -m "feat: authenticated Warcon client with Cloudflare detection"
```

---

### Task 3: Event types and Warcon response shapes

**Files:**
- Create: `src/events.ts`, `src/warcon-types.ts`
- Test: `tests/events.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `ModEvent` union and `Decision`, consumed by Tasks 4–10. Also `KillView`, `AuditRow`, `PlayerMark`, `BoardRow`, `SummaryBody` — the Warcon response shapes, mirrored from the panel's own `src/lib/types.ts`.

- [ ] **Step 1: Create `src/warcon-types.ts`**

These mirror Warcon's own types for the fields we consume. Field names must match the panel exactly or deserialisation silently yields `undefined`.

```ts
/** Mirrors Warcon's src/lib/types.ts for the fields we consume. */

export interface KillView {
  eventId: string;
  /** when Warcon received it (ISO) */
  ts: string;
  map: string;
  /** seconds on the match clock */
  eventTime: number;
  /** null: the environment killed them */
  killer: { steamId: string; name: string; faction: string | null } | null;
  victim: { steamId: string; name: string; faction: string | null };
  cause: string | null;
  distanceM: number | null;
  headshot: boolean;
  suicide: boolean;
  teamKill: boolean;
  tags: string[];
}

export interface KillsBody {
  ok: boolean;
  configured: boolean;
  /** ISO time the last feed batch arrived, or null */
  feedAt: string | null;
  kills: KillView[];
  total: number | null;
}

export interface AuditRow {
  id: number;
  createdAt: string;
  serverId: string | null;
  actorId: string | null;
  actorName: string;
  category: string;
  action: string;
  target: string | null;
  outcome: string;
  detail: unknown;
}

export interface AuditBody {
  ok: boolean;
  entries: AuditRow[];
  nextBefore: number | null;
}

export interface PlayerMark {
  steamId: string;
  watched: boolean;
  /** '' unless the key has staff capability — see spec §5.3 */
  reason: string;
  firstVisit: boolean;
}

export interface MarksBody {
  ok: boolean;
  marks: PlayerMark[];
}

export interface SummaryPlayer {
  name: string;
  steamId: string;
  faction: string | null;
}

export interface SummaryBody {
  ok: boolean;
  live: {
    serverId: string;
    ok: boolean;
    status: { serverName: string } | null;
    players: SummaryPlayer[];
  } | null;
}

export interface BoardRow {
  steamId: string;
  name: string;
  minutes: number;
  kills: number;
  deaths: number;
  matches: number;
}

export interface BoardBody {
  ok: boolean;
  rows: BoardRow[];
}
```

- [ ] **Step 2: Write the failing test**

`tests/events.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { eventKey, type ModEvent } from '../src/events.js';

const teamKill: ModEvent = {
  kind: 'teamKill',
  serverId: 's1',
  at: '2026-09-24T10:00:00.000Z',
  eventId: 'e1',
  eventTime: 120,
  killer: { steamId: '765', name: 'Alpha', faction: 'Valkyra' },
  victim: { steamId: '766', name: 'Bravo', faction: 'Valkyra' },
  cause: 'Id.Item.AK74M',
  distanceM: 40,
  count: 0
};

describe('eventKey', () => {
  test('a team kill is keyed by its event id', () => {
    expect(eventKey(teamKill)).toBe('teamKill:e1');
  });

  test('an admin action is keyed by its audit row id', () => {
    expect(
      eventKey({
        kind: 'adminAction',
        serverId: 's1',
        at: '2026-09-24T10:00:00.000Z',
        auditId: 42,
        action: 'rcon.ban',
        actorName: 'mod',
        target: '765',
        reason: 'griefing'
      })
    ).toBe('adminAction:42');
  });

  test('keys of different kinds never collide', () => {
    const watched = eventKey({
      kind: 'watchedJoin',
      serverId: 's1',
      at: '2026-09-24T10:00:00.000Z',
      steamId: '765',
      name: 'Alpha'
    });
    expect(watched).not.toBe(eventKey(teamKill));
  });
});
```

- [ ] **Step 3: Run the test and watch it fail**

Run: `npx vitest run tests/events.test.ts`
Expected: FAIL — cannot resolve `../src/events.js`.

- [ ] **Step 4: Implement `src/events.ts`**

```ts
/** Every event a source can produce. `at` is ISO. */
export type ModEvent =
  | TeamKillEvent
  | AdminActionEvent
  | WatchedJoinEvent
  | HighKdEvent
  | FeedQuietEvent;

export interface TeamKillEvent {
  kind: 'teamKill';
  serverId: string;
  at: string;
  eventId: string;
  /** match clock seconds; a decrease means a new match (spec §8.1) */
  eventTime: number;
  killer: { steamId: string; name: string; faction: string | null };
  victim: { steamId: string; name: string; faction: string | null };
  cause: string | null;
  distanceM: number | null;
  /** this killer's running count in the current match. Sources emit 0;
   *  escalate() replaces it with the real count. */
  count: number;
}

export interface AdminActionEvent {
  kind: 'adminAction';
  serverId: string;
  at: string;
  auditId: number;
  action: 'rcon.kick' | 'rcon.ban' | 'rcon.unban';
  actorName: string;
  target: string;
  reason: string;
}

export interface WatchedJoinEvent {
  kind: 'watchedJoin';
  serverId: string;
  at: string;
  steamId: string;
  name: string;
}

export interface HighKdEvent {
  kind: 'highKd';
  serverId: string;
  at: string;
  steamId: string;
  name: string;
  kd: number;
  kills: number;
  deaths: number;
  matches: number;
  minutes: number;
}

export interface FeedQuietEvent {
  kind: 'feedQuiet';
  serverId: string;
  at: string;
  /** ISO time of the last batch, or null if none has ever arrived */
  lastFeedAt: string | null;
}

/** An event plus whether posting it should mention the mod role. */
export interface Decision {
  event: ModEvent;
  ping: boolean;
}

/** A stable identity for logging and de-duplication within one cycle. */
export function eventKey(e: ModEvent): string {
  switch (e.kind) {
    case 'teamKill':
      return `teamKill:${e.eventId}`;
    case 'adminAction':
      return `adminAction:${e.auditId}`;
    case 'watchedJoin':
      return `watchedJoin:${e.serverId}:${e.steamId}:${e.at}`;
    case 'highKd':
      return `highKd:${e.serverId}:${e.steamId}:${e.at}`;
    case 'feedQuiet':
      return `feedQuiet:${e.serverId}:${e.at}`;
  }
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run tests/events.test.ts && npx tsc --noEmit`
Expected: PASS, typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/events.ts src/warcon-types.ts tests/events.test.ts
git commit -m "feat: event union and Warcon response shapes"
```

---

### Task 4: Persistent state

**Files:**
- Create: `src/state.ts`
- Test: `tests/state.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `State`, `ServerState`, `emptyState()`, `serverState(state, id)`, `rememberKillIds(s, ids)`, `loadState(path)`, `saveState(path, state)`. Tasks 5–10 read and mutate `State`.

Implements spec §7. `loadState` never throws: a missing file cold-starts, a corrupt file is moved aside and cold-starts.

- [ ] **Step 1: Write the failing test**

`tests/state.test.ts`:

```ts
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  emptyState,
  loadState,
  rememberKillIds,
  saveState,
  serverState,
  SEEN_KILL_CAP
} from '../src/state.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'modlog-'));
});

describe('state', () => {
  test('a missing file cold-starts rather than throwing', async () => {
    const s = await loadState(join(dir, 'nope.json'));
    expect(s.version).toBe(1);
    expect(s.servers).toEqual({});
    expect(s.cold).toBe(true);
  });

  test('round-trips through save and load', async () => {
    const path = join(dir, 'state.json');
    const s = emptyState();
    serverState(s, 's1').lastAuditId = 99;
    s.kdAlerted['765'] = 1234;
    await saveState(path, s);

    const back = await loadState(path);
    expect(back.servers.s1?.lastAuditId).toBe(99);
    expect(back.kdAlerted['765']).toBe(1234);
    expect(back.cold).toBe(false);
  });

  test('a corrupt file is moved aside and cold-starts', async () => {
    const path = join(dir, 'state.json');
    await writeFile(path, '{not json');
    const s = await loadState(path);
    expect(s.cold).toBe(true);
    expect(existsSync(`${path}.corrupt`)).toBe(true);
  });

  test('serverState creates a zeroed entry once and then reuses it', () => {
    const s = emptyState();
    const a = serverState(s, 's1');
    a.lastAuditId = 5;
    expect(serverState(s, 's1').lastAuditId).toBe(5);
    expect(serverState(s, 's2').lastAuditId).toBe(0);
  });

  test('the kill-id ring keeps newest first and evicts the oldest', () => {
    const s = serverState(emptyState(), 's1');
    rememberKillIds(s, ['a', 'b']);
    rememberKillIds(s, ['c']);
    expect(s.seenKillIds.slice(0, 3)).toEqual(['c', 'a', 'b']);

    rememberKillIds(
      s,
      Array.from({ length: SEEN_KILL_CAP + 10 }, (_, i) => `x${i}`)
    );
    expect(s.seenKillIds.length).toBe(SEEN_KILL_CAP);
    expect(s.seenKillIds).not.toContain('b');
  });

  test('the ring never stores a duplicate id', () => {
    const s = serverState(emptyState(), 's1');
    rememberKillIds(s, ['a']);
    rememberKillIds(s, ['a']);
    expect(s.seenKillIds.filter((i) => i === 'a').length).toBe(1);
  });

  test('saving writes atomically, leaving no temp file behind', async () => {
    const path = join(dir, 'state.json');
    await saveState(path, emptyState());
    expect(JSON.parse(await readFile(path, 'utf8')).version).toBe(1);
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/state.test.ts`
Expected: FAIL — cannot resolve `../src/state.js`.

- [ ] **Step 3: Implement `src/state.ts`**

```ts
import { readFile, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Per-server ring of recently seen kill event ids (spec §7). */
export const SEEN_KILL_CAP = 500;

export interface ServerState {
  /** newest first, capped at SEEN_KILL_CAP */
  seenKillIds: string[];
  /** high-water audit row id */
  lastAuditId: number;
  /** last observed player list, for join detection */
  presentSteamIds: string[];
  /** ISO time of the last kill-feed batch Warcon reported */
  lastFeedAt: string | null;
  /** newest match-clock value seen; a decrease means a new match */
  lastEventTime: number;
  /** steamId -> team kills in the current match */
  teamKills: Record<string, number>;
  /** whether a feed-quiet warning is currently outstanding */
  feedQuietWarned: boolean;
}

export interface State {
  version: 1;
  servers: Record<string, ServerState>;
  /** steamId -> epoch ms of the last K/D alert */
  kdAlerted: Record<string, number>;
  startedAt: number;
  /** true when no usable state file was found: report nothing this cycle */
  cold: boolean;
}

export function emptyServerState(): ServerState {
  return {
    seenKillIds: [],
    lastAuditId: 0,
    presentSteamIds: [],
    lastFeedAt: null,
    lastEventTime: 0,
    teamKills: {},
    feedQuietWarned: false
  };
}

export function emptyState(): State {
  return { version: 1, servers: {}, kdAlerted: {}, startedAt: Date.now(), cold: true };
}

/** The entry for a server, created zeroed on first use. */
export function serverState(state: State, serverId: string): ServerState {
  const existing = state.servers[serverId];
  if (existing) return existing;
  const fresh = emptyServerState();
  state.servers[serverId] = fresh;
  return fresh;
}

/**
 * Prepend ids, preserving their order, skipping duplicates, evicting past the cap.
 *
 * `ids` arrives newest-first (the kills API's own order) and the ring is
 * newest-first, so the batch is prepended as a block. Unshifting one at a time in a
 * loop would reverse the batch and leave its OLDEST entry at the front.
 */
export function rememberKillIds(s: ServerState, ids: string[]): void {
  const known = new Set(s.seenKillIds);
  const fresh: string[] = [];
  for (const id of ids) {
    if (known.has(id)) continue;
    known.add(id);
    fresh.push(id);
  }
  s.seenKillIds = [...fresh, ...s.seenKillIds];
  if (s.seenKillIds.length > SEEN_KILL_CAP) s.seenKillIds.length = SEEN_KILL_CAP;
}

export async function loadState(path: string): Promise<State> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return emptyState();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<State>;
    if (parsed.version !== 1) throw new Error(`unsupported state version ${parsed.version}`);
    return {
      version: 1,
      servers: Object.fromEntries(
        Object.entries(parsed.servers ?? {}).map(([id, s]) => [
          id,
          { ...emptyServerState(), ...s }
        ])
      ),
      kdAlerted: parsed.kdAlerted ?? {},
      startedAt: parsed.startedAt ?? Date.now(),
      cold: false
    };
  } catch {
    // Keep the bad file for diagnosis rather than overwriting it.
    await rename(path, `${path}.corrupt`).catch(() => undefined);
    return emptyState();
  }
}

/** Write to a temp file in the same directory, then rename — rename is atomic. */
export async function saveState(path: string, state: State): Promise<void> {
  const tmp = join(dirname(path), `${basename(path)}.tmp`);
  await writeFile(tmp, JSON.stringify({ ...state, cold: undefined }, null, 2), 'utf8');
  await rename(tmp, path);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/state.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/state.ts tests/state.test.ts
git commit -m "feat: atomic JSON state with kill-id ring and cold start"
```

---

### Task 5: Escalation rules

**Files:**
- Create: `src/escalate.ts`
- Test: `tests/escalate.test.ts`

**Interfaces:**
- Consumes: `ModEvent`, `Decision` (Task 3); `State`, `serverState` (Task 4).
- Produces: `escalate(events: ModEvent[], state: State, cfg: EscalateConfig, now: number): Decision[]`, called by Task 10.

This is the module the spec singles out as carrying every tunable rule (spec §8), and it is fully pure — it mutates the `State` object passed in but touches no I/O. Give it the heaviest test coverage.

- [ ] **Step 1: Write the failing test**

`tests/escalate.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { escalate, type EscalateConfig } from '../src/escalate.js';
import { emptyState, serverState } from '../src/state.js';
import type { ModEvent, TeamKillEvent } from '../src/events.js';

const cfg: EscalateConfig = { teamKillPingAt: 3, kdCooldownDays: 7 };
const NOW = Date.parse('2026-09-24T12:00:00.000Z');

const tk = (eventId: string, eventTime: number, killer = '765'): TeamKillEvent => ({
  kind: 'teamKill',
  serverId: 's1',
  at: '2026-09-24T12:00:00.000Z',
  eventId,
  eventTime,
  killer: { steamId: killer, name: 'Alpha', faction: 'Valkyra' },
  victim: { steamId: '766', name: 'Bravo', faction: 'Valkyra' },
  cause: 'Id.Item.AK74M',
  distanceM: 40,
  count: 0
});

describe('team kill escalation', () => {
  test('the first two do not ping and the third does', () => {
    const state = emptyState();
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30)], state, cfg, NOW);
    expect(out.map((d) => d.ping)).toEqual([false, false, true]);
  });

  test('the running count is stamped onto the event', () => {
    const state = emptyState();
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30)], state, cfg, NOW);
    expect(out.map((d) => (d.event as TeamKillEvent).count)).toEqual([1, 2, 3]);
  });

  test('every kill past the threshold also pings', () => {
    const state = emptyState();
    const out = escalate([tk('a', 10), tk('b', 20), tk('c', 30), tk('d', 40)], state, cfg, NOW);
    expect(out[3]!.ping).toBe(true);
  });

  test('counts are kept per killer, not per server', () => {
    const state = emptyState();
    const out = escalate(
      [tk('a', 10, 'X'), tk('b', 20, 'Y'), tk('c', 30, 'X')],
      state,
      cfg,
      NOW
    );
    expect(out.every((d) => d.ping === false)).toBe(true);
  });

  test('the count survives across cycles via state', () => {
    const state = emptyState();
    escalate([tk('a', 10), tk('b', 20)], state, cfg, NOW);
    const out = escalate([tk('c', 30)], state, cfg, NOW);
    expect(out[0]!.ping).toBe(true);
  });

  test('a match boundary resets the count', () => {
    const state = emptyState();
    escalate([tk('a', 300), tk('b', 310)], state, cfg, NOW);
    // eventTime going backwards means the match clock reset.
    const out = escalate([tk('c', 5)], state, cfg, NOW);
    expect(out[0]!.ping).toBe(false);
    expect((out[0]!.event as TeamKillEvent).count).toBe(1);
  });
});

describe('high K/D escalation', () => {
  const kd = (steamId = '765'): ModEvent => ({
    kind: 'highKd',
    serverId: 's1',
    at: '2026-09-24T12:00:00.000Z',
    steamId,
    name: 'Alpha',
    kd: 5.2,
    kills: 52,
    deaths: 10,
    matches: 9,
    minutes: 400
  });

  test('a first flag pings and records the time', () => {
    const state = emptyState();
    const out = escalate([kd()], state, cfg, NOW);
    expect(out[0]!.ping).toBe(true);
    expect(state.kdAlerted['765']).toBe(NOW);
  });

  test('a re-flag inside the cooldown is dropped entirely', () => {
    const state = emptyState();
    state.kdAlerted['765'] = NOW - 2 * 86_400_000;
    expect(escalate([kd()], state, cfg, NOW)).toHaveLength(0);
  });

  test('a re-flag after the cooldown pings again', () => {
    const state = emptyState();
    state.kdAlerted['765'] = NOW - 8 * 86_400_000;
    const out = escalate([kd()], state, cfg, NOW);
    expect(out[0]!.ping).toBe(true);
    expect(state.kdAlerted['765']).toBe(NOW);
  });
});

describe('other kinds', () => {
  test('a watched join pings', () => {
    const out = escalate(
      [
        {
          kind: 'watchedJoin',
          serverId: 's1',
          at: '2026-09-24T12:00:00.000Z',
          steamId: '765',
          name: 'Alpha'
        }
      ],
      emptyState(),
      cfg,
      NOW
    );
    expect(out[0]!.ping).toBe(true);
  });

  test('admin actions are a record and never ping', () => {
    const out = escalate(
      [
        {
          kind: 'adminAction',
          serverId: 's1',
          at: '2026-09-24T12:00:00.000Z',
          auditId: 1,
          action: 'rcon.ban',
          actorName: 'mod',
          target: '765',
          reason: 'griefing'
        }
      ],
      emptyState(),
      cfg,
      NOW
    );
    expect(out[0]!.ping).toBe(false);
  });

  test('a quiet feed is a warning, not an alarm', () => {
    const out = escalate(
      [
        {
          kind: 'feedQuiet',
          serverId: 's1',
          at: '2026-09-24T12:00:00.000Z',
          lastFeedAt: null
        }
      ],
      emptyState(),
      cfg,
      NOW
    );
    expect(out[0]!.ping).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/escalate.test.ts`
Expected: FAIL — cannot resolve `../src/escalate.js`.

- [ ] **Step 3: Implement `src/escalate.ts`**

```ts
import type { Decision, ModEvent } from './events.js';
import { serverState, type State } from './state.js';

export interface EscalateConfig {
  teamKillPingAt: number;
  kdCooldownDays: number;
}

/**
 * Decides which events ping the mod role, and stamps team kills with their running
 * count. Mutates `state` (counts, K/D cooldowns) but performs no I/O.
 *
 * Events must arrive in chronological order — see spec §8.1: the kills API returns
 * newest first, so the source reverses each page before calling this.
 */
export function escalate(
  events: ModEvent[],
  state: State,
  cfg: EscalateConfig,
  now: number
): Decision[] {
  const out: Decision[] = [];
  const cooldownMs = cfg.kdCooldownDays * 86_400_000;

  for (const event of events) {
    switch (event.kind) {
      case 'teamKill': {
        const s = serverState(state, event.serverId);
        // The match clock resets on a map change; matchId is per boot, not per match.
        if (event.eventTime < s.lastEventTime) s.teamKills = {};
        s.lastEventTime = event.eventTime;

        const count = (s.teamKills[event.killer.steamId] ?? 0) + 1;
        s.teamKills[event.killer.steamId] = count;
        out.push({ event: { ...event, count }, ping: count >= cfg.teamKillPingAt });
        break;
      }

      case 'highKd': {
        const last = state.kdAlerted[event.steamId];
        if (last !== undefined && now - last < cooldownMs) break; // still cooling down
        state.kdAlerted[event.steamId] = now;
        out.push({ event, ping: true });
        break;
      }

      case 'watchedJoin':
        out.push({ event, ping: true });
        break;

      case 'adminAction':
      case 'feedQuiet':
        out.push({ event, ping: false });
        break;
    }
  }

  return out;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/escalate.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/escalate.ts tests/escalate.test.ts
git commit -m "feat: escalation rules for pings, team-kill counts and K/D cooldown"
```

---

### Task 6: Team kill and feed-health source

**Files:**
- Create: `src/sources/kills.ts`
- Test: `tests/sources-kills.test.ts`

**Interfaces:**
- Consumes: `WarconClient` (Task 2), `KillsBody`/`KillView` (Task 3), `ServerState`/`rememberKillIds` (Task 4).
- Produces: `pollKills(client, serverId, s, opts): Promise<ModEvent[]>` where `opts` is `{ feedQuietMinutes: number; now: number }`. Called by Task 10.

Implements spec §5.1 and §8.4. Two details are load-bearing and both are tested below: the API pages **newest first**, so the page must be reversed into chronological order before emitting; and the walk stops at the first already-seen `eventId`.

- [ ] **Step 1: Write the failing test**

`tests/sources-kills.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { pollKills } from '../src/sources/kills.js';
import { emptyServerState } from '../src/state.js';
import type { KillsBody, KillView } from '../src/warcon-types.js';
import type { TeamKillEvent } from '../src/events.js';

const kill = (eventId: string, eventTime: number, ts: string): KillView => ({
  eventId,
  ts,
  map: 'Kavkazi',
  eventTime,
  killer: { steamId: '765', name: 'Alpha', faction: 'Valkyra' },
  victim: { steamId: '766', name: 'Bravo', faction: 'Valkyra' },
  cause: 'Id.Item.AK74M',
  distanceM: 40,
  headshot: false,
  suicide: false,
  teamKill: true,
  tags: []
});

const client = (body: KillsBody) =>
  ({ getJson: async () => body }) as unknown as import('../src/warcon.js').WarconClient;

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const opts = { feedQuietMinutes: 30, now: NOW };

const body = (kills: KillView[], extra: Partial<KillsBody> = {}): KillsBody => ({
  ok: true,
  configured: true,
  feedAt: '2026-09-24T11:59:00.000Z',
  kills,
  total: null,
  ...extra
});

describe('pollKills', () => {
  test('emits newest-first API order as chronological events', async () => {
    const s = emptyServerState();
    // The API returns newest first.
    const events = await pollKills(
      client(body([kill('c', 30, 't3'), kill('b', 20, 't2'), kill('a', 10, 't1')])),
      's1',
      s,
      opts
    );
    expect(events.filter((e) => e.kind === 'teamKill').map((e) => (e as TeamKillEvent).eventId))
      .toEqual(['a', 'b', 'c']);
  });

  test('stops at the first already-seen id', async () => {
    const s = emptyServerState();
    s.seenKillIds = ['b'];
    const events = await pollKills(
      client(body([kill('c', 30, 't3'), kill('b', 20, 't2'), kill('a', 10, 't1')])),
      's1',
      s,
      opts
    );
    const ids = events
      .filter((e) => e.kind === 'teamKill')
      .map((e) => (e as TeamKillEvent).eventId);
    expect(ids).toEqual(['c']);
  });

  test('a batch sharing one receipt timestamp is not collapsed', async () => {
    const s = emptyServerState();
    const same = '2026-09-24T11:58:00.000Z';
    const events = await pollKills(
      client(body([kill('c', 30, same), kill('b', 20, same), kill('a', 10, same)])),
      's1',
      s,
      opts
    );
    expect(events.filter((e) => e.kind === 'teamKill')).toHaveLength(3);
  });

  test('records every returned id so the next cycle skips them', async () => {
    const s = emptyServerState();
    await pollKills(client(body([kill('b', 20, 't2'), kill('a', 10, 't1')])), 's1', s, opts);
    expect(s.seenKillIds).toContain('a');
    expect(s.seenKillIds).toContain('b');
  });

  test('a kill with no killer is skipped: the environment cannot team kill', async () => {
    const s = emptyServerState();
    const orphan = { ...kill('a', 10, 't1'), killer: null };
    const events = await pollKills(client(body([orphan])), 's1', s, opts);
    expect(events.filter((e) => e.kind === 'teamKill')).toHaveLength(0);
  });

  test('warns once when a configured feed has gone quiet', async () => {
    const s = emptyServerState();
    s.lastFeedAt = '2026-09-24T11:00:00.000Z'; // 60 minutes ago
    const stale = body([], { feedAt: '2026-09-24T11:00:00.000Z' });

    const first = await pollKills(client(stale), 's1', s, opts);
    expect(first.filter((e) => e.kind === 'feedQuiet')).toHaveLength(1);

    const second = await pollKills(client(stale), 's1', s, opts);
    expect(second.filter((e) => e.kind === 'feedQuiet')).toHaveLength(0);
  });

  test('the quiet warning resets once the feed advances', async () => {
    const s = emptyServerState();
    s.lastFeedAt = '2026-09-24T11:00:00.000Z';
    s.feedQuietWarned = true;
    await pollKills(client(body([], { feedAt: '2026-09-24T11:59:30.000Z' })), 's1', s, opts);
    expect(s.feedQuietWarned).toBe(false);
  });

  test('an unconfigured feed never warns', async () => {
    const s = emptyServerState();
    s.lastFeedAt = '2026-09-24T10:00:00.000Z';
    const events = await pollKills(
      client(body([], { configured: false, feedAt: null })),
      's1',
      s,
      opts
    );
    expect(events).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/sources-kills.test.ts`
Expected: FAIL — cannot resolve `../src/sources/kills.js`.

- [ ] **Step 3: Implement `src/sources/kills.ts`**

```ts
import type { ModEvent, TeamKillEvent } from '../events.js';
import { rememberKillIds, type ServerState } from '../state.js';
import type { WarconClient } from '../warcon.js';
import type { KillsBody } from '../warcon-types.js';

export interface KillsPollOptions {
  feedQuietMinutes: number;
  now: number;
}

const PAGE_LIMIT = 200;

/**
 * Team kills since the last cycle, plus a feed-health warning.
 *
 * The API returns newest first and offers no "everything after X" parameter
 * (spec §5.1), so we take the newest page, walk back to the first id we already
 * know, and reverse what remains into chronological order — escalate() counts in
 * order, and a reversed page would attribute the third team kill to the wrong event.
 */
export async function pollKills(
  client: WarconClient,
  serverId: string,
  s: ServerState,
  opts: KillsPollOptions
): Promise<ModEvent[]> {
  const body = await client.getJson<KillsBody>(
    `/api/servers/${encodeURIComponent(serverId)}/kills?kind=teamKill&limit=${PAGE_LIMIT}`
  );

  const fresh: TeamKillEvent[] = [];
  for (const k of body.kills) {
    if (s.seenKillIds.includes(k.eventId)) break; // everything older is known
    if (!k.killer) continue; // the environment cannot team kill
    fresh.push({
      kind: 'teamKill',
      serverId,
      at: k.ts,
      eventId: k.eventId,
      eventTime: k.eventTime,
      killer: k.killer,
      victim: k.victim,
      cause: k.cause,
      distanceM: k.distanceM,
      count: 0 // escalate() replaces this
    });
  }

  rememberKillIds(s, body.kills.map((k) => k.eventId));

  const events: ModEvent[] = fresh.reverse();

  // Feed health (spec §8.4).
  const advanced = body.feedAt !== null && body.feedAt !== s.lastFeedAt;
  if (advanced) {
    s.lastFeedAt = body.feedAt;
    s.feedQuietWarned = false;
  } else if (body.configured && !s.feedQuietWarned) {
    const last = s.lastFeedAt ? Date.parse(s.lastFeedAt) : null;
    const quietFor = last === null ? Infinity : opts.now - last;
    if (quietFor > opts.feedQuietMinutes * 60_000) {
      s.feedQuietWarned = true;
      events.push({
        kind: 'feedQuiet',
        serverId,
        at: new Date(opts.now).toISOString(),
        lastFeedAt: s.lastFeedAt
      });
    }
  }

  return events;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/sources-kills.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/kills.ts tests/sources-kills.test.ts
git commit -m "feat: team kill source with chronological ordering and feed health"
```

---

### Task 7: Admin action source

**Files:**
- Create: `src/sources/audit.ts`
- Test: `tests/sources-audit.test.ts`

**Interfaces:**
- Consumes: `WarconClient` (Task 2), `AuditBody`/`AuditRow` (Task 3), `ServerState` (Task 4).
- Produces: `pollAudit(client, serverId, s): Promise<ModEvent[]>`. Called by Task 10.

Implements spec §5.2. Unlike kills, audit row ids are monotonic, so a single high-water mark suffices — no id set.

- [ ] **Step 1: Write the failing test**

`tests/sources-audit.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { pollAudit } from '../src/sources/audit.js';
import { emptyServerState } from '../src/state.js';
import type { AuditBody, AuditRow } from '../src/warcon-types.js';
import type { AdminActionEvent } from '../src/events.js';

const row = (id: number, action: string, outcome = 'ok'): AuditRow => ({
  id,
  createdAt: '2026-09-24T12:00:00.000Z',
  serverId: 's1',
  actorId: 'u1',
  actorName: 'ModPerson',
  category: 'rcon',
  action,
  target: '76561190000000001',
  outcome,
  detail: { reason: 'griefing' }
});

const client = (body: AuditBody) =>
  ({ getJson: async () => body }) as unknown as import('../src/warcon.js').WarconClient;

const body = (entries: AuditRow[]): AuditBody => ({ ok: true, entries, nextBefore: null });

describe('pollAudit', () => {
  test('emits kicks, bans and unbans oldest first', async () => {
    const s = emptyServerState();
    const events = await pollAudit(
      client(body([row(3, 'rcon.unban'), row(2, 'rcon.ban'), row(1, 'rcon.kick')])),
      's1',
      s
    );
    expect(events.map((e) => (e as AdminActionEvent).auditId)).toEqual([1, 2, 3]);
  });

  test('advances the high-water mark to the greatest id seen', async () => {
    const s = emptyServerState();
    await pollAudit(client(body([row(9, 'rcon.ban'), row(4, 'rcon.kick')])), 's1', s);
    expect(s.lastAuditId).toBe(9);
  });

  test('skips rows at or below the high-water mark', async () => {
    const s = emptyServerState();
    s.lastAuditId = 2;
    const events = await pollAudit(
      client(body([row(3, 'rcon.ban'), row(2, 'rcon.kick'), row(1, 'rcon.kick')])),
      's1',
      s
    );
    expect(events.map((e) => (e as AdminActionEvent).auditId)).toEqual([3]);
  });

  test('ignores an outcome that is not ok', async () => {
    const s = emptyServerState();
    const events = await pollAudit(
      client(body([row(2, 'rcon.ban', 'denied'), row(1, 'rcon.kick', 'error')])),
      's1',
      s
    );
    expect(events).toHaveLength(0);
  });

  test('ignores rcon actions that are not moderation', async () => {
    const s = emptyServerState();
    const events = await pollAudit(client(body([row(1, 'rcon.broadcast')])), 's1', s);
    expect(events).toHaveLength(0);
  });

  test('still advances the cursor past rows it chose not to report', async () => {
    const s = emptyServerState();
    await pollAudit(client(body([row(5, 'rcon.broadcast')])), 's1', s);
    expect(s.lastAuditId).toBe(5);
  });

  test('reads the reason out of the detail object', async () => {
    const s = emptyServerState();
    const events = await pollAudit(client(body([row(1, 'rcon.ban')])), 's1', s);
    expect((events[0] as AdminActionEvent).reason).toBe('griefing');
  });

  test('a detail without a reason yields an empty string, not undefined', async () => {
    const s = emptyServerState();
    const bare = { ...row(1, 'rcon.kick'), detail: null };
    const events = await pollAudit(client(body([bare])), 's1', s);
    expect((events[0] as AdminActionEvent).reason).toBe('');
  });
});
```

- [ ] **Step 2: Run the test and watch it fail**

Run: `npx vitest run tests/sources-audit.test.ts`
Expected: FAIL — cannot resolve `../src/sources/audit.js`.

- [ ] **Step 3: Implement `src/sources/audit.ts`**

```ts
import type { AdminActionEvent, ModEvent } from '../events.js';
import type { ServerState } from '../state.js';
import type { WarconClient } from '../warcon.js';
import type { AuditBody } from '../warcon-types.js';

const REPORTED = new Set(['rcon.kick', 'rcon.ban', 'rcon.unban']);
const PAGE_LIMIT = 200;

/** Reads `detail.reason` defensively: the column is free-form JSON. */
function reasonOf(detail: unknown): string {
  if (detail && typeof detail === 'object' && 'reason' in detail) {
    const r = (detail as { reason?: unknown }).reason;
    if (typeof r === 'string') return r;
  }
  return '';
}

/**
 * Kicks, bans and unbans since the last cycle (spec §5.2).
 *
 * Audit ids are monotonic, so one high-water mark replaces the id set the kills
 * source needs. The mark advances past rows we chose not to report, so a busy
 * server does not make us re-scan them every cycle.
 */
export async function pollAudit(
  client: WarconClient,
  serverId: string,
  s: ServerState
): Promise<ModEvent[]> {
  const body = await client.getJson<AuditBody>(
    `/api/audit?category=rcon&server=${encodeURIComponent(serverId)}&limit=${PAGE_LIMIT}`
  );

  const events: AdminActionEvent[] = [];
  let highest = s.lastAuditId;

  for (const row of body.entries) {
    if (row.id > highest) highest = row.id;
    if (row.id <= s.lastAuditId) continue;
    if (row.outcome !== 'ok') continue;
    if (!REPORTED.has(row.action)) continue;

    events.push({
      kind: 'adminAction',
      serverId,
      at: row.createdAt,
      auditId: row.id,
      action: row.action as AdminActionEvent['action'],
      actorName: row.actorName,
      target: row.target ?? '',
      reason: reasonOf(row.detail)
    });
  }

  s.lastAuditId = highest;
  return events.sort((a, b) => a.auditId - b.auditId);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/sources-audit.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/audit.ts tests/sources-audit.test.ts
git commit -m "feat: admin action source over the audit trail"
```

---

### Task 8: Watched-player and high-K/D sources

**Files:**
- Create: `src/sources/watchlist.ts`, `src/sources/kd.ts`
- Test: `tests/sources-watchlist.test.ts`, `tests/sources-kd.test.ts`

**Interfaces:**
- Consumes: `WarconClient` (Task 2); `SummaryBody`, `MarksBody`, `BoardBody` (Task 3); `ServerState` (Task 4).
- Produces: `pollWatchlist(client, serverId, s, now): Promise<ModEvent[]>` and `pollKd(client, serverId, cfg, now): Promise<ModEvent[]>` where `cfg` is `KdPollConfig`. Both called by Task 10.

These ship together because each is small and neither depends on the other. Implements spec §5.3 and §5.4.

- [ ] **Step 1: Write the failing watchlist test**

`tests/sources-watchlist.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { pollWatchlist } from '../src/sources/watchlist.js';
import { emptyServerState } from '../src/state.js';
import type { MarksBody, SummaryBody } from '../src/warcon-types.js';
import type { WatchedJoinEvent } from '../src/events.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

const client = (summary: SummaryBody, marks: MarksBody) =>
  ({
    getJson: async (path: string) => (path.includes('/marks') ? marks : summary)
  }) as unknown as import('../src/warcon.js').WarconClient;

const summaryOf = (players: { steamId: string; name: string }[]): SummaryBody => ({
  ok: true,
  live: {
    serverId: 's1',
    ok: true,
    status: { serverName: 'EU 1' },
    players: players.map((p) => ({ ...p, faction: 'Valkyra' }))
  }
});

const marksOf = (watched: string[]): MarksBody => ({
  ok: true,
  marks: watched.map((steamId) => ({ steamId, watched: true, reason: '', firstVisit: false }))
});

describe('pollWatchlist', () => {
  test('reports a watched player who was absent last cycle', async () => {
    const s = emptyServerState();
    const events = await pollWatchlist(
      client(summaryOf([{ steamId: '765', name: 'Alpha' }]), marksOf(['765'])),
      's1',
      s,
      NOW
    );
    expect((events[0] as WatchedJoinEvent).name).toBe('Alpha');
  });

  test('does not report a watched player who was already present', async () => {
    const s = emptyServerState();
    s.presentSteamIds = ['765'];
    const events = await pollWatchlist(
      client(summaryOf([{ steamId: '765', name: 'Alpha' }]), marksOf(['765'])),
      's1',
      s,
      NOW
    );
    expect(events).toHaveLength(0);
  });

  test('re-reports after the player left and came back', async () => {
    const s = emptyServerState();
    s.presentSteamIds = ['765'];
    await pollWatchlist(client(summaryOf([]), marksOf([])), 's1', s, NOW);
    const events = await pollWatchlist(
      client(summaryOf([{ steamId: '765', name: 'Alpha' }]), marksOf(['765'])),
      's1',
      s,
      NOW
    );
    expect(events).toHaveLength(1);
  });

  test('ignores an unwatched player', async () => {
    const s = emptyServerState();
    const events = await pollWatchlist(
      client(summaryOf([{ steamId: '765', name: 'Alpha' }]), marksOf([])),
      's1',
      s,
      NOW
    );
    expect(events).toHaveLength(0);
  });

  test('always records the current roster, watched or not', async () => {
    const s = emptyServerState();
    await pollWatchlist(
      client(summaryOf([{ steamId: '765', name: 'Alpha' }]), marksOf([])),
      's1',
      s,
      NOW
    );
    expect(s.presentSteamIds).toEqual(['765']);
  });

  test('an offline server empties the roster and reports nothing', async () => {
    const s = emptyServerState();
    s.presentSteamIds = ['765'];
    const events = await pollWatchlist(
      client({ ok: true, live: null }, marksOf([])),
      's1',
      s,
      NOW
    );
    expect(events).toHaveLength(0);
    expect(s.presentSteamIds).toEqual([]);
  });

  test('skips the marks call entirely when nobody is on', async () => {
    const s = emptyServerState();
    let calls = 0;
    const counting = {
      getJson: async (path: string) => {
        calls++;
        return path.includes('/marks') ? marksOf([]) : summaryOf([]);
      }
    } as unknown as import('../src/warcon.js').WarconClient;
    await pollWatchlist(counting, 's1', s, NOW);
    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/sources-watchlist.test.ts`
Expected: FAIL — cannot resolve `../src/sources/watchlist.js`.

- [ ] **Step 3: Implement `src/sources/watchlist.ts`**

```ts
import type { ModEvent, WatchedJoinEvent } from '../events.js';
import type { ServerState } from '../state.js';
import type { WarconClient } from '../warcon.js';
import type { MarksBody, SummaryBody } from '../warcon-types.js';

const MARKS_BATCH = 200;

/**
 * Watched players who have just appeared (spec §5.3).
 *
 * `marks` returns `watched` on server.view but blanks `reason` without staff
 * capability, so the embed links to the dossier instead of quoting a reason.
 */
export async function pollWatchlist(
  client: WarconClient,
  serverId: string,
  s: ServerState,
  now: number
): Promise<ModEvent[]> {
  const id = encodeURIComponent(serverId);
  const summary = await client.getJson<SummaryBody>(`/api/servers/${id}/summary`);
  const players = summary.live?.players ?? [];

  const previous = new Set(s.presentSteamIds);
  s.presentSteamIds = players.map((p) => p.steamId);

  const arrivals = players.filter((p) => !previous.has(p.steamId));
  if (arrivals.length === 0) return [];

  const events: WatchedJoinEvent[] = [];
  for (let i = 0; i < arrivals.length; i += MARKS_BATCH) {
    const batch = arrivals.slice(i, i + MARKS_BATCH);
    const query = new URLSearchParams({
      ids: batch.map((p) => p.steamId).join(','),
      names: batch.map((p) => p.name).join('\n')
    });
    const body = await client.getJson<MarksBody>(`/api/servers/${id}/players/marks?${query}`);
    const watched = new Set(body.marks.filter((m) => m.watched).map((m) => m.steamId));
    for (const p of batch) {
      if (!watched.has(p.steamId)) continue;
      events.push({
        kind: 'watchedJoin',
        serverId,
        at: new Date(now).toISOString(),
        steamId: p.steamId,
        name: p.name
      });
    }
  }

  return events;
}
```

- [ ] **Step 4: Write the failing K/D test**

`tests/sources-kd.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { pollKd, type KdPollConfig } from '../src/sources/kd.js';
import type { BoardBody, BoardRow } from '../src/warcon-types.js';
import type { HighKdEvent } from '../src/events.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const cfg: KdPollConfig = { threshold: 4, minMatches: 5, minMinutes: 60, range: '30d' };

const row = (over: Partial<BoardRow> = {}): BoardRow => ({
  steamId: '765',
  name: 'Alpha',
  minutes: 400,
  kills: 52,
  deaths: 10,
  matches: 9,
  ...over
});

const client = (rows: BoardRow[], seen?: (path: string) => void) =>
  ({
    getJson: async (path: string) => {
      seen?.(path);
      return { ok: true, rows } satisfies BoardBody;
    }
  }) as unknown as import('../src/warcon.js').WarconClient;

describe('pollKd', () => {
  test('flags a player over both thresholds', async () => {
    const events = await pollKd(client([row()]), 's1', cfg, NOW);
    expect(events).toHaveLength(1);
    expect((events[0] as HighKdEvent).kd).toBeCloseTo(5.2);
  });

  test('ignores a high K/D with too few matches', async () => {
    expect(await pollKd(client([row({ matches: 4 })]), 's1', cfg, NOW)).toHaveLength(0);
  });

  test('ignores an ordinary K/D over many matches', async () => {
    expect(
      await pollKd(client([row({ kills: 10, deaths: 10 })]), 's1', cfg, NOW)
    ).toHaveLength(0);
  });

  test('zero deaths is not an infinite K/D', async () => {
    expect(
      await pollKd(client([row({ kills: 3, deaths: 0 })]), 's1', cfg, NOW)
    ).toHaveLength(0);
  });

  test('a player with no kills and no deaths is not flagged', async () => {
    expect(
      await pollKd(client([row({ kills: 0, deaths: 0 })]), 's1', cfg, NOW)
    ).toHaveLength(0);
  });

  test('sends the configured floors to the panel', async () => {
    let path = '';
    await pollKd(client([], (p) => (path = p)), 's1', cfg, NOW);
    expect(path).toContain('minMinutes=60');
    expect(path).toContain('range=30d');
    expect(path).toContain('sort=kd');
    expect(path).toContain('scope=server');
  });
});
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npx vitest run tests/sources-kd.test.ts`
Expected: FAIL — cannot resolve `../src/sources/kd.js`.

- [ ] **Step 6: Implement `src/sources/kd.ts`**

```ts
import type { HighKdEvent, ModEvent } from '../events.js';
import type { WarconClient } from '../warcon.js';
import type { BoardBody } from '../warcon-types.js';

export interface KdPollConfig {
  threshold: number;
  minMatches: number;
  minMinutes: number;
  range: string;
}

/**
 * Players over the K/D threshold (spec §5.4).
 *
 * `matches`, not sessions: the board carries no session count, and a Warcon session
 * is one join-to-leave stay, so reconnects would inflate it. Zero deaths is not
 * treated as infinite — one lucky kill on a fresh account must not alert.
 */
export async function pollKd(
  client: WarconClient,
  serverId: string,
  cfg: KdPollConfig,
  now: number
): Promise<ModEvent[]> {
  const query = new URLSearchParams({
    scope: 'server',
    range: cfg.range,
    sort: 'kd',
    dir: 'desc',
    minMinutes: String(cfg.minMinutes)
  });
  const body = await client.getJson<BoardBody>(
    `/api/servers/${encodeURIComponent(serverId)}/leaderboard?${query}`
  );

  const events: HighKdEvent[] = [];
  for (const r of body.rows) {
    if (r.deaths <= 0) continue; // not infinite — see above
    const kd = r.kills / r.deaths;
    if (kd < cfg.threshold) continue;
    if (r.matches < cfg.minMatches) continue;
    events.push({
      kind: 'highKd',
      serverId,
      at: new Date(now).toISOString(),
      steamId: r.steamId,
      name: r.name,
      kd,
      kills: r.kills,
      deaths: r.deaths,
      matches: r.matches,
      minutes: r.minutes
    });
  }
  return events;
}
```

- [ ] **Step 7: Run both suites**

Run: `npx vitest run tests/sources-watchlist.test.ts tests/sources-kd.test.ts && npx tsc --noEmit`
Expected: all PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/sources/watchlist.ts src/sources/kd.ts tests/sources-watchlist.test.ts tests/sources-kd.test.ts
git commit -m "feat: watched-player and high-K/D sources"
```

---

### Task 9: Discord sink

**Files:**
- Create: `src/discord.ts`
- Test: `tests/discord.test.ts`

**Interfaces:**
- Consumes: `Decision`, `ModEvent` (Task 3).
- Produces: `buildMessage(d: Decision, links: LinkConfig, modRoleId: string): DiscordMessage`, the `DiscordPoster` interface, and `RestPoster`. Task 10 calls `buildMessage` then `poster.post`.

Implements spec §8.1 (embed evidence), §8.3 and §11. Splitting message *building* (pure) from *posting* (I/O) is what lets the interesting assertions run without a network.

- [ ] **Step 1: Write the failing test**

`tests/discord.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { buildMessage, type LinkConfig } from '../src/discord.js';
import type { Decision } from '../src/events.js';

const links: LinkConfig = { panelPublicUrl: 'https://panel.example.com' };
const ROLE = '999';

const teamKill: Decision = {
  ping: true,
  event: {
    kind: 'teamKill',
    serverId: 's1',
    at: '2026-09-24T12:00:00.000Z',
    eventId: 'e1',
    eventTime: 300,
    killer: { steamId: '765', name: 'Alpha', faction: 'Valkyra' },
    victim: { steamId: '766', name: 'Bravo', faction: 'Valkyra' },
    cause: 'Id.Item.AK74M',
    distanceM: 40.5,
    count: 3
  }
};

describe('buildMessage', () => {
  test('a pinging decision mentions the role and allows that one role', () => {
    const m = buildMessage(teamKill, links, ROLE);
    expect(m.content).toContain(`<@&${ROLE}>`);
    expect(m.allowed_mentions).toEqual({ parse: [], roles: [ROLE] });
  });

  test('a non-pinging decision mentions nothing at all', () => {
    const m = buildMessage({ ...teamKill, ping: false }, links, ROLE);
    expect(m.content ?? '').not.toContain('<@&');
    expect(m.allowed_mentions).toEqual({ parse: [] });
  });

  test('a team kill shows both factions, the evidence for the inference', () => {
    const text = JSON.stringify(buildMessage(teamKill, links, ROLE));
    expect(text).toContain('Valkyra');
  });

  test('a team kill links to the Kills tab filtered to that killer', () => {
    const text = JSON.stringify(buildMessage(teamKill, links, ROLE));
    expect(text).toContain(
      'https://panel.example.com/server/s1/kills?killer=765&kind=teamKill'
    );
  });

  test('links never use the internal container origin', () => {
    const text = JSON.stringify(buildMessage(teamKill, links, ROLE));
    expect(text).not.toContain('warcon:3000');
  });

  test('a watched join links to the dossier, since the reason is not readable', () => {
    const text = JSON.stringify(
      buildMessage(
        {
          ping: true,
          event: {
            kind: 'watchedJoin',
            serverId: 's1',
            at: '2026-09-24T12:00:00.000Z',
            steamId: '765',
            name: 'Alpha'
          }
        },
        links,
        ROLE
      )
    );
    expect(text).toContain('https://panel.example.com/server/s1/players/765');
  });

  test('an admin action names the actor, the target and the reason', () => {
    const text = JSON.stringify(
      buildMessage(
        {
          ping: false,
          event: {
            kind: 'adminAction',
            serverId: 's1',
            at: '2026-09-24T12:00:00.000Z',
            auditId: 7,
            action: 'rcon.ban',
            actorName: 'ModPerson',
            target: '765',
            reason: 'griefing'
          }
        },
        links,
        ROLE
      )
    );
    expect(text).toContain('ModPerson');
    expect(text).toContain('griefing');
  });

  test('every embed stays inside Discord field limits', () => {
    const long: Decision = {
      ping: false,
      event: {
        kind: 'adminAction',
        serverId: 's1',
        at: '2026-09-24T12:00:00.000Z',
        auditId: 7,
        action: 'rcon.ban',
        actorName: 'x'.repeat(500),
        target: '765',
        reason: 'y'.repeat(5000)
      }
    };
    const m = buildMessage(long, links, ROLE);
    expect(m.embeds[0]!.title!.length).toBeLessThanOrEqual(256);
    for (const f of m.embeds[0]!.fields ?? []) {
      expect(f.name.length).toBeLessThanOrEqual(256);
      expect(f.value.length).toBeLessThanOrEqual(1024);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/discord.test.ts`
Expected: FAIL — cannot resolve `../src/discord.js`.

- [ ] **Step 3: Implement `src/discord.ts`**

```ts
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import type { Decision, ModEvent } from './events.js';

export interface LinkConfig {
  /** the origin a mod's browser opens — never WARCON_BASE_URL */
  panelPublicUrl: string;
}

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  timestamp?: string;
  fields?: EmbedField[];
}

export interface DiscordMessage {
  content?: string;
  embeds: Embed[];
  allowed_mentions: { parse: []; roles?: string[] };
}

const COLOR = {
  teamKill: 0xd9534f,
  adminAction: 0x6c757d,
  watchedJoin: 0xf0ad4e,
  highKd: 0x5bc0de,
  feedQuiet: 0x8a6d3b
} as const;

const clamp = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1)}…`;

const field = (name: string, value: string, inline = true): EmbedField => ({
  name: clamp(name, 256),
  value: clamp(value || '—', 1024),
  inline
});

/** `Id.Item.AK74M` -> `AK74M`; Warcon labels these properly, we only shorten. */
const weapon = (cause: string | null): string => (cause ? (cause.split('.').pop() ?? cause) : '—');

function embedFor(e: ModEvent, links: LinkConfig): Embed {
  const base = `${links.panelPublicUrl}/server/${encodeURIComponent(e.serverId)}`;

  switch (e.kind) {
    case 'teamKill':
      return {
        title: clamp(`Team kill — ${e.killer.name} (${e.count})`, 256),
        url: `${base}/kills?killer=${encodeURIComponent(e.killer.steamId)}&kind=teamKill`,
        color: COLOR.teamKill,
        timestamp: e.at,
        fields: [
          field('Killer', `${e.killer.name} · ${e.killer.faction ?? 'unknown'}`),
          field('Victim', `${e.victim.name} · ${e.victim.faction ?? 'unknown'}`),
          field('Weapon', weapon(e.cause)),
          field('Distance', e.distanceM === null ? '—' : `${Math.round(e.distanceM)} m`),
          field('This match', String(e.count))
        ]
      };

    case 'adminAction': {
      const verb = { 'rcon.kick': 'Kick', 'rcon.ban': 'Ban', 'rcon.unban': 'Unban' }[e.action];
      return {
        title: clamp(`${verb} by ${e.actorName}`, 256),
        url: `${base}/players/${encodeURIComponent(e.target)}`,
        color: COLOR.adminAction,
        timestamp: e.at,
        fields: [field('Target', e.target), field('Reason', e.reason, false)]
      };
    }

    case 'watchedJoin':
      return {
        title: clamp(`Watched player joined — ${e.name}`, 256),
        // The reason needs players.notes, which this key does not hold (spec §5.3).
        url: `${base}/players/${encodeURIComponent(e.steamId)}`,
        color: COLOR.watchedJoin,
        timestamp: e.at,
        description: 'Open the dossier for the watch reason.',
        fields: [field('Steam ID', e.steamId)]
      };

    case 'highKd':
      return {
        title: clamp(`High K/D — ${e.name}`, 256),
        url: `${base}/players/${encodeURIComponent(e.steamId)}`,
        color: COLOR.highKd,
        timestamp: e.at,
        fields: [
          field('K/D', e.kd.toFixed(2)),
          field('Kills / deaths', `${e.kills} / ${e.deaths}`),
          field('Matches', String(e.matches)),
          field('Playtime', `${Math.round(e.minutes)} min`)
        ]
      };

    case 'feedQuiet':
      return {
        title: 'Kill feed has gone quiet',
        url: `${base}/config`,
        color: COLOR.feedQuiet,
        timestamp: e.at,
        description:
          'No kill batch has arrived recently. Check the feed Url on the Config tab — a config written before the /api/ingest/events suffix was known needs Configure again.',
        fields: [field('Last batch', e.lastFeedAt ?? 'never')]
      };
  }
}

export function buildMessage(
  d: Decision,
  links: LinkConfig,
  modRoleId: string
): DiscordMessage {
  const embed = embedFor(d.event, links);
  return d.ping
    ? {
        content: `<@&${modRoleId}>`,
        embeds: [embed],
        allowed_mentions: { parse: [], roles: [modRoleId] }
      }
    : { embeds: [embed], allowed_mentions: { parse: [] } };
}

export interface DiscordPoster {
  post(message: DiscordMessage): Promise<void>;
}

/** Posts over REST. No gateway connection: this bot never receives anything. */
export class RestPoster implements DiscordPoster {
  private readonly rest: REST;

  constructor(
    token: string,
    private readonly channelId: string
  ) {
    this.rest = new REST({ version: '10' }).setToken(token);
  }

  async post(message: DiscordMessage): Promise<void> {
    await this.rest.post(Routes.channelMessages(this.channelId), { body: message });
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/discord.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/discord.ts tests/discord.test.ts
git commit -m "feat: Discord embeds with inference evidence and role mentions"
```

---

#### Amendment A — server identity (spec §8.5), binding

Apply on top of the steps above, in the same commit or a follow-up commit within this task.

**`src/config.ts`** (Task 1's file) — add `serverLabels: Record<string, string>` to `Config`, parsed from `SERVER_LABELS`:
- unset or empty → `{}`
- split on `,`, trim each entry, skip empty entries
- each entry splits on the **first** `=` only, so a label may itself contain `=`; trim both sides
- an entry with no `=`, or an empty id or empty label, throws `SERVER_LABELS entry "<entry>" is not serverId=Label`

Tests in `tests/config.test.ts`: parses `' a = EU#1 , b=NA#3 ,, '` to `{ a: 'EU#1', b: 'NA#3' }`; defaults to `{}`; keeps `'a=x=y'` as `{ a: 'x=y' }`; throws naming the entry for `'a=EU#1,broken'`.

**`src/discord.ts`**:
- `LinkConfig` gains `serverLabels: Record<string, string>`.
- Export `serverLabel(serverId: string, labels: Record<string, string>): string` → `labels[serverId] ?? serverId.slice(0, 8)`.
- **Every** embed's title becomes `` clamp(`${label} · ${title}`, 256) ``, where `title` is the unclamped per-kind title above. Clamp once, over the whole string.
- A pinging message's `content` becomes `` `<@&${modRoleId}> **${label}**` ``. `allowed_mentions` is unchanged. A non-pinging message still has no `content`.

Tests in `tests/discord.test.ts` (update the shared `links` fixture to carry `serverLabels: { s1: 'NA#3' }`, and adjust any existing title assertion to the prefixed form):
- a team kill's title starts with `NA#3 · Team kill — Alpha`
- the feed-quiet title is `NA#3 · Kill feed has gone quiet`
- a pinging message's content is `<@&999> **NA#3**`; a non-pinging one has no `content`
- an unlabelled server id `c83bc8e1-ef6f-4d55-9398-b1a6f6faa2a8` produces a title starting `c83bc8e1 · `
- the 256-character title limit still holds with a label prefix and a very long player name

### Task 10: The polling loop

**Files:**
- Create: `src/log.ts`, `src/runner.ts`, `src/index.ts`
- Test: `tests/runner.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–9.
- Produces: `runCycle(deps: CycleDeps): Promise<void>` — the unit the tests drive — and `main()` in `index.ts`, which schedules it.

The loop is separated from `index.ts` so the cursor-safety rules of spec §9 can be tested without timers or a live process.

- [ ] **Step 1: Create `src/log.ts`**

```ts
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const stamp = (): string => new Date().toISOString();

export const consoleLogger: Logger = {
  info: (m) => console.log(`[${stamp()}] ${m}`),
  warn: (m) => console.warn(`[${stamp()}] ${m}`),
  error: (m) => console.error(`[${stamp()}] ${m}`)
};
```

- [ ] **Step 2: Write the failing test**

`tests/runner.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest';
import { runCycle, type CycleDeps } from '../src/runner.js';
import { emptyState, serverState, type State } from '../src/state.js';
import type { DiscordMessage } from '../src/discord.js';
import type { ModEvent } from '../src/events.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

const silent = { info: () => {}, warn: () => {}, error: () => {} };

const adminEvent = (auditId: number): ModEvent => ({
  kind: 'adminAction',
  serverId: 's1',
  at: '2026-09-24T12:00:00.000Z',
  auditId,
  action: 'rcon.ban',
  actorName: 'mod',
  target: '765',
  reason: 'griefing'
});

function deps(over: Partial<CycleDeps> = {}): CycleDeps {
  return {
    serverIds: ['s1'],
    state: emptyState(),
    now: NOW,
    runKd: false,
    logger: silent,
    escalateConfig: { teamKillPingAt: 3, kdCooldownDays: 7 },
    links: { panelPublicUrl: 'https://panel.example.com' },
    modRoleId: '999',
    sources: {
      kills: async () => [],
      audit: async () => [],
      watchlist: async () => [],
      kd: async () => []
    },
    poster: { post: async () => {} },
    save: async () => {},
    ...over
  };
}

describe('runCycle', () => {
  test('posts an event and saves state', async () => {
    const posted: DiscordMessage[] = [];
    const save = vi.fn(async () => {});
    await runCycle(
      deps({
        sources: {
          kills: async () => [],
          audit: async () => [adminEvent(1)],
          watchlist: async () => [],
          kd: async () => []
        },
        poster: { post: async (m) => void posted.push(m) },
        save
      })
    );
    expect(posted).toHaveLength(1);
    expect(save).toHaveBeenCalledOnce();
  });

  test('a cold start records position and posts nothing', async () => {
    const posted: DiscordMessage[] = [];
    const state = emptyState(); // cold === true
    const save = vi.fn(async () => {});
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => [],
          audit: async () => [adminEvent(1)],
          watchlist: async () => [],
          kd: async () => []
        },
        poster: { post: async (m) => void posted.push(m) },
        save
      })
    );
    expect(posted).toHaveLength(0);
    expect(save).toHaveBeenCalledOnce();
    expect(state.cold).toBe(false); // the next cycle reports normally
  });

  test('one failing source does not stop the others', async () => {
    const posted: DiscordMessage[] = [];
    const state = emptyState();
    state.cold = false;
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => {
            throw new Error('warcon down');
          },
          audit: async () => [adminEvent(1)],
          watchlist: async () => [],
          kd: async () => []
        },
        poster: { post: async (m) => void posted.push(m) }
      })
    );
    expect(posted).toHaveLength(1);
  });

  test('a failed post leaves the audit cursor unadvanced', async () => {
    const state = emptyState();
    state.cold = false;
    // The source advanced the cursor in-place, as the real one does.
    const audit = async (_id: string, s: ReturnType<typeof serverState>) => {
      s.lastAuditId = 7;
      return [adminEvent(7)];
    };
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => [],
          audit: audit as CycleDeps['sources']['audit'],
          watchlist: async () => [],
          kd: async () => []
        },
        poster: {
          post: async () => {
            throw new Error('discord 500');
          }
        }
      })
    );
    expect(serverState(state, 's1').lastAuditId).toBe(0);
  });

  test('a failed post also rolls back the K/D cooldown', async () => {
    const state = emptyState();
    state.cold = false;
    await runCycle(
      deps({
        state,
        runKd: true,
        sources: {
          kills: async () => [],
          audit: async () => [],
          watchlist: async () => [],
          kd: async () => [
            {
              kind: 'highKd',
              serverId: 's1',
              at: '2026-09-24T12:00:00.000Z',
              steamId: '765',
              name: 'Alpha',
              kd: 5.2,
              kills: 52,
              deaths: 10,
              matches: 9,
              minutes: 400
            }
          ]
        },
        poster: {
          post: async () => {
            throw new Error('discord 500');
          }
        }
      })
    );
    // Nobody was told, so the seven-day cooldown must not have started.
    expect(state.kdAlerted['765']).toBeUndefined();
  });

  test('a successful post keeps the advanced cursor', async () => {
    const state = emptyState();
    state.cold = false;
    const audit = async (_id: string, s: ReturnType<typeof serverState>) => {
      s.lastAuditId = 7;
      return [adminEvent(7)];
    };
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => [],
          audit: audit as CycleDeps['sources']['audit'],
          watchlist: async () => [],
          kd: async () => []
        }
      })
    );
    expect(serverState(state, 's1').lastAuditId).toBe(7);
  });

  test('the K/D source only runs when asked', async () => {
    const kd = vi.fn(async () => []);
    await runCycle(deps({ runKd: false, sources: { kills: async () => [], audit: async () => [], watchlist: async () => [], kd } }));
    expect(kd).not.toHaveBeenCalled();

    await runCycle(deps({ runKd: true, sources: { kills: async () => [], audit: async () => [], watchlist: async () => [], kd } }));
    expect(kd).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/runner.test.ts`
Expected: FAIL — cannot resolve `../src/runner.js`.

- [ ] **Step 4: Implement `src/runner.ts`**

```ts
import { buildMessage, type DiscordPoster, type LinkConfig } from './discord.js';
import { escalate, type EscalateConfig } from './escalate.js';
import { eventKey, type ModEvent } from './events.js';
import type { Logger } from './log.js';
import { serverState, type ServerState, type State } from './state.js';

export interface CycleSources {
  kills(serverId: string, s: ServerState): Promise<ModEvent[]>;
  audit(serverId: string, s: ServerState): Promise<ModEvent[]>;
  watchlist(serverId: string, s: ServerState): Promise<ModEvent[]>;
  kd(serverId: string): Promise<ModEvent[]>;
}

export interface CycleDeps {
  serverIds: string[];
  state: State;
  now: number;
  /** the K/D board runs on its own, slower schedule */
  runKd: boolean;
  logger: Logger;
  escalateConfig: EscalateConfig;
  links: LinkConfig;
  modRoleId: string;
  sources: CycleSources;
  poster: DiscordPoster;
  save(state: State): Promise<void>;
}

/**
 * One pass over every server.
 *
 * Cursor safety (spec §9): sources advance their cursors inside the state object as
 * they read. If a post then fails we restore that server's pre-cycle snapshot, so the
 * next cycle re-reads and re-reports rather than silently dropping the event.
 */
export async function runCycle(deps: CycleDeps): Promise<void> {
  const cold = deps.state.cold;

  for (const serverId of deps.serverIds) {
    const s = serverState(deps.state, serverId);
    // escalate() writes to BOTH the server entry and the global kdAlerted map, so a
    // failed post has to roll back both — otherwise a K/D alert nobody received still
    // starts its cooldown and the player goes unreported for days. Snapshotting
    // kdAlerted per server (not once per cycle) preserves earlier servers' alerts.
    const snapshot = structuredClone(s);
    const kdSnapshot = { ...deps.state.kdAlerted };

    const collected: ModEvent[] = [];
    const run = async (name: string, fn: () => Promise<ModEvent[]>): Promise<void> => {
      try {
        collected.push(...(await fn()));
      } catch (err) {
        // One source failing must not stop the others, or one server the rest.
        deps.logger.warn(`[${serverId}] ${name}: ${err instanceof Error ? err.message : err}`);
      }
    };

    await run('kills', () => deps.sources.kills(serverId, s));
    await run('audit', () => deps.sources.audit(serverId, s));
    await run('watchlist', () => deps.sources.watchlist(serverId, s));
    if (deps.runKd) await run('kd', () => deps.sources.kd(serverId));

    // A cold start learns where it is and says nothing (spec §7).
    if (cold) continue;

    const decisions = escalate(collected, deps.state, deps.escalateConfig, deps.now);

    let failed = false;
    for (const d of decisions) {
      try {
        await deps.poster.post(buildMessage(d, deps.links, deps.modRoleId));
        deps.logger.info(`[${serverId}] posted ${eventKey(d.event)}${d.ping ? ' (ping)' : ''}`);
      } catch (err) {
        deps.logger.error(
          `[${serverId}] discord post failed: ${err instanceof Error ? err.message : err}`
        );
        failed = true;
        break;
      }
    }

    if (failed) {
      deps.state.servers[serverId] = snapshot;
      deps.state.kdAlerted = kdSnapshot;
    }
  }

  deps.state.cold = false;
  await deps.save(deps.state);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/runner.test.ts`
Expected: all PASS.

- [ ] **Step 6: Implement `src/index.ts`**

```ts
import { loadConfig } from './config.js';
import { RestPoster } from './discord.js';
import { consoleLogger } from './log.js';
import { runCycle } from './runner.js';
import { pollAudit } from './sources/audit.js';
import { pollKd } from './sources/kd.js';
import { pollKills } from './sources/kills.js';
import { pollWatchlist } from './sources/watchlist.js';
import { loadState, saveState } from './state.js';
import { WarconClient } from './warcon.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = consoleLogger;

  if (config.serverIds.length === 0) {
    throw new Error('SERVER_IDS is empty — list the servers this bot should watch');
  }

  const client = new WarconClient({
    baseUrl: config.warconBaseUrl,
    token: config.warconToken,
    cfClientId: config.cfAccessClientId,
    cfClientSecret: config.cfAccessClientSecret,
    timeoutMs: config.requestTimeoutMs
  });

  const state = await loadState(config.statePath);
  if (state.cold) log.info('no usable state file — recording position, reporting nothing');

  const poster = new RestPoster(config.discordToken, config.discordChannelId);
  let lastKdAt = 0;

  const cycle = async (): Promise<void> => {
    const now = Date.now();
    const runKd = now - lastKdAt >= config.kdPollIntervalMs;
    if (runKd) lastKdAt = now;

    await runCycle({
      serverIds: config.serverIds,
      state,
      now,
      runKd,
      logger: log,
      escalateConfig: {
        teamKillPingAt: config.teamKillPingAt,
        kdCooldownDays: config.kdCooldownDays
      },
      links: { panelPublicUrl: config.panelPublicUrl },
      modRoleId: config.discordModRoleId,
      sources: {
        kills: (id, s) =>
          pollKills(client, id, s, { feedQuietMinutes: config.feedQuietMinutes, now }),
        audit: (id, s) => pollAudit(client, id, s),
        watchlist: (id, s) => pollWatchlist(client, id, s, now),
        kd: (id) =>
          pollKd(
            client,
            id,
            {
              threshold: config.kdThreshold,
              minMatches: config.kdMinMatches,
              minMinutes: config.kdMinMinutes,
              range: config.kdRange
            },
            now
          )
      },
      poster,
      save: (s) => saveState(config.statePath, s)
    });
  };

  await cycle();
  const timer = setInterval(() => {
    void cycle().catch((err) => log.error(err instanceof Error ? err.message : String(err)));
  }, config.pollIntervalMs);

  const shutdown = (signal: string): void => {
    log.info(`${signal} received, shutting down`);
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  consoleLogger.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: every suite PASS, typecheck clean.

- [ ] **Step 8: Commit**

```bash
git add src/log.ts src/runner.ts src/index.ts tests/runner.test.ts
git commit -m "feat: polling loop with cursor safety and per-source error containment"
```

---

#### Amendment A — server identity (spec §8.5), binding

`src/index.ts` passes the labels through: `links: { panelPublicUrl: config.panelPublicUrl, serverLabels: config.serverLabels }`. The runner test's `links` fixture gains `serverLabels: {}`. Log lines keep the raw server id — logs are for grepping, not reading at a glance.

### Task 11: Preflight and mock panel

**Files:**
- Create: `src/preflight.ts`, `scripts/mock-warcon.mjs`
- Test: `tests/preflight.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1), `WarconClient` (Task 2).
- Produces: `checkAll(client, config, discordFetch): Promise<CheckResult[]>` plus a CLI entry point. Task 12's deploy script runs `dist/preflight.js`.

Implements spec §10. The point is to fail a deploy on a missing capability, which otherwise presents as "no kicks have happened" (spec §4.1).

- [ ] **Step 1: Write the failing test**

`tests/preflight.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { checkAll } from '../src/preflight.js';
import { WarconAuthError } from '../src/warcon.js';

const config = {
  serverIds: ['s1'],
  discordToken: 'dtok',
  discordChannelId: '111',
  kdRange: '30d',
  kdMinMinutes: 60
};

const okDiscord = async () =>
  new Response(JSON.stringify({ username: 'modlog' }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });

describe('checkAll', () => {
  test('passes when every endpoint answers', async () => {
    const client = {
      getJson: async () => ({ ok: true, entries: [], kills: [], rows: [], marks: [], live: null })
    } as never;
    const results = await checkAll(client, config as never, okDiscord);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  test('reports a missing audit.read distinctly from other failures', async () => {
    const client = {
      getJson: async (path: string) => {
        if (path.startsWith('/api/audit')) throw new WarconAuthError('warcon auth rejected (403)');
        return { ok: true, entries: [], kills: [], rows: [], marks: [], live: null };
      }
    } as never;
    const results = await checkAll(client, config as never, okDiscord);
    const audit = results.find((r) => r.name.includes('audit'))!;
    expect(audit.ok).toBe(false);
    expect(audit.detail).toMatch(/audit\.read/);
  });

  test('reports a bad Discord token', async () => {
    const client = {
      getJson: async () => ({ ok: true, entries: [], kills: [], rows: [], marks: [], live: null })
    } as never;
    const bad = async () => new Response('{}', { status: 401 });
    const results = await checkAll(client, config as never, bad);
    expect(results.find((r) => r.name === 'discord token')!.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/preflight.test.ts`
Expected: FAIL — cannot resolve `../src/preflight.js`.

- [ ] **Step 3: Implement `src/preflight.ts`**

```ts
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Config } from './config.js';
import { CloudflareBlockedError, WarconAuthError, WarconClient } from './warcon.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Classifies a failure so a missing capability never looks like an empty result. */
function explain(path: string, err: unknown): string {
  if (err instanceof CloudflareBlockedError) return `Cloudflare Access blocked it: ${err.message}`;
  if (err instanceof WarconAuthError) {
    return path.startsWith('/api/audit')
      ? `rejected — this key is missing audit.read, without which kicks and bans silently read as zero rows (${err.message})`
      : `rejected — check the key has server.view on this server (${err.message})`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function checkAll(
  client: WarconClient,
  config: Config,
  discordFetch: (url: string, init: RequestInit) => Promise<Response>
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const res = await discordFetch('https://discord.com/api/v10/users/@me', {
    headers: { Authorization: `Bot ${config.discordToken}` }
  }).catch(() => null);
  results.push({
    name: 'discord token',
    ok: !!res?.ok,
    detail: res?.ok ? 'accepted' : `GET /users/@me returned ${res?.status ?? 'no response'}`
  });

  for (const id of config.serverIds) {
    const paths = [
      [`kills (${id})`, `/api/servers/${id}/kills?kind=teamKill&limit=1`],
      [`audit (${id})`, `/api/audit?category=rcon&server=${id}&limit=1`],
      [`summary (${id})`, `/api/servers/${id}/summary`],
      [
        `leaderboard (${id})`,
        `/api/servers/${id}/leaderboard?scope=server&range=${config.kdRange}&sort=kd&dir=desc&minMinutes=${config.kdMinMinutes}`
      ]
    ] as const;

    for (const [name, path] of paths) {
      try {
        await client.getJson(path);
        results.push({ name, ok: true, detail: 'answered' });
      } catch (err) {
        results.push({ name, ok: false, detail: explain(path, err) });
      }
    }
  }

  return results;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new WarconClient({
    baseUrl: config.warconBaseUrl,
    token: config.warconToken,
    cfClientId: config.cfAccessClientId,
    cfClientSecret: config.cfAccessClientSecret,
    timeoutMs: config.requestTimeoutMs
  });

  const results = await checkAll(client, config, fetch);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}: ${r.detail}`);

  const failures = results.filter((r) => !r.ok).length;
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nall checks passed');
}

// Only run as a CLI, so the tests can import checkAll without side effects.
// Compare resolved paths: matching on the basename alone would also fire when a
// test runner's argv happened to end the same way.
const invokedDirectly = (): boolean => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/preflight.test.ts`
Expected: all PASS.

- [ ] **Step 5: Create `scripts/mock-warcon.mjs`**

```js
// Serves the four endpoints the modlog bot reads, so it can be exercised without
// panel access. Mirrors WDstats' scripts/mock-warcon.mjs in spirit.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8788);
const SERVER_ID = process.env.MOCK_SERVER_ID ?? 's1';

let auditId = 0;
let killSeq = 0;

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/api/audit') {
    auditId++;
    return json(res, {
      ok: true,
      entries: [
        {
          id: auditId,
          createdAt: new Date().toISOString(),
          serverId: SERVER_ID,
          actorId: 'u1',
          actorName: 'MockMod',
          category: 'rcon',
          action: auditId % 2 ? 'rcon.kick' : 'rcon.ban',
          target: '76561190000000001',
          outcome: 'ok',
          detail: { reason: 'mock reason' }
        }
      ],
      nextBefore: null
    });
  }

  if (p.endsWith('/kills')) {
    killSeq++;
    return json(res, {
      ok: true,
      configured: true,
      feedAt: new Date().toISOString(),
      total: null,
      kills: [
        {
          eventId: `mock-${killSeq}`,
          ts: new Date().toISOString(),
          map: 'Kavkazi',
          eventTime: 100 + killSeq,
          killer: { steamId: '76561190000000001', name: 'Alpha', faction: 'Valkyra' },
          victim: { steamId: '76561190000000002', name: 'Bravo', faction: 'Valkyra' },
          cause: 'Id.Item.AK74M',
          distanceM: 42.5,
          headshot: false,
          suicide: false,
          teamKill: true,
          tags: []
        }
      ]
    });
  }

  if (p.endsWith('/summary')) {
    return json(res, {
      ok: true,
      live: {
        serverId: SERVER_ID,
        ok: true,
        status: { serverName: 'Mock EU 1' },
        players: [
          { steamId: '76561190000000001', name: 'Alpha', faction: 'Valkyra' },
          { steamId: '76561190000000003', name: 'Charlie', faction: 'Lonestar' }
        ]
      }
    });
  }

  if (p.endsWith('/players/marks')) {
    const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
    return json(res, {
      ok: true,
      // Charlie is the watched one.
      marks: ids.map((steamId) => ({
        steamId,
        watched: steamId === '76561190000000003',
        reason: '',
        firstVisit: false
      }))
    });
  }

  if (p.endsWith('/leaderboard')) {
    return json(res, {
      ok: true,
      rows: [
        { steamId: '76561190000000001', name: 'Alpha', minutes: 400, kills: 52, deaths: 10, matches: 9 },
        { steamId: '76561190000000002', name: 'Bravo', minutes: 300, kills: 20, deaths: 20, matches: 8 }
      ]
    });
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: { message: 'no such endpoint' } }));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock warcon on http://127.0.0.1:${PORT} (server id: ${SERVER_ID})`);
});
```

- [ ] **Step 6: Exercise preflight against the mock**

Run in one terminal: `npm run mock`
Run in another:

```bash
WARCON_BASE_URL=http://127.0.0.1:8788 PANEL_PUBLIC_URL=https://panel.example.com \
WARCON_TOKEN=x DISCORD_TOKEN=x DISCORD_CHANNEL_ID=1 DISCORD_MOD_ROLE_ID=2 \
SERVER_IDS=s1 npm run preflight
```

Expected: the four Warcon checks report `ok`; the Discord check reports FAIL (the token is fake) and the process exits non-zero. That is the correct result — it proves the gate fails loudly.

- [ ] **Step 7: Commit**

```bash
git add src/preflight.ts scripts/mock-warcon.mjs tests/preflight.test.ts
git commit -m "feat: preflight credential gate and mock panel"
```

---

#### Amendment A — server identity (spec §8.5), binding

- The test `config` fixture gains `serverLabels: { s1: 'EU#1' }`.
- After the four endpoint checks for a server, push one more result named `label (<id>)`, **always `ok: true`** — a missing label must never fail a deploy:
  - labelled: detail `EU#1 (Warcon calls it "<live serverName>")`, the live name taken from the summary response already fetched (`live?.status?.serverName`, or `unknown` when absent or the summary failed)
  - unlabelled: detail `none — alerts will show "<first 8 chars of id>"; add it to SERVER_LABELS`
- Reuse `serverLabel` from `src/discord.ts` rather than repeating the fallback. Keep the summary response from the endpoint loop instead of fetching it twice.
- Tests: a labelled server's label result is ok and names both the label and the live name; an unlabelled server's result is ok and contains `add it to SERVER_LABELS`.
- `scripts/mock-warcon.mjs` serves any server id it is asked for (a live name of `Mock <first 8 chars>`), so `SERVER_IDS` can list all six real servers against the mock.

### Task 12: Containerisation, deployment and documentation

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `scripts/deploy.sh`, `.github/workflows/deploy.yml`, `README.md`

**Interfaces:**
- Consumes: `dist/index.js` and `dist/preflight.js` from the build.
- Produces: nothing other code imports.

Implements spec §12. The two details in §12.1 and §12.2 are the ones most likely to be lost — the volume ownership and the `docker compose run` stdin trap.

- [ ] **Step 1: Create `Dockerfile`**

```dockerfile
# Build stage: full deps, compile TypeScript to dist/.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: production deps and the compiled output only.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The state volume mounts at /data. A named volume on a path that does not exist
# in the image is created owned by root, and `node` could then never write its
# state — the bot would cold-start every boot and silently report nothing.
# Creating it with the right owner here makes Docker carry that ownership over.
RUN mkdir -p /data && chown node:node /data
VOLUME /data

USER node

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Create `.dockerignore`**

```
node_modules
dist
.git
.env
*.md
tests
```

- [ ] **Step 3: Create `docker-compose.yml`**

```yaml
services:
  modlog:
    build: .
    image: wardogs-modlog:latest
    container_name: wardogs-modlog
    restart: unless-stopped
    # Secrets live only on the VPS. This file is never built into the image.
    env_file: .env
    volumes:
      - modlog-state:/data
    networks:
      - warcon
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  modlog-state:

networks:
  warcon:
    external: true
    # Warcon's compose declares no network, so it gets the project default,
    # named after its directory: /home/debian/warcon -> warcon_default.
    name: warcon_default
```

- [ ] **Step 4: Create `scripts/deploy.sh`**

```bash
#!/usr/bin/env bash
# Runs ON THE VPS, piped in over SSH by .github/workflows/deploy.yml.
# Expects a checkout at $DEPLOY_DIR holding a .env that git never tracks.
set -euo pipefail

DEPLOY_DIR="${DEPLOY_DIR:-/home/debian/wardogs-modlog}"
BRANCH="${DEPLOY_BRANCH:-master}"

cd "$DEPLOY_DIR"

if [ ! -f .env ]; then
  echo "no .env in $DEPLOY_DIR — create it before the first deploy" >&2
  exit 1
fi

# .env is gitignored, so a hard reset cannot clobber it.
git fetch --prune origin
git reset --hard "origin/$BRANCH"
echo "deploying $(git rev-parse --short HEAD)"

docker compose build

# Credentials and panel reachability are checked against the NEW image before the
# running container is replaced. Read-only: it never posts to Discord.
#
# -T and </dev/null both matter: this script is fed to bash over stdin by the
# workflow, and `docker compose run` attaches stdin by default — without them it
# swallows the rest of this file and everything below silently never runs.
echo "running preflight…"
docker compose run --rm --no-deps -T modlog node dist/preflight.js </dev/null

# Deliberately no `docker image prune` anywhere: every command stays scoped to
# this compose project, so nothing can reach the panel's containers or images.
docker compose up -d </dev/null

# A truncated or half-failed run must not look like a success.
docker compose ps --status running --format '{{.Name}}' | grep -q . \
  || { echo "container is not running after up -d" >&2; exit 1; }

echo "deployed $(git rev-parse --short HEAD)"
```

- [ ] **Step 5: Create `.github/workflows/deploy.yml`**

```yaml
name: deploy

on:
  push:
    branches: [master]
  workflow_dispatch:

concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test

  deploy:
    needs: verify
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Add VPS host key
        run: |
          mkdir -p ~/.ssh && chmod 700 ~/.ssh
          if [ -n "${{ secrets.VPS_HOST_KEY }}" ]; then
            echo "${{ secrets.VPS_HOST_KEY }}" > ~/.ssh/known_hosts
          else
            ssh-keyscan -H "${{ secrets.VPS_HOST }}" > ~/.ssh/known_hosts
          fi
          chmod 600 ~/.ssh/known_hosts

      - name: Install deploy key
        run: |
          printf '%s\n' "${{ secrets.VPS_SSH_KEY }}" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519

      - name: Deploy
        run: |
          ssh -o StrictHostKeyChecking=yes -o BatchMode=yes \
            "${{ secrets.VPS_USER }}@${{ secrets.VPS_HOST }}" \
            'bash -s' < scripts/deploy.sh
```

- [ ] **Step 6: Make the script executable and write `README.md`**

Run: `chmod +x scripts/deploy.sh`

`README.md` must cover, each as its own short section:

1. **What it does** — the four event kinds and which ping (copy the table from spec §2).
2. **Why it exists** — Warcon detects all of this but strips mentions from webhooks, so it cannot notify anyone.
3. **The API key** — `server.view` + `audit.read`, and an explicit warning **not** to tick Raw RCON or Automation, with the reason: Automation is a write capability that can delete triggers.
4. **Setup** — `npm install`, `cp .env.example .env`, `npm test`, `npm run preflight`, `npm run build`, `npm start`.
5. **Testing without panel access** — `npm run mock`, then `WARCON_BASE_URL=http://127.0.0.1:8788 npm run preflight`.
6. **Deployment** — the VPS layout, `WARCON_BASE_URL=http://warcon:3000`, why Cloudflare Access needs no service token, and `PANEL_PUBLIC_URL` being the browser-facing origin instead.
7. **Configuration table** — every variable from spec §10 with a one-line meaning, and the warning that values containing `#` must be quoted.
8. **Known limitations** — team kills are inferred (spec §13), and the watch *reason* is not readable on this key.

- [ ] **Step 7: Verify the image builds and preflight runs inside it**

```bash
docker compose build
docker compose run --rm --no-deps -T modlog node dist/preflight.js </dev/null; echo "exit: $?"
```

Expected: the build succeeds; preflight runs and exits non-zero against an unconfigured `.env`, printing which checks failed. Confirm the failures name specific variables rather than crashing.

- [ ] **Step 8: Verify the state volume is writable by `node`**

```bash
docker compose run --rm -T modlog sh -c 'touch /data/probe && ls -la /data' </dev/null
```

Expected: `probe` is created and `/data` is owned by `node`. If this prints a permission error, §12.1 was not applied — the bot would otherwise cold-start on every boot and silently report nothing.

- [ ] **Step 9: Commit**

```bash
git add Dockerfile .dockerignore docker-compose.yml scripts/deploy.sh .github/workflows/deploy.yml README.md
git commit -m "feat: containerisation, deploy pipeline and documentation"
```

---

#### Amendment A — server identity and the six servers, binding

**`.env.example`** (Task 1's file): replace the `# Empty means every server the key can see` comment and the empty `SERVER_IDS=` with the six real servers and their labels. Quote the labels — they contain `#`:

```
# Required: the servers to watch. Every alert is prefixed with its SERVER_LABELS label.
SERVER_IDS=0eec42dc-f73f-4e43-a62e-7e0900fcf38c,61dd0256-b780-40b5-a9fa-2b5bc542ce88,0abd34ac-c564-4d2e-9853-263d707528c3,33daa183-8c52-41f8-b936-b8524eaf7387,ff450efd-8080-4cab-a0ac-e5a3bf8fbf5f,c83bc8e1-ef6f-4d55-9398-b1a6f6faa2a8
SERVER_LABELS="0eec42dc-f73f-4e43-a62e-7e0900fcf38c=EU#1,61dd0256-b780-40b5-a9fa-2b5bc542ce88=EU#2,0abd34ac-c564-4d2e-9853-263d707528c3=NA#1,33daa183-8c52-41f8-b936-b8524eaf7387=NA#2,ff450efd-8080-4cab-a0ac-e5a3bf8fbf5f=Hardcore,c83bc8e1-ef6f-4d55-9398-b1a6f6faa2a8=NA#3"
```

**`README.md`**: the configuration table lists `SERVER_LABELS`, and the README gains an **Adding a server** section with the three steps NA#3 needed: add the id to `SERVER_IDS`, add its label to `SERVER_LABELS`, and add the server to the modlog Warcon key's server scope — without that last step preflight fails with a Warcon rejection for that server. Mention the example of an alert title, `NA#3 · Team kill — Alpha (3)`, where the README describes what gets posted.

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| §2 scope, four event kinds | 6, 7, 8 |
| §2.1 chat out of scope | documented, Task 12 step 6 |
| §3 separate repo and container | 1, 12 |
| §8.5 server identity (Amendment A) | 9, 10, 11, 12 |
| §4.1 key capabilities | 11 (preflight names the missing one), 12 (README) |
| §4.2 Discord, REST-only | 9 |
| §5.1 kills, backwards paging | 6 |
| §5.2 audit, high-water id | 7 |
| §5.3 watchlist, reason not readable | 8, 9 |
| §5.4 K/D, matches not sessions | 8 |
| §6 module layout | 1–10 |
| §7 state, cold start, ring buffer | 4, 10 |
| §8.1 team kill counting and evidence embed | 5, 6, 9 |
| §8.2 admin actions never ping | 5, 7 |
| §8.3 watched joins and K/D cooldown | 5, 8 |
| §8.4 feed health | 6 |
| §9 failure handling, cursor safety | 2, 10 |
| §10 configuration and preflight | 1, 11 |
| §11 testing | every task |
| §12 deployment, volume ownership, stdin trap | 12 |
| §13 known limitations | 12 (README) |

**Placeholder scan:** none — every step carries runnable content. Task 12 step 6 specifies the README by required section rather than prose, which is the one place a writer has latitude; the eight sections are enumerated so nothing can be silently dropped.

**Type consistency checked:** `ServerState` fields (`seenKillIds`, `lastAuditId`, `presentSteamIds`, `lastFeedAt`, `lastEventTime`, `teamKills`, `feedQuietWarned`) are defined in Task 4 and used identically in 5, 6, 7, 8 and 10. `ModEvent` variants defined in Task 3 are constructed in 6, 7, 8 and consumed in 5, 9, 10. `escalate()` stamps `TeamKillEvent.count`, which Task 6 emits as `0` and Task 9 renders — the contract is stated in the interface comment in all three places. `WarconClient.getJson` is the single call shape used by all four sources.

**One deliberate deviation from the spec's module table:** the spec lists `src/index.ts` as "the loop". The plan splits it into `runner.ts` (the cycle, testable) and `index.ts` (wiring and timers), because the cursor-safety rules of §9 are the single most important thing to test and are untestable inside a `setInterval`.
