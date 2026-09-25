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

describe('runCycle', () => {
  test('posts an event and saves state', async () => {
    const posted: DiscordMessage[] = [];
    const state = emptyState();
    state.cold = false; // this test exercises the normal (non-cold-start) path
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

  test('a retry skips an event that already posted before a failure, then clears once a cycle completes cleanly', async () => {
    const posted: DiscordMessage[] = [];
    const state = emptyState();
    state.cold = false;

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
    const state = emptyState();
    state.cold = false;

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

  test('the K/D cooldown is set correctly once a retried cycle succeeds', async () => {
    const state = emptyState();
    state.cold = false;
    const highKdEvent: ModEvent = {
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
    };

    // Cycle 1: the only decision this cycle is the K/D alert, and its post fails — the
    // cooldown must roll back with it (covered elsewhere), leaving the player unreported.
    await runCycle(
      deps({
        state,
        runKd: true,
        sources: {
          kills: async () => [],
          audit: async () => [],
          watchlist: async () => [],
          kd: async () => [highKdEvent]
        },
        poster: {
          post: async () => {
            throw new Error('discord 500');
          }
        }
      })
    );
    expect(state.kdAlerted['765']).toBeUndefined();

    // Cycle 2 (the retry): the board still shows the same player over threshold — this
    // time the post succeeds, and the cooldown must be set for real.
    await runCycle(
      deps({
        state,
        now: NOW + 60_000,
        runKd: true,
        sources: {
          kills: async () => [],
          audit: async () => [],
          watchlist: async () => [],
          kd: async () => [highKdEvent]
        },
        poster: { post: async () => {} }
      })
    );
    expect(state.kdAlerted['765']).toBe(NOW + 60_000);
  });

  test('a cold cycle in which a source failed leaves cold true, so the backlog is not later reported as new', async () => {
    const state = emptyState(); // cold === true
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
    expect(state.cold).toBe(true); // still cold — needs one fully clean cycle
    expect(save).toHaveBeenCalledOnce(); // whatever position we did learn is still saved
  });

  test('a clean cold cycle clears cold', async () => {
    const state = emptyState(); // cold === true
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
    expect(state.cold).toBe(false);
  });
});
