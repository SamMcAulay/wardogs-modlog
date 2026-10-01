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
    // The bot counts from the kills on the board when it first looks. Alpha arrives with
    // 15 and gains one a minute (60 an hour), so the live alert fires once the bot has
    // watched for LIVE_MIN_MINUTES (live-alerts §3).
    const alphaKills = 15 + Math.floor((Date.now() - startedAt) / 60_000);
    return json(res, {
      ok: true,
      live: {
        serverId,
        ok: true,
        status: { serverName: `Mock ${serverId.slice(0, 8)}`, map: 'Mock Town' },
        players: [
          { steamId: '76561190000000001', name: 'Alpha', faction: 'Valkyra', kills: alphaKills, deaths: 4, cash: 1200, ping: 38 },
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

  // /lookup's board: the org export, as CSV.
  if (p.endsWith('/leaderboard/export')) {
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' });
    return res.end(
      [
        'rank,steam_id,name,playtime_min,seeded_min,kills,deaths,kd,kills_per_hour,headshots,team_kills,suicides,vehicle_kills,kill_streak,death_streak,matches,wins,losses,draws,win_pct,cash,last_seen',
        '1,76561190000000004,Delta,600,0,180,12,15,18,0,0,0,0,0,0,9,0,0,0,,0,',
        '2,76561190000000001,"Alpha, the first",400,40,52,10,5.2,8.7,0,2,0,0,0,0,9,0,0,0,,0,'
      ].join('\r\n')
    );
  }

  // /lookup's dossier. Alpha is online on this server and has a few names; anyone else is a
  // stranger, as Warcon answers for a player it has never seen.
  const dossierMatch = p.match(/\/api\/servers\/([^/]+)\/players\/(\d{17})$/);
  if (dossierMatch) {
    const [, serverId, steamId] = dossierMatch;
    const known = steamId === '76561190000000001';
    const now = new Date().toISOString();
    return json(res, {
      ok: true,
      dossier: {
        steamId,
        name: known ? 'Alpha' : steamId,
        names: known ? ['Alpha', 'xX_Alpha_Xx', 'AlphaTest'] : [],
        online: known ? { serverId, serverName: `Mock ${serverId.slice(0, 8)}` } : null,
        steam: {
          persona: known ? 'Alpha' : 'Stranger',
          profileUrl: `https://steamcommunity.com/profiles/${steamId}`,
          public: true,
          accountAgeDays: 900,
          vacBans: 0,
          gameBans: 0,
          daysSinceLastBan: null,
          communityBanned: false
        },
        risk: known
          ? { score: 35, level: 'medium', reasons: [{ code: 'kd', text: 'K/D well above the server', weight: 20 }] }
          : { score: 0, level: 'low', reasons: [] },
        watch: { watched: false, reason: '', updatedByName: '', updatedAt: null },
        bannedOn: [],
        summary: known
          ? { sessions: 14, minutes: 1500, kills: 260, deaths: 70, firstSeen: '2026-03-01T12:00:00.000Z', lastSeen: now }
          : { sessions: 0, minutes: 0, kills: 0, deaths: 0, firstSeen: null, lastSeen: null },
        combat: known ? { teamKills: 3, teamKilled: 1, headshots: 40 } : null,
        perServer: known ? [{ serverId, serverName: `Mock ${serverId.slice(0, 8)}`, sessions: 14, minutes: 1500, lastSeen: now }] : [],
        notes: []
      }
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
