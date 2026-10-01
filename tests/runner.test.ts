import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { PING_KINDS } from '../src/escalate.js';
import { retryKey, runCycle, type CycleDeps } from '../src/runner.js';
import { emptyState, loadState, saveState, serverState, type State } from '../src/state.js';
import type { DiscordMessage } from '../src/discord.js';
import type { HotPlayerEvent, ModEvent, PlayerJoinedEvent } from '../src/events.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const HOUR = 3_600_000;

const silent = { info: () => {}, warn: () => {}, error: () => {} };

/** A state whose listed servers have already completed a clean cycle (spec §7). */
function warmState(...serverIds: string[]): State {
  const state = emptyState();
  for (const id of serverIds.length ? serverIds : ['s1']) serverState(state, id).warm = true;
  return state;
}

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
    escalateConfig: { joinAlertHours: 24, pingOn: new Set(PING_KINDS) },
    links: { panelPublicUrl: 'https://panel.example.com', serverLabels: {} },
    modRoleId: '999',
    sources: {
      kills: async () => [],
      audit: async () => [],
      known: async () => [],
      presence: async () => []
    },
    poster: { post: async () => {} },
    save: async () => {},
    ...over
  };
}

const joined = (steamId: string, over: Partial<PlayerJoinedEvent> = {}): PlayerJoinedEvent => ({
  kind: 'playerJoined',
  serverId: 's1',
  at: '2026-09-24T12:00:00.000Z',
  steamId,
  name: steamId === '765' ? 'Alpha' : 'Bravo',
  watched: false,
  sweat: true,
  highKd: false,
  ...over
});

const hot = (steamId: string): HotPlayerEvent => ({
  kind: 'hotPlayer',
  serverId: 's1',
  at: '2026-09-24T12:00:00.000Z',
  steamId,
  name: steamId === '765' ? 'Alpha' : 'Bravo',
  kills: 12,
  deaths: 3,
  measuredKills: 10,
  minutes: 30,
  perHour: 24,
  history: { kind: 'unavailable' }
});

describe('runCycle', () => {
  test('posts an event and saves state', async () => {
    const posted: DiscordMessage[] = [];
    const state = warmState(); // this test exercises the normal (non-cold-start) path
    const save = vi.fn(async () => {});
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => [],
          audit: async () => [adminEvent(1)],
          known: async () => [],
          presence: async () => []
        },
        poster: { post: async (m) => void posted.push(m) },
        save
      })
    );
    expect(posted).toHaveLength(1);
    expect(save).toHaveBeenCalledTimes(2); // after the server, then the final save
  });

  test("saves after each server, so a restart mid-cycle keeps what earlier servers posted", async () => {
    const order: string[] = [];
    const saved: State[] = [];
    const state = warmState('s1', 's2');
    const source = (name: string) => async (id: string) => {
      order.push(`${name}:${id}`);
      return name === 'presence' ? [{ ...joined(`p-${id}`), serverId: id }] : [];
    };
    await runCycle(
      deps({
        serverIds: ['s1', 's2'],
        state,
        runKd: true,
        sources: {
          kills: source('kills'),
          audit: source('audit'),
          known: source('known'),
          presence: source('presence')
        },
        save: async (s) => {
          order.push('save');
          saved.push(structuredClone(s));
        }
      })
    );
    // The first save lands before s2's sources run, and the cycle still ends with one.
    expect(order.indexOf('save')).toBeGreaterThan(order.indexOf('presence:s1'));
    expect(order.indexOf('save')).toBeLessThan(order.indexOf('kills:s2'));
    expect(order.at(-1)).toBe('save');
    expect(saved.length).toBeGreaterThanOrEqual(3);
    // What that first save holds: s1's delivered join and its once-a-day stamp.
    expect(saved[0]!.joinAlerted).toEqual({ 'p-s1': NOW });
  });

  test('sources run in order: kills, audit, known, then presence', async () => {
    const order: string[] = [];
    const source = (name: string) => async () => {
      order.push(name);
      return [];
    };
    const sources = {
      kills: source('kills'),
      audit: source('audit'),
      known: source('known'),
      presence: source('presence')
    };
    await runCycle(deps({ state: warmState(), runKd: true, sources }));
    expect(order).toEqual(['kills', 'audit', 'known', 'presence']);
  });

  test('once loaded, the known lists refresh only on the K/D schedule; presence runs every cycle', async () => {
    const state = emptyState();
    serverState(state, 's1').knownAt = NOW - 60_000;
    const known = vi.fn(async () => []);
    const presence = vi.fn(async () => []);
    const sources = { kills: async () => [], audit: async () => [], known, presence };
    await runCycle(deps({ state, runKd: false, sources }));
    expect(known).not.toHaveBeenCalled();
    expect(presence).toHaveBeenCalledOnce();
    await runCycle(deps({ state, runKd: true, sources }));
    expect(known).toHaveBeenCalledOnce();
    expect(presence).toHaveBeenCalledTimes(2);
  });

  test('lists that have never loaded are retried every cycle, not left empty for an hour', async () => {
    const state = emptyState();
    const known = vi.fn(async () => {
      throw new Error('board down');
    });
    const sources = { kills: async () => [], audit: async () => [], known, presence: async () => [] };
    await runCycle(deps({ state, runKd: true, sources }));
    await runCycle(deps({ state, runKd: false, sources }));
    expect(known).toHaveBeenCalledTimes(2);
  });

  test('a cold start records position and posts nothing', async () => {
    const posted: DiscordMessage[] = [];
    const state = emptyState(); // no server has completed a clean cycle yet
    const save = vi.fn(async () => {});
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => [],
          audit: async () => [adminEvent(1)],
          known: async () => [],
          presence: async () => []
        },
        poster: { post: async (m) => void posted.push(m) },
        save
      })
    );
    expect(posted).toHaveLength(0);
    expect(save).toHaveBeenCalledTimes(2); // after the server, then the final save
    expect(serverState(state, 's1').warm).toBe(true); // the next cycle reports normally
  });

  test('one failing source does not stop the others', async () => {
    const posted: DiscordMessage[] = [];
    const state = warmState();
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => {
            throw new Error('warcon down');
          },
          audit: async () => [adminEvent(1)],
          known: async () => [],
          presence: async () => []
        },
        poster: { post: async (m) => void posted.push(m) }
      })
    );
    expect(posted).toHaveLength(1);
  });

  test('a failed post leaves the audit cursor unadvanced', async () => {
    const state = warmState();
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
          known: async () => [],
          presence: async () => []
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

  test('a successful post keeps the advanced cursor', async () => {
    const state = warmState();
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
          known: async () => [],
          presence: async () => []
        }
      })
    );
    expect(serverState(state, 's1').lastAuditId).toBe(7);
  });

  test('a retry skips an event that already posted before a failure, then clears once a cycle completes cleanly', async () => {
    const posted: DiscordMessage[] = [];
    const state = warmState();

    // A stand-in for the real audit source: returns whichever of rows 5/6 are still
    // ahead of the cursor, and advances the cursor past both when it does.
    const audit: CycleDeps['sources']['audit'] = async (_id, s) => {
      const rows = [5, 6].filter((id) => id > s.lastAuditId);
      if (rows.length === 0) return [];
      s.lastAuditId = 6;
      return rows.map((id) => adminEvent(id));
    };

    let callCount = 0;
    const post = vi.fn(async (m: DiscordMessage) => {
      callCount++;
      if (callCount === 2) throw new Error('discord 500'); // row 6's first attempt fails
      posted.push(m);
    });

    // Cycle 1: both rows arrive in one batch; row 5 posts, row 6's post throws — the
    // whole-server rollback (spec §9) puts the cursor back to 0.
    await runCycle(
      deps({
        state,
        sources: { kills: async () => [], audit, known: async () => [], presence: async () => [] },
        poster: { post }
      })
    );
    expect(posted).toHaveLength(1); // only row 5 delivered
    expect(serverState(state, 's1').lastAuditId).toBe(0); // cursor rolled back
    expect(serverState(state, 's1').postedBeforeFailure).toEqual(['adminAction:5']);

    // Cycle 2 (the retry): the rolled-back cursor makes the audit stand-in re-read
    // both rows again, but row 5's retry key is already recorded — it must not post a
    // second time. Row 6 posts for real this time.
    await runCycle(
      deps({
        state,
        sources: { kills: async () => [], audit, known: async () => [], presence: async () => [] },
        poster: { post }
      })
    );
    expect(posted).toHaveLength(2); // row 6 delivered; row 5 never seen again
    expect(post).toHaveBeenCalledTimes(3); // cycle 1: 2 attempts; cycle 2: 1 (row 5 skipped)
    expect(serverState(state, 's1').lastAuditId).toBe(6); // cycle 2 succeeded fully
    expect(serverState(state, 's1').postedBeforeFailure).toEqual([]); // clean cycle clears it
  });

  test('a watched join skipped on the immediate retry still alerts on a later genuine rejoin', async () => {
    const posted: DiscordMessage[] = [];
    const state = warmState();
    const watchedJoin = joined('765', { watched: true, sweat: false });
    const sources = (events: ModEvent[]) => ({
      kills: async () => [],
      audit: async () => [],
      known: async () => [],
      presence: async () => events
    });

    let callCount = 0;
    const post = vi.fn(async (m: DiscordMessage) => {
      callCount++;
      if (callCount === 2) throw new Error('discord 500'); // the hot alert fails
      posted.push(m);
    });

    // Cycle 1: the watched join posts; the hot alert after it fails to post, rolling the
    // server entry back — including presentSteamIds, so the same arrival would look
    // "new" again on a re-read.
    await runCycle(deps({ state, sources: sources([watchedJoin, hot('999')]), poster: { post } }));
    expect(posted).toHaveLength(1); // only the watched join delivered
    expect(serverState(state, 's1').postedBeforeFailure).toEqual(['playerJoined:s1:765']);

    // Cycle 2 (the immediate retry): the same arrival is re-read, but its retry key is
    // already recorded — must not post a second time. Nothing else fails this cycle.
    await runCycle(deps({ state, sources: sources([watchedJoin]), poster: { post } }));
    expect(posted).toHaveLength(1); // still just the one delivery
    expect(serverState(state, 's1').postedBeforeFailure).toEqual([]); // clean cycle clears it

    // Cycle 3: a genuine later rejoin (same steamId) — one-cycle scope means it must
    // still alert, not be silently swallowed forever.
    await runCycle(deps({ state, sources: sources([watchedJoin]), poster: { post } }));
    expect(posted).toHaveLength(2); // the later rejoin posts
  });

  test('keeps postedBeforeFailure when a source threw on the retry cycle', async () => {
    const posted: DiscordMessage[] = [];
    const state = warmState();

    const audit: CycleDeps['sources']['audit'] = async (_id, s) => {
      const rows = [5, 6].filter((id) => id > s.lastAuditId);
      if (rows.length === 0) return [];
      s.lastAuditId = 6;
      return rows.map((id) => adminEvent(id));
    };
    const auditDown: CycleDeps['sources']['audit'] = async () => {
      throw new Error('audit 503');
    };

    let calls = 0;
    const post = async (m: DiscordMessage) => {
      if (++calls === 2) throw new Error('discord 500'); // row 6's first attempt
      posted.push(m);
    };
    const sources = (a: CycleDeps['sources']['audit']) => ({
      kills: async () => [],
      audit: a,
      known: async () => [],
      presence: async () => []
    });

    await runCycle(deps({ state, sources: sources(audit), poster: { post } }));
    expect(serverState(state, 's1').postedBeforeFailure).toEqual(['adminAction:5']);

    // Cycle 2: no post fails, but the audit source is down, so row 5 was never re-read.
    // Clearing the list now would let cycle 3 post row 5 a second time.
    await runCycle(deps({ state, sources: sources(auditDown), poster: { post } }));
    expect(serverState(state, 's1').postedBeforeFailure).toEqual(['adminAction:5']);

    // Cycle 3: audit is back; row 5 is skipped, row 6 posts, and the list clears.
    await runCycle(deps({ state, sources: sources(audit), poster: { post } }));
    expect(posted.map((m) => m.embeds[0]!.title)).toHaveLength(2);
    expect(serverState(state, 's1').postedBeforeFailure).toEqual([]);
  });

  test('a post Discord rejects outright (4xx) is logged and skipped; later posts go out and cursors advance', async () => {
    const state = warmState();
    const error = vi.fn();
    const audit: CycleDeps['sources']['audit'] = async (_id, s) => {
      s.lastAuditId = 8;
      return [adminEvent(7), adminEvent(8)];
    };
    const posted: DiscordMessage[] = [];
    let calls = 0;
    await runCycle(
      deps({
        state,
        logger: { ...silent, error },
        sources: { kills: async () => [], audit, known: async () => [], presence: async () => [] },
        poster: {
          post: async (m) => {
            if (++calls === 1) {
              throw Object.assign(new Error('Invalid Form Body'), { status: 400 });
            }
            posted.push(m);
          }
        }
      })
    );
    expect(posted).toHaveLength(1); // row 8 still posted
    expect(serverState(state, 's1').lastAuditId).toBe(8); // not rolled back
    expect(serverState(state, 's1').postedBeforeFailure).toEqual([]);
    expect(error).toHaveBeenCalledOnce();
    const [line] = error.mock.calls[0]!;
    expect(line).toContain('[s1]');
    expect(line).toContain('adminAction:7');
    expect(line).toContain('400');
    expect(line).toContain('Invalid Form Body');
  });

  test('a rate-limited post (429) still rolls back for a retry', async () => {
    const state = warmState();
    const audit: CycleDeps['sources']['audit'] = async (_id, s) => {
      s.lastAuditId = 7;
      return [adminEvent(7)];
    };
    await runCycle(
      deps({
        state,
        sources: { kills: async () => [], audit, known: async () => [], presence: async () => [] },
        poster: {
          post: async () => {
            throw Object.assign(new Error('You are being rate limited.'), { status: 429 });
          }
        }
      })
    );
    expect(serverState(state, 's1').lastAuditId).toBe(0);
  });

  test('a cold cycle in which a source failed leaves the server cold, so the backlog is not later reported as new', async () => {
    const state = emptyState();
    const save = vi.fn(async () => {});
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => {
            throw new Error('warcon down');
          },
          audit: async () => [],
          known: async () => [],
          presence: async () => []
        },
        save
      })
    );
    expect(serverState(state, 's1').warm).toBe(false); // still cold — needs one fully clean cycle
    expect(save).toHaveBeenCalledTimes(2); // whatever position we did learn is still saved (per server, then final)
  });

  test('a clean cold cycle warms the server', async () => {
    const state = emptyState();
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => [],
          audit: async () => [],
          known: async () => [],
          presence: async () => []
        }
      })
    );
    expect(serverState(state, 's1').warm).toBe(true);
  });

  test('a failing known source does not keep a server cold: it has no cursor', async () => {
    const state = emptyState();
    await runCycle(
      deps({
        state,
        runKd: true,
        sources: {
          kills: async () => [],
          audit: async () => [],
          known: async () => {
            throw new Error('leaderboard down');
          },
          presence: async () => []
        }
      })
    );
    expect(serverState(state, 's1').warm).toBe(true);
  });

  test('a new server id added to a warm state posts nothing on its first cycle', async () => {
    const posted: DiscordMessage[] = [];
    const state = warmState('s1');
    const audit: CycleDeps['sources']['audit'] = async (id) => [{ ...adminEvent(1), serverId: id }];
    await runCycle(
      deps({
        serverIds: ['s1', 's2'],
        state,
        sources: { kills: async () => [], audit, known: async () => [], presence: async () => [] },
        poster: { post: async (m) => void posted.push(m) }
      })
    );
    expect(posted).toHaveLength(1); // s1's event only — s2's history is not flooded
    expect(posted[0]!.embeds[0]!.title).toMatch(/^s1 /);
    expect(serverState(state, 's2').warm).toBe(true); // s2 reports from the next cycle
  });

  test('a server whose audit source throws on its first cycle stays cold, across a restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'modlog-runner-'));
    const path = join(dir, 'state.json');
    const state = emptyState();
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => [],
          audit: async () => {
            throw new Error('audit 503');
          },
          known: async () => [],
          presence: async () => []
        },
        save: (s) => saveState(path, s)
      })
    );
    expect(serverState(state, 's1').warm).toBe(false);

    // A restart: the bot must come back up cold for s1, not treat the file as warm.
    const back = await loadState(path);
    const posted: DiscordMessage[] = [];
    await runCycle(
      deps({
        state: back,
        sources: {
          kills: async () => [],
          audit: async () => [adminEvent(1)], // the backlog, now readable
          known: async () => [],
          presence: async () => []
        },
        poster: { post: async (m) => void posted.push(m) }
      })
    );
    expect(posted).toHaveLength(0); // still records position only
    expect(serverState(back, 's1').warm).toBe(true);
  });

  test('once warm, events post', async () => {
    const posted: DiscordMessage[] = [];
    const state = emptyState();
    const sources = {
      kills: async () => [],
      audit: async () => [adminEvent(1)],
      known: async () => [],
      presence: async () => []
    };
    const poster = { post: async (m: DiscordMessage) => void posted.push(m) };
    await runCycle(deps({ state, sources, poster })); // cold: records position
    expect(posted).toHaveLength(0);
    await runCycle(deps({ state, sources, poster })); // warm: reports
    expect(posted).toHaveLength(1);
  });

  test("one server's failure does not keep another server cold", async () => {
    const state = emptyState();
    const audit: CycleDeps['sources']['audit'] = async (id) => {
      if (id === 's1') throw new Error('audit 503');
      return [];
    };
    await runCycle(
      deps({
        serverIds: ['s1', 's2'],
        state,
        sources: { kills: async () => [], audit, known: async () => [], presence: async () => [] }
      })
    );
    expect(serverState(state, 's1').warm).toBe(false);
    expect(serverState(state, 's2').warm).toBe(true);
  });

  test('logs once when a server turns warm', async () => {
    const info = vi.fn();
    const state = emptyState();
    const logger = { ...silent, info };
    await runCycle(deps({ state, logger }));
    await runCycle(deps({ state, logger }));
    expect(info.mock.calls.filter(([m]) => /warm/.test(String(m)))).toHaveLength(1);
  });

  test('retryKey drops the cycle time from join and hot events', () => {
    expect(retryKey(joined('765'))).toBe('playerJoined:s1:765');
    expect(retryKey(hot('765'))).toBe('hotPlayer:s1:765');
  });
});

describe('live alerts in the cycle', () => {
  test('a failed post rolls back match.alerted and joinAlerted, and re-stamps delivered joins', async () => {
    const state = warmState();
    const presence: CycleDeps['sources']['presence'] = async (_id, s) => {
      s.match = { lastSeenAt: NOW, map: null, baselines: { '765': { at: 0, kills: 0, last: 9 } }, alerted: ['765', '766'] };
      return [joined('765'), joined('767'), hot('765'), hot('766')];
    };
    let calls = 0;
    await runCycle(
      deps({
        state,
        sources: { kills: async () => [], audit: async () => [], known: async () => [], presence },
        poster: {
          post: async () => {
            if (++calls === 4) throw new Error('discord down'); // 766's hot alert
          }
        }
      })
    );
    // Both joins went out: their stamps stand, so the retry does not tag them again.
    expect(state.joinAlerted).toEqual({ '765': NOW, '767': NOW });
    // 766's hot alert did not: it is out of alerted, so the next cycle re-emits it.
    // 765's did, and stays marked for this match.
    const s = serverState(state, 's1');
    expect(s.match.alerted).toEqual(['765']);
    expect(s.match.lastSeenAt).toBeNull(); // the rest of the match state rolled back
    expect([...s.postedBeforeFailure].sort()).toEqual(
      ['hotPlayer:s1:765', 'playerJoined:s1:765', 'playerJoined:s1:767'].sort()
    );
  });

  test('an undelivered known join leaves joinAlerted unstamped', async () => {
    const state = warmState();
    await runCycle(
      deps({
        state,
        sources: { kills: async () => [], audit: async () => [], known: async () => [], presence: async () => [joined('765')] },
        poster: {
          post: async () => {
            throw new Error('discord 500');
          }
        }
      })
    );
    expect(state.joinAlerted).toEqual({});
  });

  test('the retry re-emits an undelivered hot player and skips a delivered one', async () => {
    const state = warmState();
    const posted: DiscordMessage[] = [];
    let calls = 0;
    const poster = {
      post: async (m: DiscordMessage) => {
        if (++calls === 2) throw new Error('discord 500');
        posted.push(m);
      }
    };
    // A stand-in for presence: reports whoever is hot and not yet alerted this match.
    const presence: CycleDeps['sources']['presence'] = async (_id, s) => {
      const fresh = ['765', '766'].filter((id) => !s.match.alerted.includes(id));
      s.match.alerted.push(...fresh);
      return fresh.map(hot);
    };
    const sources = { kills: async () => [], audit: async () => [], known: async () => [], presence };
    await runCycle(deps({ state, sources, poster }));
    expect(posted).toHaveLength(1);
    await runCycle(deps({ state, sources, poster }));
    expect(posted.map((m) => m.embeds[0]!.title)).toEqual([
      expect.stringContaining('Alpha'),
      expect.stringContaining('Bravo')
    ]);
    await runCycle(deps({ state, sources, poster }));
    expect(posted).toHaveLength(2); // once per match, retry or not
  });

  test('a refreshed known list survives a rollback: it is a cache, not a cursor', async () => {
    const state = warmState();
    serverState(state, 's1').knownSweats = ['old'];
    const known: CycleDeps['sources']['known'] = async (_id, s) => {
      s.knownSweats = ['new'];
      s.knownHighKd = ['kd'];
      s.knownAt = NOW;
      return [];
    };
    await runCycle(
      deps({
        state,
        runKd: true,
        sources: { kills: async () => [], audit: async () => [adminEvent(1)], known, presence: async () => [] },
        poster: {
          post: async () => {
            throw new Error('discord 500');
          }
        }
      })
    );
    const s = serverState(state, 's1');
    expect(s.lastAuditId).toBe(0);
    expect([s.knownSweats, s.knownHighKd, s.knownAt]).toEqual([['new'], ['kd'], NOW]);
  });

  test('joinAlerted is pruned past JOIN_ALERT_HOURS before saving', async () => {
    const state = warmState();
    state.joinAlerted = { expired: NOW - 24 * HOUR, fresh: NOW - 24 * HOUR + 1 };
    await runCycle(deps({ state }));
    expect(state.joinAlerted).toEqual({ fresh: NOW - 24 * HOUR + 1 });
  });

  test('a failing known source does not stop presence', async () => {
    const presence = vi.fn(async () => []);
    await runCycle(
      deps({
        state: warmState(),
        runKd: true,
        sources: {
          kills: async () => [],
          audit: async () => [],
          known: async () => {
            throw new Error('board down');
          },
          presence
        }
      })
    );
    expect(presence).toHaveBeenCalledOnce();
  });
});
