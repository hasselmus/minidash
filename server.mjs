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
const environment = config.environment ?? null;
const legacyHumidity = environment ? null : (config.humidity ?? null);
const sourceConfig = environment ?? legacyHumidity ?? {};

if (typeof sourceConfig.base_url !== 'string' || !sourceConfig.base_url) {
  fail('environment.base_url must be set in the local configuration (legacy humidity.base_url is also accepted)');
}

const nativeEnvironment = Boolean(environment);
const serverConfig = config.server ?? {};
const HOST = process.env.MINIDASH_HOST || serverConfig.host || '0.0.0.0';
const PORT = Number(process.env.MINIDASH_PORT || serverConfig.port || 8788);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) fail(`invalid server port: ${PORT}`);

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function boolValue(value) {
  if (value === null || value === undefined) return null;
  return ['true', '1', 'yes', 'on', 'open'].includes(String(value).toLowerCase());
}

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
  source: config.wall?.source || null,
  label: config.wall?.label || 'Wall margin',
  caution_below_c: finiteOr(config.wall?.caution_below_c, 3),
  warning_below_c: finiteOr(config.wall?.warning_below_c, 1),
};
const statusConfig = {
  door: {
    entity: config.status?.door?.entity ?? null,
    field: config.status?.door?.field ?? null,
    label: config.status?.door?.label || config.status?.door_label || 'Door',
  },
  dehumidifier: {
    entity: config.status?.dehumidifier?.entity ?? null,
    field: config.status?.dehumidifier?.field ?? null,
    label: config.status?.dehumidifier?.label || config.status?.dehumidifier_label || 'Dehumidifier',
  },
};

const plots = {
  enabled: config.plots?.enabled !== false && Array.isArray(config.plots?.pages) && config.plots.pages.length > 0,
  hours: clampNumber(config.plots?.hours, 1, 24 * 30, 24),
  refresh_seconds: clampNumber(config.plots?.refresh_seconds, 30, 3600, 300),
  pages: Array.isArray(config.plots?.pages) ? config.plots.pages.map(page => ({
    title: String(page.title || page.metric || 'Plot'),
    metric: String(page.metric || ''),
    unit: String(page.unit || ''),
    sensors: Array.isArray(page.sensors) ? page.sensors.map(String) : [],
    zero_baseline: page.zero_baseline === true,
  })).filter(page => page.metric) : [],
};

function sourceUrl(pathname, params = {}) {
  const url = new URL(pathname, sourceConfig.base_url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

async function fetchJson(url) {
  const timeoutMs = clampNumber(sourceConfig.timeout_ms, 500, 30_000, 5000);
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`environment source returned HTTP ${response.status}`);
  return response.json();
}

function configuredSensorsFromNative(source) {
  const latest = Array.isArray(source.sensors) ? source.sensors : [];
  const byName = new Map(latest.map(row => [String(row.sensor), row]));
  const configured = sensorConfig.length
    ? sensorConfig
    : latest.map(row => ({ source: String(row.sensor), label: String(row.sensor) }));

  return configured.map(entry => {
    const sourceName = String(entry.source ?? '');
    const row = byName.get(sourceName);
    return {
      source: sourceName,
      label: String(entry.label || sourceName || 'Sensor'),
      available: Boolean(row),
      temperature_c: num(row?.temperature),
      rh_pct: num(row?.relative_humidity),
      ah_g_m3: num(row?.absolute_humidity),
      co2_ppm: num(row?.co2),
      pm25_ugm3: num(row?.pm2_5),
      air_quality: num(row?.air_quality),
      sampled_ts_ms: num(row?.sampled_ts_ms),
    };
  });
}

function stateMap(rows) {
  const map = new Map();
  for (const row of rows ?? []) map.set(`${row.entity}/${row.field}`, row);
  return map;
}

function stateFromRef(map, ref) {
  if (!ref?.entity || !ref?.field) return null;
  const row = map.get(`${ref.entity}/${ref.field}`);
  return row ? boolValue(row.value) : null;
}

function wallFromNative(source) {
  if (!wallConfig.enabled || !wallConfig.source) return null;
  const row = (source.sensors ?? []).find(item => String(item.sensor) === wallConfig.source);
  if (!row) return {
    label: wallConfig.label,
    available: false,
    dew_margin_c: null,
    probe_temperature_c: null,
    dew_point_c: null,
    sampled_ts_ms: null,
    caution_below_c: wallConfig.caution_below_c,
    warning_below_c: wallConfig.warning_below_c,
  };
  return {
    label: wallConfig.label,
    available: true,
    dew_margin_c: num(row.dew_margin),
    probe_temperature_c: num(row.probe_temperature),
    dew_point_c: num(row.dew_point),
    sampled_ts_ms: num(row.sampled_ts_ms),
    caution_below_c: wallConfig.caution_below_c,
    warning_below_c: wallConfig.warning_below_c,
  };
}

function normaliseNative(source) {
  const sensors = configuredSensorsFromNative(source);
  const wall = wallFromNative(source);
  const states = stateMap(source.states);
  const timestamps = sensors.map(s => s.sampled_ts_ms).filter(Number.isFinite);
  if (Number.isFinite(wall?.sampled_ts_ms)) timestamps.push(wall.sampled_ts_ms);
  const latestTs = timestamps.length ? Math.max(...timestamps) : null;
  const ageMs = latestTs === null ? null : Math.max(0, Date.now() - latestTs);

  return {
    ok: true,
    now: Date.now(),
    display,
    plots,
    sensors,
    wall,
    status: {
      door: { label: statusConfig.door.label, active: stateFromRef(states, statusConfig.door) },
      dehumidifier: { label: statusConfig.dehumidifier.label, active: stateFromRef(states, statusConfig.dehumidifier) },
    },
    freshness: {
      sampled_ts_ms: latestTs,
      age_ms: ageMs,
      stale: ageMs === null || ageMs > display.stale_after_minutes * 60_000,
    },
  };
}

function latestWall(rows) {
  if (!Array.isArray(rows)) return null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if ([row?.dew_margin_c, row?.probe_temperature_c, row?.dew_point_c].some(v => num(v) !== null)) return row;
  }
  return null;
}

function boolFromRows(rows, key) {
  for (const row of rows) {
    const value = num(row?.[key]);
    if (value !== null) return value >= 0.5;
  }
  return null;
}

function normaliseLegacy(source) {
  const latest = Array.isArray(source.latest) ? source.latest : [];
  const byName = new Map(latest.map(row => [String(row.sensor), row]));
  const configured = sensorConfig.length
    ? sensorConfig
    : latest.map(row => ({ source: String(row.sensor), label: String(row.sensor) }));

  const sensors = configured.map(entry => {
    const sourceName = String(entry.source ?? '');
    const row = byName.get(sourceName);
    return {
      source: sourceName,
      label: String(entry.label || sourceName || 'Sensor'),
      available: Boolean(row),
      temperature_c: num(row?.temperature_c),
      rh_pct: num(row?.rh_pct),
      ah_g_m3: num(row?.ah_g_m3),
      co2_ppm: null,
      pm25_ugm3: null,
      air_quality: null,
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
  const ageMs = latestTs === null ? null : Math.max(0, Date.now() - latestTs);

  return {
    ok: true,
    now: Date.now(),
    display,
    plots: { ...plots, enabled: false, pages: [] },
    sensors,
    wall,
    status: {
      door: { label: statusConfig.door.label, active: boolFromRows(latest, 'balcony_door_open') },
      dehumidifier: { label: statusConfig.dehumidifier.label, active: boolFromRows(latest, 'tefnut_dehumidifying') },
    },
    freshness: {
      sampled_ts_ms: latestTs,
      age_ms: ageMs,
      stale: ageMs === null || ageMs > display.stale_after_minutes * 60_000,
    },
  };
}

async function getState() {
  if (nativeEnvironment) {
    return normaliseNative(await fetchJson(sourceUrl('/api/v1/latest')));
  }
  const hours = clampNumber(sourceConfig.hours, 1, 24, 1);
  return normaliseLegacy(await fetchJson(sourceUrl('/api/data', { hours })));
}

async function getSeries(hours) {
  if (!nativeEnvironment) return { ok: true, hours, rows: [] };
  const source = await fetchJson(sourceUrl('/api/v1/series', { hours }));
  return {
    ok: true,
    now: Date.now(),
    hours: Number(source.hours ?? hours),
    bucket_ms: num(source.bucket_ms),
    rows: Array.isArray(source.rows) ? source.rows : [],
  };
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
      } catch {
        return sendJson(res, 502, { ok: false, now: Date.now(), error: 'environment source unavailable' });
      }
    }

    if (url.pathname === '/api/series') {
      try {
        const hours = clampNumber(url.searchParams.get('hours'), 1, 24 * 30, plots.hours);
        return sendJson(res, 200, await getSeries(hours));
      } catch {
        return sendJson(res, 502, { ok: false, now: Date.now(), error: 'environment series unavailable' });
      }
    }

    if (url.pathname === '/status') {
      return sendJson(res, 200, {
        ok: true,
        service: 'minidash',
        source: nativeEnvironment ? 'environment-logger' : 'legacy-humidity-logger',
        now: Date.now()
      });
    }

    const item = staticFiles.get(url.pathname);
    if (!item) return sendJson(res, 404, { ok: false, error: 'not found' });
    const [filename, type] = item;
    const body = readFileSync(path.join(HERE, filename));
    return send(res, 200, body, type);
  } catch {
    return sendJson(res, 500, { ok: false, error: 'internal error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`MiniDash listening on http://${HOST}:${PORT}/`);
  console.log(`Environment source: ${sourceConfig.base_url} (${nativeEnvironment ? 'native API' : 'legacy compatibility API'})`);
});
