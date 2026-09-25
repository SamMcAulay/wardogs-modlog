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
});
