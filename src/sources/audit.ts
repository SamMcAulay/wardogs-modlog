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
