// Serves the endpoints the modlog bot reads, so it can be exercised without
// panel access. Mirrors WDstats' scripts/mock-warcon.mjs in spirit.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8788);

let auditId = 0;
let killSeq = 0;
const startedAt = Date.now();

const json = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// Serves any server id it is asked for, so SERVER_IDS can list every real
// server against the mock (Amendment A).
const serverIdFromPath = (pathname) => {
  const match = pathname.match(/\/api\/servers\/([^/]+)\//);
  return match ? match[1] : 's1';
};

createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (p === '/api/audit') {
    const serverId = url.searchParams.get('server') ?? 's1';
    auditId++;
    return json(res, {
      ok: true,
      entries: [
        {
          id: auditId,
          createdAt: new Date().toISOString(),
          serverId,
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
    const serverId = serverIdFromPath(p);
    // A match already 30 minutes in when the mock starts, running on from there. The
    // bot first sees everyone at clock 0 of its first observation, so Alpha's 15 kills
    // are 30 an hour over 30 minutes: hot enough for the live alert (live-alerts §3).
    const matchSeconds = 1800 + Math.floor((Date.now() - startedAt) / 1000);
    return json(res, {
      ok: true,
      live: {
        serverId,
        ok: true,
        status: { serverName: `Mock ${serverId.slice(0, 8)}`, matchSeconds },
        players: [
          { steamId: '76561190000000001', name: 'Alpha', faction: 'Valkyra', kills: 15, deaths: 4, cash: 1200, ping: 38 },
          { steamId: '76561190000000003', name: 'Charlie', faction: 'Lonestar', kills: 2, deaths: 6, cash: 300, ping: 52 },
          { steamId: '76561190000000004', name: 'Delta', faction: 'Lonestar', kills: 5, deaths: 3, cash: 800, ping: 45 }
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
      // Warcon echoes the query it ran; preflight checks the sort survived.
      query: { sort: url.searchParams.get('sort') ?? 'kd' },
      // Alpha's K/D (5.2) makes him a known high K/D; Delta (18/hour, K/D 15) is both.
      rows: [
        { steamId: '76561190000000001', name: 'Alpha', minutes: 400, kills: 52, deaths: 10, matches: 9 },
        { steamId: '76561190000000002', name: 'Bravo', minutes: 300, kills: 20, deaths: 20, matches: 8 },
        { steamId: '76561190000000004', name: 'Delta', minutes: 600, kills: 180, deaths: 12, matches: 9 }
      ]
    });
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: { message: 'no such endpoint' } }));
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock warcon on http://127.0.0.1:${PORT} (serves any server id)`);
});
