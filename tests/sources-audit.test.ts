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
