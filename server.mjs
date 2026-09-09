#!/usr/bin/env node
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.MINIDASH_CONFIG || path.join(HERE, 'config.local.json');

function fail(message) {
  console.error(`minidash: ${message}`);
  process.exit(1);
}

function readJson(filename) {
  try {
    return JSON.parse(readFileSync(filename, 'utf8'));
  } catch (error) {
    fail(`cannot read ${filename}: ${error.message}`);
  }
}

if (!existsSync(CONFIG_PATH)) {
  fail(`configuration not found: ${CONFIG_PATH}\nCopy config.example.json to a private local config and edit it for this installation.`);
}

const config = readJson(CONFIG_PATH);
const humidity = config.humidity ?? {};
if (typeof humidity.base_url !== 'string' || !humidity.base_url) {
  fail('humidity.base_url must be set in the local configuration');
}

const serverConfig = config.server ?? {};
const HOST = process.env.MINIDASH_HOST || serverConfig.host || '0.0.0.0';
const PORT = Number(process.env.MINIDASH_PORT || serverConfig.port || 8788);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail(`invalid server port: ${PORT}`);

const display = {
  title: config.display?.title || 'Climate',
  refresh_seconds: clampNumber(config.display?.refresh_seconds, 5, 300, 20),
  stale_after_minutes: clampNumber(config.display?.stale_after_minutes, 1, 1440, 12),
  show_absolute_humidity: config.display?.show_absolute_humidity !== false,
  show_wall_details: config.display?.show_wall_details !== false,
  show_status_strip: config.display?.show_status_strip !== false,
};

const sensorConfig = Array.isArray(config.sensors) ? config.sensors : [];
const wallConfig = {
  enabled: config.wall?.enabled !== false,
  label: config.wall?.label || 'Wall margin',
  caution_below_c: finiteOr(config.wall?.caution_below_c, 3),
  warning_below_c: finiteOr(config.wall?.warning_below_c, 1),
};
const statusConfig = {
  door_label: config.status?.door_label || 'Door',
  dehumidifier_label: config.status?.dehumidifier_label || 'Dehumidifier',
};

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function num(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function boolFromRows(rows, key) {
  for (const row of rows) {
    const value = num(row?.[key]);
    if (value !== null) return value >= 0.5;
  }
  return null;
}

function humidityUrl() {
  const url = new URL('/api/data', humidity.base_url);
  url.searchParams.set('hours', String(clampNumber(humidity.hours, 1, 24, 1)));
  return url;
}

function latestWall(rows) {
  if (!Array.isArray(rows)) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if ([row?.dew_margin_c, row?.probe_temperature_c, row?.dew_point_c].some(v => num(v) !== null)) return row;
  }
  return null;
}

function normaliseState(source) {
  const latest = Array.isArray(source.latest) ? source.latest : [];
  const byName = new Map(latest.map(row => [String(row.sensor), row]));

  const configuredSensors = sensorConfig.length
    ? sensorConfig
    : latest.map(row => ({ source: String(row.sensor), label: String(row.sensor) }));

  const sensors = configuredSensors.map(entry => {
    const sourceName = String(entry.source ?? '');
    const row = byName.get(sourceName);
    return {
      label: String(entry.label || sourceName || 'Sensor'),
      available: Boolean(row),
      temperature_c: num(row?.temperature_c),
      rh_pct: num(row?.rh_pct),
      ah_g_m3: num(row?.ah_g_m3),
      sampled_ts_ms: num(row?.sampled_ts_ms),
    };
  });

  const wallRow = wallConfig.enabled ? latestWall(source.wall) : null;
  const wall = wallConfig.enabled ? {
    label: wallConfig.label,
    available: Boolean(wallRow),
    dew_margin_c: num(wallRow?.dew_margin_c),
    probe_temperature_c: num(wallRow?.probe_temperature_c),
    dew_point_c: num(wallRow?.dew_point_c),
    sampled_ts_ms: num(wallRow?.ts),
    caution_below_c: wallConfig.caution_below_c,
    warning_below_c: wallConfig.warning_below_c,
  } : null;

  const timestamps = sensors.map(s => s.sampled_ts_ms).filter(Number.isFinite);
  if (Number.isFinite(wall?.sampled_ts_ms)) timestamps.push(wall.sampled_ts_ms);
  const latestTs = timestamps.length ? Math.max(...timestamps) : null;
  const now = Date.now();
  const ageMs = latestTs === null ? null : Math.max(0, now - latestTs);

  return {
    ok: true,
    now,
    display,
    sensors,
    wall,
    status: {
      door: { label: statusConfig.door_label, active: boolFromRows(latest, 'balcony_door_open') },
      dehumidifier: { label: statusConfig.dehumidifier_label, active: boolFromRows(latest, 'tefnut_dehumidifying') },
    },
    freshness: {
      sampled_ts_ms: latestTs,
      age_ms: ageMs,
      stale: ageMs === null || ageMs > display.stale_after_minutes * 60_000,
    },
  };
}

async function getState() {
  const timeoutMs = clampNumber(humidity.timeout_ms, 500, 30_000, 5000);
  const response = await fetch(humidityUrl(), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`humidity source returned HTTP ${response.status}`);
  return normaliseState(await response.json());
}

const staticFiles = new Map([
  ['/', ['public/index.html', 'text/html; charset=utf-8']],
  ['/manifest.webmanifest', ['public/manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
]);

function send(res, status, body, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}
function sendJson(res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method !== 'GET') {
      return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    }

    if (url.pathname === '/api/state') {
      try {
        return sendJson(res, 200, await getState());
      } catch (error) {
        return sendJson(res, 502, { ok: false, now: Date.now(), error: 'humidity source unavailable' });
      }
    }

    if (url.pathname === '/status') {
      return sendJson(res, 200, { ok: true, service: 'minidash', now: Date.now() });
    }

    const item = staticFiles.get(url.pathname);
    if (!item) return sendJson(res, 404, { ok: false, error: 'not found' });
    const [filename, type] = item;
    const body = readFileSync(path.join(HERE, filename));
    return send(res, 200, body, type);
  } catch (error) {
    return sendJson(res, 500, { ok: false, error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MiniDash listening on http://${HOST}:${PORT}/`);
  console.log(`Humidity source: ${humidityUrl().origin}`);
});
