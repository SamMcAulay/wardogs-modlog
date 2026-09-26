import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { PING_KINDS } from '../src/escalate.js';
import { retryKey, runCycle, type CycleDeps } from '../src/runner.js';
import { emptyState, loadState, saveState, serverState, type State } from '../src/state.js';
import type { DiscordMessage } from '../src/discord.js';
import type { ModEvent } from '../src/events.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');

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
    escalateConfig: { kdCooldownDays: 7, pingOn: new Set(PING_KINDS) },
    links: { panelPublicUrl: 'https://panel.example.com', serverLabels: {} },
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

const highKd = (steamId: string): ModEvent => ({
  kind: 'highKd',
  serverId: 's1',
  at: '2026-09-24T12:00:00.000Z',
  steamId,
  name: steamId === '765' ? 'Alpha' : 'Bravo',
  kd: 5.2,
  kills: 52,
  deaths: 10,
  matches: 9,
  minutes: 400
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
    const state = emptyState(); // no server has completed a clean cycle yet
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
          watchlist: async () => [],
          kd: async () => []
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
    const state = warmState();
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
        sources: { kills: async () => [], audit, watchlist: async () => [], kd: async () => [] },
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
        sources: { kills: async () => [], audit, watchlist: async () => [], kd: async () => [] },
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

    const watchedJoinEvent: ModEvent = {
      kind: 'watchedJoin',
      serverId: 's1',
      at: '2026-09-24T12:00:00.000Z',
      steamId: '765',
      name: 'Ghost'
    };
    const highKdEvent: ModEvent = {
      kind: 'highKd',
      serverId: 's1',
      at: '2026-09-24T12:00:00.000Z',
      steamId: '999',
      name: 'Alpha',
      kd: 5.2,
      kills: 52,
      deaths: 10,
      matches: 9,
      minutes: 400
    };

    let callCount = 0;
    const post = vi.fn(async (m: DiscordMessage) => {
      callCount++;
      if (callCount === 2) throw new Error('discord 500'); // the K/D post fails
      posted.push(m);
    });

    // Cycle 1: the watched join posts; the K/D alert (which runs after watchlist)
    // fails to post, rolling the server entry back — including presentSteamIds, so
    // the same arrival would look "new" again on a re-read.
    await runCycle(
      deps({
        state,
        runKd: true,
        sources: {
          kills: async () => [],
          audit: async () => [],
          watchlist: async () => [watchedJoinEvent],
          kd: async () => [highKdEvent]
        },
        poster: { post }
      })
    );
    expect(posted).toHaveLength(1); // only the watched join delivered
    expect(serverState(state, 's1').postedBeforeFailure).toEqual(['watchedJoin:s1:765']);

    // Cycle 2 (the immediate retry): the same arrival is re-read, but its retry key is
    // already recorded — must not post a second time. Nothing else fails this cycle.
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => [],
          audit: async () => [],
          watchlist: async () => [watchedJoinEvent],
          kd: async () => []
        },
        poster: { post }
      })
    );
    expect(posted).toHaveLength(1); // still just the one delivery
    expect(serverState(state, 's1').postedBeforeFailure).toEqual([]); // clean cycle clears it

    // Cycle 3: a genuine later rejoin (same steamId) — one-cycle scope means it must
    // still alert, not be silently swallowed forever.
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => [],
          audit: async () => [],
          watchlist: async () => [watchedJoinEvent],
          kd: async () => []
        },
        poster: { post }
      })
    );
    expect(posted).toHaveLength(2); // the later rejoin posts
  });

  test('an undelivered K/D alert waits for the next K/D run, then sets its cooldown', async () => {
    const state = warmState();
    const kd = vi.fn(async () => [highKd('765')]);
    const sources = { kills: async () => [], audit: async () => [], watchlist: async () => [], kd };

    // Cycle 1: the only decision this cycle is the K/D alert, and its post fails — the
    // cooldown must roll back with it, leaving the player unreported.
    await runCycle(
      deps({
        state,
        runKd: true,
        sources,
        poster: {
          post: async () => {
            throw new Error('discord 500');
          }
        }
      })
    );
    expect(state.kdAlerted['765']).toBeUndefined();

    // Cycle 2: an ordinary 30-second cycle, the K/D board not due. Nothing is forced:
    // the alert is not urgent and waits (controller ruling I3).
    const posted: DiscordMessage[] = [];
    const poster = { post: async (m: DiscordMessage) => void posted.push(m) };
    await runCycle(deps({ state, now: NOW + 30_000, runKd: false, sources, poster }));
    expect(posted).toHaveLength(0);
    expect(state.kdAlerted['765']).toBeUndefined();

    // Cycle 3: the next hourly K/D run re-flags the player, and this time it posts.
    await runCycle(deps({ state, now: NOW + 3_600_000, runKd: true, sources, poster }));
    expect(posted).toHaveLength(1);
    expect(state.kdAlerted['765']).toBe(NOW + 3_600_000);
  });

  test('a K/D alert that posted keeps its cooldown when a later post in the cycle fails', async () => {
    const state = warmState();
    const kd = async () => [highKd('765'), highKd('766')];
    const sources = { kills: async () => [], audit: async () => [], watchlist: async () => [], kd };

    const posted: DiscordMessage[] = [];
    let calls = 0;
    await runCycle(
      deps({
        state,
        runKd: true,
        sources,
        poster: {
          post: async (m) => {
            if (++calls === 2) throw new Error('discord 500'); // 766's alert fails
            posted.push(m);
          }
        }
      })
    );
    expect(posted).toHaveLength(1); // 765 was told
    expect(state.kdAlerted['765']).toBe(NOW); // ...so its cooldown stands
    expect(state.kdAlerted['766']).toBeUndefined(); // ...and 766's does not

    // The next K/D run, clean: 765 is still cooling down, only 766 posts.
    posted.length = 0;
    await runCycle(
      deps({
        state,
        now: NOW + 3_600_000,
        runKd: true,
        sources,
        poster: { post: async (m) => void posted.push(m) }
      })
    );
    expect(posted).toHaveLength(1);
    expect(posted[0]!.embeds[0]!.title).toContain('Bravo');
  });

  test('prunes K/D cooldowns that have expired before saving', async () => {
    const state = warmState();
    const day = 86_400_000;
    state.kdAlerted = { expired: NOW - 7 * day, fresh: NOW - 6 * day };
    await runCycle(deps({ state }));
    expect(state.kdAlerted).toEqual({ fresh: NOW - 6 * day });
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
      watchlist: async () => [],
      kd: async () => []
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
        sources: { kills: async () => [], audit, watchlist: async () => [], kd: async () => [] },
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
        sources: { kills: async () => [], audit, watchlist: async () => [], kd: async () => [] },
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
          watchlist: async () => [],
          kd: async () => []
        },
        save
      })
    );
    expect(serverState(state, 's1').warm).toBe(false); // still cold — needs one fully clean cycle
    expect(save).toHaveBeenCalledOnce(); // whatever position we did learn is still saved
  });

  test('a clean cold cycle warms the server', async () => {
    const state = emptyState();
    await runCycle(
      deps({
        state,
        sources: {
          kills: async () => [],
          audit: async () => [],
          watchlist: async () => [],
          kd: async () => []
        }
      })
    );
    expect(serverState(state, 's1').warm).toBe(true);
  });

  test('a failing K/D board does not keep a server cold: it has no cursor', async () => {
    const state = emptyState();
    await runCycle(
      deps({
        state,
        runKd: true,
        sources: {
          kills: async () => [],
          audit: async () => [],
          watchlist: async () => [],
          kd: async () => {
            throw new Error('leaderboard down');
          }
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
        sources: { kills: async () => [], audit, watchlist: async () => [], kd: async () => [] },
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
          watchlist: async () => [],
          kd: async () => []
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
          watchlist: async () => [],
          kd: async () => []
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
      watchlist: async () => [],
      kd: async () => []
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
        sources: { kills: async () => [], audit, watchlist: async () => [], kd: async () => [] }
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

  test('retryKey drops the cycle time from a kill-rate event', () => {
    expect(
      retryKey({
        kind: 'killRate',
        serverId: 's1',
        at: '2026-09-24T12:00:00.000Z',
        steamId: '765',
        name: 'Alpha',
        sweat: null,
        surge: null
      })
    ).toBe('killRate:s1:765');
  });
});
