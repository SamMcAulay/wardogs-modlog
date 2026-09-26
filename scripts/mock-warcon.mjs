// Serves the four endpoints the modlog bot reads, so it can be exercised without
// panel access. Mirrors WDstats' scripts/mock-warcon.mjs in spirit.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 8788);

let auditId = 0;
let killSeq = 0;

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
    return json(res, {
      ok: true,
      live: {
        serverId,
        ok: true,
        status: { serverName: `Mock ${serverId.slice(0, 8)}` },
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

  const dossier = /\/players\/(\d+)$/.exec(p);
  if (dossier) {
    const serverId = p.split('/')[3];
    return json(res, {
      ok: true,
      // Delta's usual is 8/hour over 100 hours, so the mock's 18/hour is also a surge.
      dossier: {
        perServer: [{ serverId, minutes: 6000, kills: dossier[1].endsWith('4') ? 800 : 100, deaths: 50 }]
      }
    });
  }

  if (p.endsWith('/leaderboard')) {
    return json(res, {
      ok: true,
      // Warcon echoes the query it ran; preflight checks the sort survived.
      query: { sort: url.searchParams.get('sort') ?? 'kd' },
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
