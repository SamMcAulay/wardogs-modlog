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
    expect(c.teamKillPingAt).toBe(3);
    expect(c.kdThreshold).toBe(4.0);
    expect(c.kdMinMatches).toBe(5);
    expect(c.kdMinMinutes).toBe(60);
    expect(c.kdRange).toBe('30d');
    expect(c.kdCooldownDays).toBe(7);
    expect(c.feedQuietMinutes).toBe(30);
    expect(c.statePath).toBe('/data/state.json');
    expect(c.serverIds).toEqual([]);
    expect(c.serverLabels).toEqual({});
    expect([...c.pingOn].sort()).toEqual(['highKd', 'teamKill', 'watchedJoin']);
  });

  test('PING_ON=none turns every ping off', () => {
    expect(loadConfig({ ...base, PING_ON: 'none' }).pingOn.size).toBe(0);
  });

  test('PING_ON lists the kinds that ping, trimmed', () => {
    const c = loadConfig({ ...base, PING_ON: ' watchedJoin , highKd ' });
    expect([...c.pingOn].sort()).toEqual(['highKd', 'watchedJoin']);
  });

  test('PING_ON names an unknown kind in its error', () => {
    expect(() => loadConfig({ ...base, PING_ON: 'teamKill,kicks' })).toThrow(/PING_ON.*"kicks"/);
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
});
