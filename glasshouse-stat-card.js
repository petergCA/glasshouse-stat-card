/*
 * Glasshouse Stat Card
 * Data-rich metric tiles with live sparklines for Home Assistant.
 * Part of the Glasshouse card suite. MIT licence.
 */
(() => {
  const VERSION = '1.3.1';
  const TAG = 'glasshouse-stat-card';

  const TOKENS = [
    'ok', 'warn', 'alert', 'info', 'light', 'fan', 'cover', 'switch', 'heat', 'cool',
    'media', 'lock', 'security', 'energy', 'water', 'neutral',
  ];
  const GRAPHS = ['line', 'bar', 'none'];
  const TRENDS = ['normal', 'inverse', 'neutral', 'none'];
  const ACTIONS = ['more-info', 'navigate', 'none'];
  const LINE_POINTS = 120;
  const REFRESH_MS = 5 * 60 * 1000;
  const TICK_MS = 60 * 1000;
  const HOLD_MS = 500;
  const BAD_STATES = ['unavailable', 'unknown'];
  const ACTIVE_STATES = [
    'on', 'open', 'opening', 'closing', 'home', 'playing', 'detected', 'unlocked', 'unlocking',
    'heat', 'cool', 'heat_cool', 'heating', 'cooling', 'active', 'charging', 'running', 'printing',
    'armed_away', 'armed_home', 'armed_night', 'armed_vacation', 'triggered', 'problem', 'wet',
    'cleaning', 'washing', 'drying', 'jammed', 'pending', 'arming',
    'connected', 'online', // enum sensors for network devices (e.g. a UniFi gateway's state)
  ];
  const BINARY_LABELS = {
    door: ['Closed', 'Open'], window: ['Closed', 'Open'], opening: ['Closed', 'Open'],
    garage_door: ['Closed', 'Open'], motion: ['Clear', 'Detected'], occupancy: ['Clear', 'Detected'],
    presence: ['Away', 'Home'], moisture: ['Dry', 'Wet'], lock: ['Locked', 'Unlocked'],
    problem: ['OK', 'Problem'], safety: ['Safe', 'Unsafe'], smoke: ['Clear', 'Detected'],
    gas: ['Clear', 'Detected'], connectivity: ['Disconnected', 'Connected'],
    plug: ['Unplugged', 'Plugged in'], battery: ['Normal', 'Low'], running: ['Not running', 'Running'],
    vibration: ['Clear', 'Detected'], sound: ['Clear', 'Detected'], tamper: ['Clear', 'Tampering'],
  };

  // ---------- small helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
  const SAFE_COLOR = /^[#a-zA-Z0-9(),.%\s-]+$/;
  const resolveColor = (c, fallback) => {
    if (c == null || c === '') return fallback;
    const v = String(c).trim();
    if (TOKENS.includes(v)) return `var(--gh-${v})`;
    return SAFE_COLOR.test(v) ? v : fallback;
  };
  const num = (s) => {
    if (s == null || s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const windowLabel = (h) => (h > 48 && h % 24 === 0 ? `${h / 24}d` : `${+h.toFixed(2)}h`);
  const durationLabel = (ms) => {
    const m = Math.max(0, Math.floor(ms / 60000));
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  };
  const normAction = (a, path, def) => {
    if (a == null) return { action: def };
    if (typeof a === 'string') return { action: a, navigation_path: path };
    return { navigation_path: path, ...a, action: a.action ?? def };
  };

  /** Time-weighted means of step-held samples over n equal buckets in [start, end). */
  function bucketize(samples, start, end, n) {
    const out = new Array(n).fill(null);
    const w = (end - start) / n;
    const len = samples.length;
    let i = 0;
    let cur;
    while (i < len && samples[i].t <= start) { cur = samples[i].v; i++; }
    let t = start;
    for (let b = 0; b < n; b++) {
      const b1 = b === n - 1 ? end : start + (b + 1) * w;
      let sum = 0;
      let cov = 0;
      while (i < len && samples[i].t < b1) {
        const ts = Math.max(samples[i].t, t);
        if (cur != null && ts > t) { sum += cur * (ts - t); cov += ts - t; }
        t = ts;
        cur = samples[i].v;
        i++;
      }
      if (cur != null && b1 > t) { sum += cur * (b1 - t); cov += b1 - t; }
      t = b1;
      out[b] = cov > 0 ? sum / cov : null;
    }
    return out;
  }

  /** Monotone cubic (Fritsch-Carlson / d3 monotoneX) path through points. */
  function monoPath(p) {
    const n = p.length;
    if (n < 2) return '';
    const f = (v) => +v.toFixed(2);
    if (n === 2) return `M${f(p[0][0])},${f(p[0][1])}L${f(p[1][0])},${f(p[1][1])}`;
    const dx = [];
    const m = [];
    for (let i = 0; i < n - 1; i++) {
      dx[i] = p[i + 1][0] - p[i][0];
      m[i] = dx[i] ? (p[i + 1][1] - p[i][1]) / dx[i] : 0;
    }
    const t = [m[0]];
    for (let i = 1; i < n - 1; i++) {
      if (m[i - 1] * m[i] <= 0) t[i] = 0;
      else {
        t[i] = (3 * (dx[i - 1] + dx[i]))
          / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]);
      }
    }
    t[n - 1] = m[n - 2];
    let d = `M${f(p[0][0])},${f(p[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
      const h = dx[i] / 3;
      d += `C${f(p[i][0] + h)},${f(p[i][1] + t[i] * h)},${f(p[i + 1][0] - h)},${f(p[i + 1][1] - t[i + 1] * h)},${f(p[i + 1][0])},${f(p[i + 1][1])}`;
    }
    return d;
  }

  const CSS = `
:host {
  --gh-font: var(--glasshouse-font, -apple-system, "SF Pro Text", Inter, Roboto, system-ui, sans-serif);
  --gh-surface: var(--glasshouse-surface, rgba(255,255,255,0.045));
  --gh-surface-2: var(--glasshouse-surface-2, rgba(255,255,255,0.075));
  --gh-border: var(--glasshouse-border, rgba(255,255,255,0.09));
  --gh-blur: var(--glasshouse-blur, 18px);
  --gh-radius: var(--glasshouse-radius, 22px);
  --gh-radius-sm: var(--glasshouse-radius-sm, 14px);
  --gh-pad: var(--glasshouse-pad, 16px);
  --gh-gap: var(--glasshouse-gap, 10px);
  --gh-text: var(--glasshouse-text, #e9eef6);
  --gh-text-2: var(--glasshouse-text-2, #93a0b5);
  --gh-text-3: var(--glasshouse-text-3, #5d697d);
  --gh-ok: var(--glasshouse-ok, #3fb950);
  --gh-warn: var(--glasshouse-warn, #e3b341);
  --gh-alert: var(--glasshouse-alert, #ff5c5c);
  --gh-info: var(--glasshouse-info, #58a6ff);
  --gh-light: var(--glasshouse-light, #ffb547);
  --gh-fan: var(--glasshouse-fan, #4dd6e8);
  --gh-cover: var(--glasshouse-cover, #a3a8ff);
  --gh-switch: var(--glasshouse-switch, #7ee08a);
  --gh-heat: var(--glasshouse-heat, #ff7a59);
  --gh-cool: var(--glasshouse-cool, #58a6ff);
  --gh-media: var(--glasshouse-media, #c48cff);
  --gh-lock: var(--glasshouse-lock, #3fb950);
  --gh-security: var(--glasshouse-security, #ff5c5c);
  --gh-energy: var(--glasshouse-energy, #f6d365);
  --gh-water: var(--glasshouse-water, #4aa8ff);
  --gh-neutral: var(--glasshouse-neutral, #93a0b5);
  --gh-accent: var(--gh-info);
  --gh-dot-ring: var(--glasshouse-dot-ring, #10141b);
  display: block;
}
ha-card {
  display: block;
  position: relative;
  box-sizing: border-box;
  height: 100%;
  background: var(--gh-surface);
  border: 1px solid var(--gh-border);
  border-radius: var(--gh-radius);
  backdrop-filter: blur(var(--gh-blur)) saturate(140%);
  -webkit-backdrop-filter: blur(var(--gh-blur)) saturate(140%);
  padding: var(--gh-pad);
  color: var(--gh-text);
  font-family: var(--gh-font);
  box-shadow: none;
  overflow: hidden;
  transition: box-shadow 160ms ease, border-color 160ms ease;
}
.head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin: -2px 2px 12px;
}
.label {
  font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .09em;
  color: var(--gh-text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.head .win { color: var(--gh-text-3); flex: none; }
.grid {
  display: grid;
  grid-template-columns: repeat(var(--cols, 1), minmax(0, 1fr));
  gap: var(--gh-gap);
}
.tile {
  all: unset;
  box-sizing: border-box;
  position: relative;
  display: flex; flex-direction: column;
  min-width: 0; min-height: 44px;
  container-type: inline-size;
  color: var(--gh-text);
  font-family: var(--gh-font);
  -webkit-tap-highlight-color: transparent;
  transition: background 160ms ease, box-shadow 160ms ease, opacity 160ms ease;
}
button.tile { cursor: pointer; }
.multi .tile {
  padding: 12px 12px 11px;
  background: var(--gh-surface);
  border: 1px solid var(--gh-border);
  border-radius: var(--gh-radius-sm);
}
.multi button.tile:hover { background: var(--gh-surface-2); }
.tile:focus-visible { outline: 2px solid var(--gh-accent); outline-offset: 2px; border-radius: var(--gh-radius-sm); }
.single .tile:focus-visible { outline-offset: 6px; }
.tile.unavail { opacity: .45; }
.multi .tile.alerting, ha-card.alerting { animation: gh-pulse 2.4s ease-in-out infinite; }
@keyframes gh-pulse {
  0%, 100% { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gh-alert) 45%, transparent), 0 0 18px -10px var(--gh-alert); }
  50% { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--gh-alert) 85%, transparent), 0 0 22px -4px var(--gh-alert); }
}

.top { display: flex; align-items: center; gap: 10px; min-width: 0; }
.chip {
  position: relative; flex: none;
  width: 32px; height: 32px; border-radius: 10px;
  display: grid; place-items: center;
  --mdc-icon-size: 20px;
  color: var(--gh-text-2);
  background: var(--gh-surface-2);
  transition: background 160ms ease, color 160ms ease, box-shadow 160ms ease;
}
.chip.on {
  color: var(--acc);
  background: color-mix(in srgb, var(--acc) 16%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--acc) 45%, transparent), 0 0 18px -6px var(--acc);
}
.chip ha-icon, .chip ha-state-icon { display: flex; width: 20px; height: 20px; }
.badge {
  position: absolute; right: -5px; top: -5px;
  width: 15px; height: 15px; border-radius: 50%;
  display: grid; place-items: center;
  background: var(--gh-dot-ring); color: var(--gh-warn);
  --mdc-icon-size: 13px;
}
.badge ha-icon { display: flex; width: 13px; height: 13px; }
.name { flex: 1 1 auto; min-width: 0; }
.trend {
  flex: none;
  display: inline-flex; align-items: center; gap: 3px;
  height: 20px; padding: 0 7px; border-radius: 999px;
  font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: .01em;
  color: var(--tc); background: color-mix(in srgb, var(--tc) 14%, transparent);
  white-space: nowrap;
}
.trend.alt { display: none; align-self: center; }
@container (max-width: 210px) {
  .top .trend { display: none; }
  .value { flex-wrap: wrap; row-gap: 6px; }
  .value .num { flex: none; font-size: clamp(20px, 15cqi, 26px); }
  .trend.alt { display: inline-flex; margin-left: 2px; }
}
.trend .ar { font-size: 8px; line-height: 1; transform: translateY(-.5px); }

.value {
  display: flex; align-items: baseline; gap: 4px; min-width: 0;
  margin-top: 10px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.value .num {
  font-size: 26px; font-weight: 700; line-height: 1.05; letter-spacing: -0.01em;
  color: var(--vc, var(--gh-text));
  overflow: hidden; text-overflow: ellipsis;
  transition: color 160ms ease;
}
.value .unit { font-size: 13px; font-weight: 500; color: var(--gh-text-2); flex: none; }
.single .value { margin-top: 14px; }
.single .value .num { font-size: clamp(28px, 13cqi, 40px); letter-spacing: -0.02em; line-height: 1; }
.single .value .unit { font-size: 14px; }
.value.text .num { font-size: 22px; letter-spacing: 0; }
/* name_position: below — state beside the icon, the name (same size) on its own line, up to two lines */
.top .value.state-top { margin-top: 0; min-width: 0; }
.top .value.state-top .num { font-size: 20px; }
.label.name.below { margin-top: 10px; white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-height: 1.35; }
/* since: inline — "Clear  for 9h 51m" on the value line */
.value .since { margin-left: 6px; font-size: 13px; font-weight: 500; color: var(--gh-text-2); flex: none; }
.value .since .k { color: var(--gh-text-3); margin-right: 4px; }
.single .value.text .num { font-size: clamp(24px, 10cqi, 30px); }

.sec {
  margin-top: 5px;
  font-size: 13px; font-weight: 500; color: var(--gh-text-2);
  font-variant-numeric: tabular-nums;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sec .k { color: var(--gh-text-3); margin-right: 4px; }
.sec.warn { color: var(--gh-warn); }

.graph {
  position: relative;
  margin-top: auto;
  padding-top: 12px;
  height: 44px;
  flex: none;
}
.single .graph { height: 76px; padding-top: 16px; }
.plot { position: relative; width: 100%; height: 100%; }
.plot svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; display: block; }
.plot .area { stroke: none; }
.plot .stroke {
  fill: none; stroke: var(--acc); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round;
  vector-effect: non-scaling-stroke;
}
.plot .ref { stroke: var(--gh-text-3); stroke-width: 1; stroke-dasharray: 2 4; vector-effect: non-scaling-stroke; opacity: .7; }
.plot stop { stop-color: var(--acc); }
.dot {
  position: absolute; width: 8px; height: 8px; margin: -4px 0 0 -4px; border-radius: 50%;
  background: var(--dc, var(--acc));
  box-shadow: 0 0 0 2px var(--gh-dot-ring), 0 0 12px 1px color-mix(in srgb, var(--dc, var(--acc)) 70%, transparent);
  pointer-events: none;
}
.dot.ext {
  width: 6px; height: 6px; margin: -3px 0 0 -3px;
  background: var(--gh-dot-ring);
  box-shadow: inset 0 0 0 1.5px var(--acc);
}
.bars { display: flex; align-items: flex-end; gap: 2px; width: 100%; height: 100%; }
.bars.dense { gap: 1px; }
.bars i {
  flex: 1 1 0; min-width: 0; min-height: 2px;
  border-radius: 3px 3px 1px 1px;
  background: linear-gradient(to top, color-mix(in srgb, var(--acc) 30%, transparent), color-mix(in srgb, var(--acc) 78%, transparent));
}
.bars i.last { background: var(--dc, var(--acc)); box-shadow: 0 0 12px -2px var(--dc, var(--acc)); }
.bars i.gap { background: var(--gh-surface-2); height: 2px !important; }
.loading {
  height: 100%; border-radius: 8px;
  background: linear-gradient(90deg, transparent, var(--gh-surface-2), transparent) 0 0 / 200% 100%;
  animation: gh-shimmer 1.6s linear infinite; opacity: .7;
}
@keyframes gh-shimmer { to { background-position: -200% 0; } }

.timeline {
  display: flex; width: 100%; height: 10px; border-radius: 5px; overflow: hidden;
  background: var(--gh-surface-2);
}
.timeline i { height: 100%; min-width: 0; }
.timeline i.on { background: var(--acc); box-shadow: 0 0 10px -2px var(--acc); }
.timeline i.off { background: transparent; }
.timeline i.na { background: repeating-linear-gradient(135deg, transparent 0 3px, color-mix(in srgb, var(--gh-text-3) 55%, transparent) 3px 4px); }
.timeline i.alt1 { background: color-mix(in srgb, var(--acc) 55%, transparent); }
.timeline i.alt2 { background: color-mix(in srgb, var(--acc) 30%, transparent); }
.graph.tl { height: auto; padding-top: 14px; }
.single .graph.tl { height: auto; }

.foot {
  display: flex; justify-content: space-between; gap: 8px;
  margin-top: 7px;
  font-size: 11px; font-weight: 500; color: var(--gh-text-3);
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.foot b { font-weight: 600; color: var(--gh-text-2); }
.foot .rng { overflow: hidden; text-overflow: ellipsis; }

.cursor {
  position: absolute; top: 0; bottom: 0; width: 1px; margin-left: -.5px;
  background: color-mix(in srgb, var(--gh-text) 35%, transparent);
  pointer-events: none; display: none;
}
.tip {
  position: absolute; top: -10px; transform: translate(-50%, -100%);
  padding: 4px 8px; border-radius: 8px;
  background: rgba(16,20,27,.92); border: 1px solid var(--gh-border);
  font-size: 11px; font-weight: 600; color: var(--gh-text); white-space: nowrap;
  font-variant-numeric: tabular-nums;
  pointer-events: none; display: none; z-index: 2;
}
.tip span { color: var(--gh-text-3); font-weight: 500; margin-left: 6px; }
.graph.hovering .cursor, .graph.hovering .tip { display: block; }
.graph.hovering .dot.last { opacity: .35; }

.err { padding: 4px 2px; font-size: 13px; color: var(--gh-warn); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
`;

  class GlasshouseStatCard extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
      this._series = new Map(); // entity_id -> [{t, s}] raw samples, sorted
      this._prev = {};
      this._lastFetch = 0;
      this._fetching = false;
      this._view = [];
      this._built = false;
      this._width = 0;
    }

    // ---------- HA card API ----------
    static getStubConfig(hass) {
      const states = hass ? Object.values(hass.states) : [];
      const pick = states.find((s) => s.entity_id.startsWith('sensor.')
        && s.attributes.unit_of_measurement && num(s.state) != null)
        || states.find((s) => s.entity_id.startsWith('sensor.'));
      return { stats: [{ entity: pick ? pick.entity_id : 'sensor.example' }] };
    }

    setConfig(config) {
      if (!config || typeof config !== 'object') throw new Error('Invalid configuration');
      let stats = config.stats;
      if (stats == null && config.entity) stats = [{ ...config, title: undefined }];
      if (!Array.isArray(stats) || stats.length === 0) {
        throw new Error('glasshouse-stat-card: "stats" must be a non-empty list (each with an "entity")');
      }
      const hours = config.hours == null ? 24 : Number(config.hours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 31) {
        throw new Error('glasshouse-stat-card: "hours" must be a number between 0 and 744');
      }
      if (config.columns != null) {
        const c = Number(config.columns);
        if (!Number.isInteger(c) || c < 1 || c > 8) throw new Error('glasshouse-stat-card: "columns" must be an integer 1-8');
      }
      if (config.min_tile_width != null) {
        const m = Number(config.min_tile_width);
        if (!Number.isFinite(m) || m < 60 || m > 400) throw new Error('glasshouse-stat-card: "min_tile_width" must be a number of pixels, 60-400');
      }
      const defaults = {};
      ['graph', 'trend', 'extrema', 'accent', 'decimals', 'tap_action', 'hold_action', 'since', 'name_position'].forEach((k) => {
        if (config[k] !== undefined && config.stats) defaults[k] = config[k];
      });
      const norm = stats.map((raw, idx) => {
        const s0 = typeof raw === 'string' ? { entity: raw } : raw;
        if (!s0 || typeof s0 !== 'object') throw new Error(`glasshouse-stat-card: stats[${idx}] must be an object`);
        const s = { ...defaults, ...s0 };
        if (typeof s.entity !== 'string' || !s.entity.includes('.')) {
          throw new Error(`glasshouse-stat-card: stats[${idx}] needs an "entity" like sensor.xyz`);
        }
        const graph = s.graph ?? 'line';
        if (!GRAPHS.includes(graph)) throw new Error(`glasshouse-stat-card: stats[${idx}].graph must be one of ${GRAPHS.join(', ')}`);
        const trend = s.trend === false ? 'none' : (s.trend ?? 'normal');
        if (!TRENDS.includes(trend)) throw new Error(`glasshouse-stat-card: stats[${idx}].trend must be one of ${TRENDS.join(', ')}`);
        if (s.decimals != null && !(Number.isInteger(+s.decimals) && +s.decimals >= 0 && +s.decimals <= 6)) {
          throw new Error(`glasshouse-stat-card: stats[${idx}].decimals must be 0-6`);
        }
        if (s.name_position != null && !['top', 'below'].includes(s.name_position)) {
          throw new Error(`glasshouse-stat-card: stats[${idx}].name_position must be "top" or "below"`);
        }
        if (s.since != null && !['below', 'inline'].includes(s.since)) {
          throw new Error(`glasshouse-stat-card: stats[${idx}].since must be "below" or "inline"`);
        }
        if (s.secondary != null && (typeof s.secondary !== 'string' || !s.secondary.includes('.'))) {
          throw new Error(`glasshouse-stat-card: stats[${idx}].secondary must be an entity id`);
        }
        let thresholds = [];
        if (s.thresholds != null) {
          if (!Array.isArray(s.thresholds)) throw new Error(`glasshouse-stat-card: stats[${idx}].thresholds must be a list`);
          thresholds = s.thresholds.map((t, j) => {
            if (!t || (t.above == null && t.below == null) || t.color == null) {
              throw new Error(`glasshouse-stat-card: stats[${idx}].thresholds[${j}] needs "above" or "below" and a "color"`);
            }
            const above = t.above == null ? null : Number(t.above);
            const below = t.below == null ? null : Number(t.below);
            if ((above != null && !Number.isFinite(above)) || (below != null && !Number.isFinite(below))) {
              throw new Error(`glasshouse-stat-card: stats[${idx}].thresholds[${j}] above/below must be numbers`);
            }
            return { above, below, token: String(t.color).trim(), color: resolveColor(t.color, null) };
          }).sort((a, b) => (a.above ?? -Infinity) - (b.above ?? -Infinity));
        }
        const tap = normAction(s.tap_action, s.navigation_path, 'more-info');
        const hold = normAction(s.hold_action, s.navigation_path, 'more-info');
        [tap, hold].forEach((a) => {
          if (!ACTIONS.includes(a.action)) throw new Error(`glasshouse-stat-card: stats[${idx}] action must be one of ${ACTIONS.join(', ')}`);
          if (a.action === 'navigate' && !a.navigation_path) throw new Error(`glasshouse-stat-card: stats[${idx}] navigate needs "navigation_path"`);
        });
        const gmin = s.graph_min == null ? null : Number(s.graph_min);
        const gmax = s.graph_max == null ? null : Number(s.graph_max);
        return {
          entity: s.entity,
          name: s.name,
          icon: s.icon,
          accentToken: s.accent,
          accent: resolveColor(s.accent, 'var(--gh-info)'),
          decimals: s.decimals == null ? null : +s.decimals,
          unit: s.unit,
          graph,
          trend,
          extrema: s.extrema,
          thresholds,
          secondary: s.secondary,
          secondary_label: s.secondary_label,
          since: s.since || 'below',
          namePos: s.name_position || 'top',
          bars: s.bars == null ? null : clamp(Math.round(+s.bars) || 24, 4, 120),
          graph_min: Number.isFinite(gmin) ? gmin : null,
          graph_max: Number.isFinite(gmax) ? gmax : null,
          tap,
          hold,
        };
      });
      const prevKey = this._config ? `${this._config.hours}|${this._config.stats.map((s) => s.entity).join(',')}` : '';
      this._config = {
        title: config.title, hours, columns: config.columns == null ? null : +config.columns,
        minTile: config.min_tile_width == null ? 120 : +config.min_tile_width, stats: norm,
      };
      const key = `${hours}|${norm.map((s) => s.entity).join(',')}`;
      if (key !== prevKey) { this._series.clear(); this._lastFetch = 0; }
      this._built = false;
      if (this._hass) { this._build(); this._update(); this._maybeFetch(); }
    }

    set hass(hass) {
      const first = !this._hass;
      this._hass = hass;
      if (!this._config) return;
      let changed = first || !this._built;
      const watched = this._watched();
      for (const id of watched) {
        const st = hass.states[id];
        if (st !== this._prev[id]) {
          changed = true;
          if (st && this._series.has(id)) this._append(id, st);
          this._prev[id] = st;
        }
      }
      if (!this._built) this._build();
      if (changed) this._update();
      this._maybeFetch();
    }

    get hass() { return this._hass; }

    getCardSize() {
      if (!this._config) return 3;
      const n = this._config.stats.length;
      const head = this._config.title ? 1 : 0;
      if (n === 1) return 3 + head;
      const cols = this._cols || this._config.columns || 2;
      return head + Math.ceil(n / cols) * 3;
    }

    getGridOptions() {
      const single = !this._config || this._config.stats.length === 1;
      return single
        ? { columns: 6, min_columns: 3, rows: 'auto' }
        : { columns: 12, min_columns: 6, rows: 'auto' };
    }

    connectedCallback() {
      if (!this._tick) {
        this._tick = setInterval(() => {
          if (!this._hass || !this._config) return;
          this._maybeFetch();
          this._update();
        }, TICK_MS);
      }
      if (this._card && this._ro) this._ro.observe(this._card);
    }

    disconnectedCallback() {
      clearInterval(this._tick);
      this._tick = null;
      if (this._ro) this._ro.disconnect();
      clearTimeout(this._holdTimer);
    }

    // ---------- data ----------
    _watched() {
      const ids = new Set();
      this._config.stats.forEach((s) => { ids.add(s.entity); if (s.secondary) ids.add(s.secondary); });
      return ids;
    }

    _historyIds() {
      return [...new Set(this._config.stats.map((s) => s.entity))];
    }

    _windowMs() { return this._config.hours * 3600 * 1000; }

    _append(id, st) {
      const arr = this._series.get(id);
      const t = Date.parse(st.last_updated || st.last_changed) || Date.now();
      const last = arr[arr.length - 1];
      if (last && t <= last.t) {
        if (t === last.t) last.s = st.state;
        return;
      }
      arr.push({ t, s: st.state });
      const cutoff = Date.now() - this._windowMs();
      let k = 0;
      while (k < arr.length - 1 && arr[k + 1].t <= cutoff) k++;
      if (k > 0) arr.splice(0, k);
    }

    _maybeFetch() {
      if (!this._hass || !this._config || this._fetching) return;
      if (typeof this._hass.callWS !== 'function') return;
      if (Date.now() - this._lastFetch < REFRESH_MS) return;
      this._fetchHistory();
    }

    async _fetchHistory() {
      const hass = this._hass;
      const ids = this._historyIds();
      const cfg = this._config;
      const end = new Date();
      const start = new Date(end.getTime() - this._windowMs());
      this._fetching = true;
      this._lastFetch = Date.now();
      try {
        const res = await hass.callWS({
          type: 'history/history_during_period',
          start_time: start.toISOString(),
          end_time: end.toISOString(),
          entity_ids: ids,
          minimal_response: true,
          no_attributes: true,
          significant_changes_only: false,
        });
        if (cfg !== this._config) return; // config changed mid-flight
        ids.forEach((id) => {
          const rows = (res && res[id]) || [];
          const arr = [];
          rows.forEach((r) => {
            let t;
            if (r.lu != null || r.lc != null) t = (r.lu ?? r.lc) * 1000;
            else t = Date.parse(r.last_updated || r.last_changed);
            const s = r.s ?? r.state;
            if (Number.isFinite(t) && s !== undefined) arr.push({ t, s });
          });
          arr.sort((a, b) => a.t - b.t);
          this._series.set(id, arr);
          const st = this._hass.states[id];
          if (st) this._append(id, st);
        });
        this._histError = false;
      } catch (err) {
        this._histError = true;
        // eslint-disable-next-line no-console
        console.warn('glasshouse-stat-card: history fetch failed', err);
      } finally {
        this._fetching = false;
      }
      if (cfg === this._config) this._update();
    }

    // ---------- formatting ----------
    _lang() {
      const h = this._hass;
      return (h && ((h.locale && h.locale.language) || h.language)) || navigator.language || 'en';
    }

    _nf(d) {
      const key = `${this._lang()}|${d}`;
      this._nfc = this._nfc || {};
      if (!this._nfc[key]) {
        try {
          this._nfc[key] = new Intl.NumberFormat(this._lang(), { minimumFractionDigits: d, maximumFractionDigits: d });
        } catch (e) {
          this._nfc[key] = new Intl.NumberFormat('en', { minimumFractionDigits: d, maximumFractionDigits: d });
        }
      }
      return this._nfc[key];
    }

    _decimals(stat, v, entityId) {
      if (stat && stat.decimals != null) return stat.decimals;
      const reg = this._hass && this._hass.entities && this._hass.entities[entityId || stat.entity];
      if (reg && Number.isInteger(reg.display_precision)) return reg.display_precision;
      const st = this._hass && this._hass.states[entityId || stat.entity];
      const raw = st && num(st.state) != null ? String(st.state) : null;
      if (raw && !/e/i.test(raw)) {
        const dot = raw.indexOf('.');
        const d = dot < 0 ? 0 : raw.length - dot - 1;
        return Math.min(d, Math.abs(v) < 1 ? 3 : 2);
      }
      const a = Math.abs(v);
      if (a === 0 || a >= 100) return 0;
      if (a >= 1) return 1;
      return 2;
    }

    _fmt(v, stat, d) {
      if (v == null || !Number.isFinite(v)) return '—';
      return this._nf(d ?? this._decimals(stat, v)).format(v);
    }

    _stateText(st) {
      if (!st) return '—';
      const h = this._hass;
      if (h && typeof h.formatEntityState === 'function') {
        try { return h.formatEntityState(st); } catch (e) { /* fall through */ }
      }
      const domain = st.entity_id.split('.')[0];
      if (domain === 'binary_sensor' && (st.state === 'on' || st.state === 'off')) {
        const pair = BINARY_LABELS[st.attributes.device_class] || ['Off', 'On'];
        return pair[st.state === 'on' ? 1 : 0];
      }
      const n = num(st.state);
      if (n != null) {
        const u = st.attributes.unit_of_measurement;
        return `${this._fmt(n, null, this._decimals({}, n, st.entity_id))}${u ? ` ${u}` : ''}`;
      }
      const s = String(st.state).replace(/_/g, ' ');
      return s.charAt(0).toUpperCase() + s.slice(1);
    }

    _timeFmt(t) {
      const opts = this._config.hours > 36
        ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
        : { hour: 'numeric', minute: '2-digit' };
      try { return new Date(t).toLocaleTimeString(this._lang(), opts); } catch (e) { return new Date(t).toLocaleTimeString(); }
    }

    // ---------- model ----------
    _isNumeric(st, samples, stat) {
      if (st && num(st.state) != null) return true;
      if (st && (st.attributes.unit_of_measurement || st.attributes.state_class)) return true;
      if (stat.unit || stat.thresholds.length) return true;
      const domain = stat.entity.split('.')[0];
      if (st && !BAD_STATES.includes(st.state)) return false;
      if (samples && samples.some((x) => num(x.s) != null)) return true;
      return ['sensor', 'number', 'input_number', 'counter'].includes(domain);
    }

    _threshold(stat, v) {
      if (v == null) return null;
      let hit = null;
      stat.thresholds.forEach((t) => {
        if ((t.above == null || v > t.above) && (t.below == null || v < t.below)) hit = t;
      });
      return hit;
    }

    _model(stat, i) {
      const hass = this._hass;
      const st = hass.states[stat.entity];
      const samples = this._series.get(stat.entity);
      const missing = !st;
      const unavail = missing || BAD_STATES.includes(st.state);
      const name = stat.name ?? (st && st.attributes.friendly_name) ?? stat.entity;
      const numeric = this._isNumeric(st, samples, stat);
      const now = Date.now();
      const start = now - this._windowMs();
      const m = {
        i, stat, st, name, missing, unavail, numeric, samples, start, end: now,
        accent: stat.accent,
      };
      if (numeric) {
        m.value = st ? num(st.state) : null;
        m.unit = stat.unit ?? (st && st.attributes.unit_of_measurement) ?? '';
        m.dec = m.value != null ? this._decimals(stat, m.value) : 0;
        if (samples) {
          const pts = samples.map((x) => ({ t: x.t, v: num(x.s) }));
          // Decimals when the current value is unavailable: borrow from history.
          if (m.value == null) {
            const lastNum = [...pts].reverse().find((p) => p.v != null);
            if (lastNum) m.dec = this._decimals(stat, lastNum.v);
          }
          const nb = stat.graph === 'bar'
            ? (stat.bars || (this._config.hours <= 48 ? clamp(Math.round(this._config.hours), 12, 48) : 48))
            : LINE_POINTS;
          const b = bucketize(pts, start, now, nb);
          if (stat.graph !== 'bar' && m.value != null) b[nb - 1] = m.value;
          m.buckets = b;
          const firstIdx = b.findIndex((v) => v != null);
          m.startVal = firstIdx >= 0 ? b[firstIdx] : null;
          // Raw extremes inside the window (including the value held at window start).
          let lo = null;
          let hi = null;
          let held = null;
          pts.forEach((p) => {
            if (p.t <= start) { held = p; return; }
            if (p.v == null) return;
            if (!lo || p.v < lo.v) lo = p;
            if (!hi || p.v > hi.v) hi = p;
          });
          if (held && held.v != null) {
            const hp = { t: start, v: held.v };
            if (!lo || hp.v < lo.v) lo = hp;
            if (!hi || hp.v > hi.v) hi = hp;
          }
          m.lo = lo;
          m.hi = hi;
        }
        const th = this._threshold(stat, m.value);
        m.valueColor = th ? th.color : null;
        m.alerting = !!(th && th.token === 'alert' && !unavail);
      } else {
        m.text = missing ? '—' : (unavail ? this._stateText(st) : this._stateText(st));
        m.active = !!(st && ACTIVE_STATES.includes(st.state));
        if (samples) {
          const segs = [];
          let held = null;
          samples.forEach((x) => {
            if (x.t <= start) { held = x; return; }
            segs.push({ t: x.t, s: x.s });
          });
          if (held) segs.unshift({ t: start, s: held.s });
          m.segments = segs;
        }
      }
      return m;
    }

    // ---------- rendering ----------
    _build() {
      const cfg = this._config;
      const single = cfg.stats.length === 1;
      const root = this.shadowRoot;
      root.innerHTML = `<style>${CSS}</style>
        <ha-card class="${single ? 'single' : 'multi'}">
          ${cfg.title ? `<div class="head"><span class="label">${esc(cfg.title)}</span><span class="label win">${windowLabel(cfg.hours)}</span></div>` : ''}
          <div class="grid"></div>
        </ha-card>`;
      this._card = root.querySelector('ha-card');
      this._grid = root.querySelector('.grid');
      this._tiles = cfg.stats.map((s, i) => {
        const actionable = s.tap.action !== 'none' || s.hold.action !== 'none';
        const el = document.createElement(actionable ? 'button' : 'div');
        el.className = 'tile';
        el.dataset.i = String(i);
        if (actionable) el.type = 'button';
        this._grid.appendChild(el);
        return el;
      });
      const g = this._grid;
      g.addEventListener('pointerdown', (e) => this._onDown(e));
      g.addEventListener('pointerup', () => this._cancelHold());
      g.addEventListener('pointercancel', () => this._cancelHold());
      g.addEventListener('pointerleave', () => this._cancelHold());
      g.addEventListener('pointermove', (e) => this._onMove(e));
      g.addEventListener('click', (e) => this._onClick(e));
      g.addEventListener('contextmenu', (e) => { if (e.target.closest('.tile')) e.preventDefault(); });
      g.addEventListener('pointerout', (e) => {
        const gr = e.target.closest && e.target.closest('.graph');
        if (gr && !gr.contains(e.relatedTarget)) gr.classList.remove('hovering');
      });
      if (this._ro) this._ro.disconnect();
      if (typeof ResizeObserver !== 'undefined') {
        this._ro = new ResizeObserver((ents) => {
          const w = ents[0].contentRect.width;
          if (Math.abs(w - this._width) > 0.5) { this._width = w; this._layout(); }
        });
        this._ro.observe(this._card);
      }
      this._built = true;
      this._width = this._card.getBoundingClientRect().width;
      this._layout();
    }

    _layout() {
      const cfg = this._config;
      const n = cfg.stats.length;
      let cols = 1;
      if (n > 1) {
        const w = this._grid.getBoundingClientRect().width || this._width || 360;
        const gap = 10;
        if (cfg.columns) {
          const fit = Math.max(1, Math.floor((w + gap) / (cfg.minTile + gap)));
          cols = Math.min(cfg.columns, fit, n);
        } else {
          const maxCols = clamp(Math.floor((w + gap) / (150 + gap)), 1, n);
          const rows = Math.ceil(n / maxCols);
          cols = Math.ceil(n / rows);
        }
      }
      this._cols = cols;
      this._grid.style.setProperty('--cols', String(cols));
    }

    _update() {
      if (!this._built || !this._hass) return;
      const cfg = this._config;
      const single = cfg.stats.length === 1;
      this._view = [];
      let cardAlert = false;
      cfg.stats.forEach((stat, i) => {
        const m = this._model(stat, i);
        this._view[i] = m;
        const el = this._tiles[i];
        el.style.setProperty('--acc', m.accent);
        el.style.setProperty('--gh-accent', m.accent);
        el.classList.toggle('unavail', m.unavail);
        el.classList.toggle('alerting', !!m.alerting && !single);
        if (single && m.alerting) cardAlert = true;
        const valText = m.numeric ? `${this._fmt(m.value, stat, m.dec)}${m.unit ? ` ${m.unit}` : ''}` : m.text;
        if (el.tagName === 'BUTTON') el.setAttribute('aria-label', `${m.name}: ${valText}`);
        el.innerHTML = m.numeric ? this._numericHTML(m, single) : this._stateHTML(m, single);
        const si = el.querySelector('ha-state-icon');
        if (si) { si.hass = this._hass; si.stateObj = m.st; }
      });
      this._card.classList.toggle('alerting', cardAlert);
    }

    _iconHTML(m, on) {
      const icon = m.stat.icon
        ? `<ha-icon icon="${esc(m.stat.icon)}"></ha-icon>`
        : (m.st ? '<ha-state-icon></ha-state-icon>' : '<ha-icon icon="mdi:help-circle-outline"></ha-icon>');
      const badge = m.unavail ? '<span class="badge"><ha-icon icon="mdi:alert-circle-outline"></ha-icon></span>' : '';
      return `<span class="chip${on ? ' on' : ''}">${icon}${badge}</span>`;
    }

    _trendHTML(m) {
      const mode = m.stat.trend;
      if (mode === 'none' || m.value == null || m.startVal == null) return '';
      const diff = m.value - m.startVal;
      const base = Math.abs(m.startVal);
      const scale = Math.max(Math.abs(m.value), base) || 1;
      const flat = Math.abs(diff) / scale < 0.0005;
      let text;
      if (flat) text = '0%';
      else if (base > 1e-9) {
        const pct = (Math.abs(diff) / base) * 100;
        text = `${this._nf(pct >= 100 ? 0 : 1).format(pct)}%`;
      } else text = `${this._fmt(Math.abs(diff), m.stat, m.dec)}${m.unit ? ` ${m.unit}` : ''}`;
      const up = diff > 0;
      let color = 'var(--gh-text-2)';
      if (!flat && mode !== 'neutral') {
        const good = mode === 'inverse' ? !up : up;
        color = good ? 'var(--gh-ok)' : 'var(--gh-alert)';
      }
      const arrow = flat ? '' : `<span class="ar">${up ? '▲' : '▼'}</span>`;
      const dir = flat ? 'unchanged' : (up ? 'up' : 'down');
      return `<span class="trend" style="--tc:${color}" title="${dir} ${text} vs ${windowLabel(this._config.hours)} ago">${arrow}${text}</span>`;
    }

    _secondaryHTML(m) {
      const s = m.stat;
      if (m.missing) return '<div class="sec warn">Entity not found</div>';
      if (s.secondary) {
        const st2 = this._hass.states[s.secondary];
        let v;
        if (!st2) v = '—';
        else if (BAD_STATES.includes(st2.state)) v = '—';
        else v = this._stateText(st2);
        const k = s.secondary_label ? `<span class="k">${esc(s.secondary_label)}</span>` : '';
        return `<div class="sec">${k}${esc(v)}</div>`;
      }
      if (!m.numeric && m.st && !m.unavail) {
        const since = Date.parse(m.st.last_changed);
        if (Number.isFinite(since)) return `<div class="sec"><span class="k">for</span>${durationLabel(Date.now() - since)}</div>`;
      }
      return '';
    }

    _numericHTML(m, single) {
      const s = m.stat;
      const vstyle = m.valueColor ? ` style="--vc:${m.valueColor}"` : '';
      const trend = this._trendHTML(m);
      const head = `<div class="top">${this._iconHTML(m, !m.unavail)}<span class="label name">${esc(m.name)}</span>${trend}</div>`;
      const value = `<div class="value"${vstyle}><span class="num">${this._fmt(m.value, s, m.dec)}</span>${m.unit && m.value != null ? `<span class="unit">${esc(m.unit)}</span>` : ''}${trend ? trend.replace('class="trend"', 'class="trend alt"') : ''}</div>`;
      let graph = '';
      if (s.graph !== 'none') {
        if (!m.buckets) {
          graph = this._histError
            ? ''
            : '<div class="graph"><div class="plot"><div class="loading"></div></div></div>';
        } else if (m.buckets.every((v) => v == null)) {
          graph = '';
        } else {
          graph = s.graph === 'bar' ? this._barsHTML(m) : this._lineHTML(m, single);
        }
      }
      const showExt = (s.extrema ?? (single && s.graph === 'line')) && m.lo && m.hi && graph;
      const foot = showExt
        ? `<div class="foot"><span>${windowLabel(this._config.hours)}</span><span class="rng">Lo <b>${this._fmt(m.lo.v, s, m.dec)}</b> · Hi <b>${this._fmt(m.hi.v, s, m.dec)}</b></span></div>`
        : '';
      return head + value + this._secondaryHTML(m) + graph + foot;
    }

    _range(m) {
      const s = m.stat;
      const vals = m.buckets.filter((v) => v != null);
      let lo = Math.min(...vals);
      let hi = Math.max(...vals);
      if (s.graph_min != null) lo = s.graph_min;
      if (s.graph_max != null) hi = s.graph_max;
      if (hi - lo < 1e-9) {
        const pad = Math.abs(hi) * 0.05 || 1;
        lo -= pad; hi += pad;
      }
      return [lo, hi];
    }

    _lineHTML(m, single) {
      const b = m.buckets;
      const n = b.length;
      const [lo, hi] = this._range(m);
      const X = (k) => (n === 1 ? 1000 : (k / (n - 1)) * 1000);
      const Y = (v) => 6 + (1 - clamp((v - lo) / (hi - lo), 0, 1)) * 84;
      const segs = [];
      let cur = [];
      b.forEach((v, k) => {
        if (v == null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([X(k), Y(v)]);
      });
      if (cur.length) segs.push(cur);
      const gid = `ghg${m.i}`;
      let area = '';
      let line = '';
      segs.forEach((p) => {
        if (p.length < 2) return;
        const d = monoPath(p);
        line += `<path class="stroke" d="${d}"/>`;
        area += `<path class="area" fill="url(#${gid})" d="${d}L${p[p.length - 1][0].toFixed(2)},100L${p[0][0].toFixed(2)},100Z"/>`;
      });
      const ref = single && m.startVal != null
        ? `<line class="ref" x1="0" x2="1000" y1="${Y(m.startVal).toFixed(2)}" y2="${Y(m.startVal).toFixed(2)}"/>`
        : '';
      let dots = '';
      let lastK = -1;
      for (let k = n - 1; k >= 0; k--) if (b[k] != null) { lastK = k; break; }
      if (m.stat.extrema ?? single) {
        const span = m.end - m.start;
        [m.hi, m.lo].forEach((p) => {
          if (!p) return;
          const k = clamp(Math.floor(((p.t - m.start) / span) * n), 0, n - 1);
          if (b[k] == null || k === lastK) return;
          dots += `<span class="dot ext" style="left:${(X(k) / 10).toFixed(3)}%;top:${Y(b[k]).toFixed(3)}%"></span>`;
        });
      }
      if (lastK >= 0) {
        const dc = m.valueColor ? `--dc:${m.valueColor};` : '';
        dots += `<span class="dot last" style="${dc}left:${(X(lastK) / 10).toFixed(3)}%;top:${Y(b[lastK]).toFixed(3)}%"></span>`;
      }
      return `<div class="graph line"><div class="plot">
        <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
          <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-opacity="${single ? 0.34 : 0.3}"/><stop offset="0.65" stop-opacity="0.07"/><stop offset="1" stop-opacity="0"/>
          </linearGradient></defs>
          ${area}${ref}${line}
        </svg>${dots}<span class="cursor"></span><span class="tip"></span></div></div>`;
    }

    _barsHTML(m) {
      const b = m.buckets;
      const vals = b.filter((v) => v != null);
      let [lo, hi] = this._range(m);
      if (m.stat.graph_min == null) {
        const mn = Math.min(...vals);
        const mx = Math.max(...vals);
        if (mn >= 0 && mn <= mx * 0.5) lo = 0;
        else lo = mn - (mx - mn || Math.abs(mx) * 0.1 || 1) * 0.35;
      }
      let lastK = -1;
      for (let k = b.length - 1; k >= 0; k--) if (b[k] != null) { lastK = k; break; }
      const dc = m.valueColor ? ` style="--dc:${m.valueColor}"` : '';
      const bars = b.map((v, k) => {
        if (v == null) return '<i class="gap"></i>';
        const h = clamp((v - lo) / (hi - lo || 1), 0, 1) * 100;
        return `<i${k === lastK ? ` class="last"${dc}` : ''} style="height:${Math.max(h, 3).toFixed(2)}%"></i>`;
      }).join('');
      return `<div class="graph bar"><div class="plot"><div class="bars${b.length > 36 ? ' dense' : ''}">${bars}</div><span class="cursor"></span><span class="tip"></span></div></div>`;
    }

    _stateHTML(m, single) {
      let head = `<div class="top">${this._iconHTML(m, m.active && !m.unavail)}<span class="label name">${esc(m.name)}</span></div>`;
      const vstyle = m.active && !m.unavail ? ' style="--vc:var(--acc)"' : '';
      const sinceMs = m.st && !m.unavail && !m.stat.secondary ? Date.parse(m.st.last_changed) : NaN;
      const inline = m.stat.since === 'inline' && Number.isFinite(sinceMs);
      const after = inline ? `<span class="since"><span class="k">for</span>${durationLabel(Date.now() - sinceMs)}</span>` : '';
      let value = `<div class="value text"${vstyle}><span class="num">${esc(m.text)}</span>${after}</div>`;
      if (m.stat.namePos === 'below') {
        // state beside the icon, the full name on its own line under it
        head = `<div class="top">${this._iconHTML(m, m.active && !m.unavail)}<span class="value text state-top"${vstyle}><span class="num">${esc(m.text)}</span>${after}</span></div>`;
        value = `<div class="label name below">${esc(m.name)}</div>`;
      }
      let tl = '';
      if (m.stat.graph !== 'none' && m.segments && m.segments.length) {
        const span = m.end - m.start;
        const distinct = [];
        const parts = [];
        const segs = m.segments;
        // Leading gap before the first known sample.
        if (segs[0].t > m.start) parts.push({ w: segs[0].t - m.start, c: 'off', s: '' });
        segs.forEach((sg, k) => {
          const t1 = k + 1 < segs.length ? segs[k + 1].t : m.end;
          const w = Math.max(0, t1 - sg.t);
          let c;
          if (BAD_STATES.includes(sg.s)) c = 'na';
          else if (ACTIVE_STATES.includes(sg.s)) c = 'on';
          else if (['off', 'closed', 'not_home', 'idle', 'locked', 'standby', 'paused', 'clear', 'disarmed', 'dry', 'docked'].includes(sg.s)) c = 'off';
          else {
            let di = distinct.indexOf(sg.s);
            if (di < 0) { distinct.push(sg.s); di = distinct.length - 1; }
            c = ['on', 'alt1', 'alt2'][di % 3];
          }
          const prev = parts[parts.length - 1];
          if (prev && prev.c === c) prev.w += w; else parts.push({ w, c });
        });
        const cells = parts.filter((p) => p.w > 0)
          .map((p) => `<i class="${p.c}" style="width:${((p.w / span) * 100).toFixed(3)}%"></i>`).join('');
        tl = `<div class="graph tl"><div class="timeline">${cells}</div></div>
          <div class="foot"><span>${windowLabel(this._config.hours)} ago</span><span>now</span></div>`;
      }
      return head + value + (inline ? '' : this._secondaryHTML(m)) + tl;
    }

    // ---------- interaction ----------
    _onDown(e) {
      const tile = e.target.closest('.tile');
      if (!tile || (e.button != null && e.button !== 0)) return;
      this._held = false;
      this._downAt = [e.clientX, e.clientY];
      clearTimeout(this._holdTimer);
      const i = +tile.dataset.i;
      if (this._config.stats[i].hold.action === 'none') return;
      this._holdTimer = setTimeout(() => {
        this._held = true;
        this._fire('haptic', 'light');
        this._act(i, 'hold');
      }, HOLD_MS);
    }

    _cancelHold() { clearTimeout(this._holdTimer); }

    _onClick(e) {
      const tile = e.target.closest('.tile');
      if (!tile) return;
      if (this._held) { this._held = false; return; }
      this._act(+tile.dataset.i, 'tap');
    }

    _onMove(e) {
      if (this._downAt && Math.hypot(e.clientX - this._downAt[0], e.clientY - this._downAt[1]) > 10) this._cancelHold();
      if (e.pointerType && e.pointerType !== 'mouse') return;
      const gr = e.target.closest && e.target.closest('.graph');
      if (!gr || gr.classList.contains('tl')) return;
      const tile = gr.closest('.tile');
      const m = this._view[+tile.dataset.i];
      if (!m || !m.buckets) return;
      const plot = gr.querySelector('.plot');
      const r = plot.getBoundingClientRect();
      const fx = clamp((e.clientX - r.left) / r.width, 0, 1);
      const n = m.buckets.length;
      const bar = m.stat.graph === 'bar';
      const k = bar ? clamp(Math.floor(fx * n), 0, n - 1) : Math.round(fx * (n - 1));
      const x = bar ? ((k + 0.5) / n) * 100 : (n === 1 ? 100 : (k / (n - 1)) * 100);
      const v = m.buckets[k];
      const span = m.end - m.start;
      const t = bar ? m.start + ((k + 0.5) / n) * span : m.start + (n === 1 ? 1 : k / (n - 1)) * span;
      const cur = plot.querySelector('.cursor');
      const tip = plot.querySelector('.tip');
      cur.style.left = `${x}%`;
      const tipX = clamp(x, 0, 100);
      tip.style.left = `${tipX}%`;
      const shift = tipX < 18 ? '-10%' : tipX > 82 ? '-90%' : '-50%';
      tip.style.transform = `translate(${shift}, -100%)`;
      tip.innerHTML = `${this._fmt(v, m.stat, m.dec)}${v != null && m.unit ? ` ${esc(m.unit)}` : ''}<span>${esc(this._timeFmt(t))}</span>`;
      gr.classList.add('hovering');
    }

    _act(i, kind) {
      const s = this._config.stats[i];
      const a = kind === 'hold' ? s.hold : s.tap;
      if (a.action === 'more-info') {
        this._fire('hass-more-info', { entityId: a.entity || s.entity });
      } else if (a.action === 'navigate' && a.navigation_path) {
        window.history.pushState(null, '', a.navigation_path);
        window.dispatchEvent(new CustomEvent('location-changed', { detail: { replace: false } }));
      }
    }

    _fire(type, detail) {
      this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
    }

    _banner() {
      if (window.__glasshouseStatBanner) return;
      window.__glasshouseStatBanner = true;
      // eslint-disable-next-line no-console
      console.info(
        `%c GLASSHOUSE-STAT-CARD %c v${VERSION} `,
        'color:#10141b;background:#f6d365;font-weight:700;border-radius:4px 0 0 4px;padding:2px 4px',
        'color:#e9eef6;background:#58a6ff33;border:1px solid #58a6ff;border-radius:0 4px 4px 0;padding:1px 4px',
      );
    }
  }

  if (!customElements.get(TAG)) {
    customElements.define(TAG, GlasshouseStatCard);
    GlasshouseStatCard.prototype._banner();
  }
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === TAG)) {
    window.customCards.push({
      type: TAG,
      name: 'Glasshouse Stat Card',
      description: 'Data-rich metric tiles with live sparklines (Glasshouse suite).',
      preview: true,
    });
  }
})();
