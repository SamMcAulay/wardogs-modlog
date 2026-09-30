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
    expect(c.kdThreshold).toBe(4.0);
    expect(c.kdMinMatches).toBe(5);
    expect(c.kdMinMinutes).toBe(60);
    expect(c.kdRange).toBe('30d');
    expect(c.feedQuietMinutes).toBe(30);
    expect(c.sweatPerHour).toBe(15);
    expect(c.sweatRange).toBe('30d');
    expect(c.rateMinMinutes).toBe(180);
    expect(c.livePerHour).toBe(20);
    expect(c.liveMinMinutes).toBe(20);
    expect(c.liveMinKills).toBe(8);
    expect(c.joinAlertHours).toBe(24);
    expect(c.statePath).toBe('/data/state.json');
    expect(c.serverIds).toEqual([]);
    expect(c.serverLabels).toEqual({});
    expect([...c.pingOn]).toEqual(['live']);
    expect(c.steamApiKey).toBeNull();
    expect(c.wardogsAppId).toBe(1867240);
  });

  test('a Steam key turns on the lookup\'s Steam playtime', () => {
    const c = loadConfig({ ...base, STEAM_API_KEY: ' key ', WARDOGS_APP_ID: '42' });
    expect([c.steamApiKey, c.wardogsAppId]).toEqual(['key', 42]);
  });

  test('the live thresholds and the join limit can be overridden', () => {
    const c = loadConfig({
      ...base,
      LIVE_PER_HOUR: '25',
      LIVE_MIN_MINUTES: '15',
      LIVE_MIN_KILLS: '10',
      JOIN_ALERT_HOURS: '12'
    });
    expect([c.livePerHour, c.liveMinMinutes, c.liveMinKills, c.joinAlertHours]).toEqual([25, 15, 10, 12]);
  });

  test('the removed settings are no longer on Config, and a leftover value is ignored', () => {
    const c = loadConfig({
      ...base,
      KD_COOLDOWN_DAYS: 'junk',
      SURGE_RANGE: '14d',
      SURGE_PER_HOUR: 'x',
      SURGE_RATIO: '-1',
      SURGE_HISTORY_MINUTES: '0'
    });
    for (const key of ['kdCooldownDays', 'surgeRange', 'surgePerHour', 'surgeRatio', 'surgeHistoryMinutes']) {
      expect(c).not.toHaveProperty(key);
    }
  });

  test('PING_ON=none turns every ping off', () => {
    expect(loadConfig({ ...base, PING_ON: 'none' }).pingOn.size).toBe(0);
  });

  test('PING_ON=live, trimmed, is the default made explicit', () => {
    expect([...loadConfig({ ...base, PING_ON: ' live ' }).pingOn]).toEqual(['live']);
    expect([...loadConfig({ ...base, PING_ON: '  ' }).pingOn]).toEqual(['live']);
  });

  test('PING_ON rejects every kind that no longer pings, saying only the live alert does', () => {
    for (const kind of ['sweat', 'surge', 'teamKill', 'watchedJoin', 'highKd']) {
      expect(() => loadConfig({ ...base, PING_ON: kind })).toThrow(
        new RegExp(`PING_ON entry "${kind}" no longer pings: only the live alert \\(live\\) mentions the mod role`)
      );
    }
  });

  test('PING_ON names an unknown kind in its error', () => {
    expect(() => loadConfig({ ...base, PING_ON: 'live,kicks' })).toThrow(/PING_ON entry "kicks" is not one of live/);
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

  test('parses SERVER_LABELS into a trimmed map, skipping empty entries', () => {
    const c = loadConfig({ ...base, SERVER_LABELS: ' a = EU#1 , b=NA#3 ,, ' });
    expect(c.serverLabels).toEqual({ a: 'EU#1', b: 'NA#3' });
  });

  test('keeps everything after the first = in a label', () => {
    const c = loadConfig({ ...base, SERVER_LABELS: 'a=x=y' });
    expect(c.serverLabels).toEqual({ a: 'x=y' });
  });

  test('rejects a SERVER_LABELS entry with no =', () => {
    expect(() => loadConfig({ ...base, SERVER_LABELS: 'a=EU#1,broken' })).toThrow(
      /SERVER_LABELS entry "broken" is not serverId=Label/
    );
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

  test('rejects a PANEL_PUBLIC_URL that is not an absolute http(s) URL', () => {
    for (const bad of ['panel.example.com', '/relative', 'ftp://panel.example.com', 'javascript:alert(1)']) {
      expect(() => loadConfig({ ...base, PANEL_PUBLIC_URL: bad })).toThrow(/PANEL_PUBLIC_URL/);
    }
    expect(loadConfig({ ...base, PANEL_PUBLIC_URL: 'http://10.0.0.5:3000' }).panelPublicUrl).toBe(
      'http://10.0.0.5:3000'
    );
  });

  test('SWEAT_RANGE accepts the leaderboard ranges', () => {
    expect(loadConfig({ ...base, SWEAT_RANGE: 'all' }).sweatRange).toBe('all');
  });

  test('a sweat range the leaderboard does not accept fails at startup, naming the variable', () => {
    expect(() => loadConfig({ ...base, SWEAT_RANGE: '14d' })).toThrow(
      /SWEAT_RANGE must be one of 7d, 30d, 90d, all/
    );
  });

  test('KD_RANGE is validated like the rate ranges', () => {
    expect(loadConfig({ ...base, KD_RANGE: '90d' }).kdRange).toBe('90d');
    expect(loadConfig(base).kdRange).toBe('30d');
    expect(() => loadConfig({ ...base, KD_RANGE: '14d' })).toThrow(
      /KD_RANGE must be one of 7d, 30d, 90d, all/
    );
  });
});
