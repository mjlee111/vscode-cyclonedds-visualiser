import './common/base.css';
import { host, Subscription } from './common/host';
import { clear, h, statusBanner, themeColor, toast } from './common/ui';

const PALETTE = ['#4e9cf5', '#f5a623', '#3fb950', '#f85149', '#bc8cff', '#39c5cf', '#ff7eb6', '#d29922', '#8b949e', '#a5d6ff'];
const MAX_POINTS = 200000;

interface SeriesDef {
  topic: string;
  field: string;
  type?: string;
  color: string;
  visible: boolean;
}
interface Series extends SeriesDef {
  t: number[];
  v: number[];
  last?: number;
}
interface Ui {
  series: SeriesDef[];
  window: number;
  autoY: boolean;
  yMin: number;
  yMax: number;
  useStamp: boolean;
}
const ui = host.loadState<Ui>({ series: [], window: 30, autoY: true, yMin: -1, yMax: 1, useStamp: false });
const series: Series[] = [];
const subs = new Map<string, Subscription>();
let paused = false;
let pausedEnd = 0;
let dirty = true;
let hoverX: number | undefined;

const save = () => {
  ui.series = series.map(({ topic, field, type, color, visible }) => ({ topic, field, type, color, visible }));
  host.saveState(ui);
};

// ---- toolbar --------------------------------------------------------------
const app = document.getElementById('app')!;
const topicIn = h('input', { list: 'topics-dl', placeholder: '/topic', style: 'width: 220px' });
const topicsDl = h('datalist', { id: 'topics-dl' });
const fieldIn = h('input', { list: 'fields-dl', placeholder: 'field.path (e.g. motors[0].q)', style: 'width: 240px' });
const fieldsDl = h('datalist', { id: 'fields-dl' });
topicIn.addEventListener('change', () => void loadFields(topicIn.value.trim()));
fieldIn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addFromInputs();
});
const winSel = h(
  'select',
  {
    title: 'Time window',
    onchange: () => {
      ui.window = Number(winSel.value);
      save();
      dirty = true;
    },
  },
  ...[5, 10, 30, 60, 120, 300].map((s) => h('option', { value: String(s), selected: s === ui.window }, `${s} s`)),
);
const autoCb = h('input', {
  type: 'checkbox',
  checked: ui.autoY,
  onchange: () => {
    ui.autoY = autoCb.checked;
    yMinIn.disabled = yMaxIn.disabled = ui.autoY;
    save();
    dirty = true;
  },
});
const yMinIn = h('input', { type: 'number', step: 'any', value: String(ui.yMin), disabled: ui.autoY, style: 'width: 70px' });
const yMaxIn = h('input', { type: 'number', step: 'any', value: String(ui.yMax), disabled: ui.autoY, style: 'width: 70px' });
for (const el of [yMinIn, yMaxIn])
  el.addEventListener('change', () => {
    ui.yMin = Number(yMinIn.value);
    ui.yMax = Number(yMaxIn.value);
    save();
    dirty = true;
  });
const stampCb = h('input', {
  type: 'checkbox',
  checked: ui.useStamp,
  onchange: () => {
    ui.useStamp = stampCb.checked;
    save();
    for (const s of series) {
      s.t = [];
      s.v = [];
    }
    for (const sub of subs.values()) sub.update({ useSourceTimestamp: ui.useStamp });
  },
});
const pauseBtn = h(
  'button',
  {
    class: 'secondary',
    onclick: () => {
      paused = !paused;
      pausedEnd = now();
      pauseBtn.textContent = paused ? 'Resume' : 'Pause';
      dirty = true;
    },
  },
  'Pause',
);
const legend = h('div', { class: 'row', style: 'flex-wrap: wrap; gap: 4px 14px; padding: 4px 8px; border-bottom: 1px solid var(--border); min-height: 26px' });
const canvas = h('canvas', { style: 'position: absolute; inset: 0; width: 100%; height: 100%; cursor: crosshair' });
const stage = h('div', { class: 'grow', style: 'position: relative' }, canvas);

app.append(
  statusBanner(),
  h(
    'div',
    { class: 'toolbar' },
    topicIn,
    topicsDl,
    fieldIn,
    fieldsDl,
    h('button', { onclick: () => addFromInputs() }, '+ Add'),
    h('span', { class: 'sep' }),
    winSel,
    h('label', null, autoCb, 'auto Y'),
    yMinIn,
    yMaxIn,
    h('label', { title: 'Use the DDS source timestamp as the time axis (else receive time)' }, stampCb, 'source time'),
    h('span', { class: 'sep' }),
    pauseBtn,
    h(
      'button',
      {
        class: 'secondary',
        onclick: () => {
          for (const s of series) {
            s.t = [];
            s.v = [];
          }
          dirty = true;
        },
      },
      'Clear',
    ),
    h('button', { class: 'secondary', title: 'Export visible data as CSV', onclick: () => exportCsv() }, 'CSV'),
  ),
  legend,
  stage,
);

// ---- field discovery ------------------------------------------------------
async function loadFields(topic: string): Promise<string[]> {
  clear(fieldsDl);
  if (!topic) return [];
  try {
    const info = await host.request<{ numericPaths: string[] }>('typeInfo', { topic });
    for (const p of info.numericPaths) fieldsDl.append(h('option', { value: p }));
    if (!fieldIn.value && info.numericPaths.length) fieldIn.placeholder = info.numericPaths.slice(0, 3).join(', ');
    return info.numericPaths;
  } catch (e) {
    toast(`${topic}: ${(e as Error).message}`, 'error');
    return [];
  }
}

function refreshTopicList(): void {
  clear(topicsDl);
  for (const t of host.graph?.topics ?? []) topicsDl.append(h('option', { value: t.name }, t.types[0]));
}

function addFromInputs(): void {
  const topic = topicIn.value.trim();
  const field = fieldIn.value.trim();
  if (!topic || !field) {
    toast('Enter a topic and a numeric field path', 'error');
    return;
  }
  addSeries(topic, field);
  fieldIn.value = '';
}

// ---- series / subscriptions -----------------------------------------------
function addSeries(topic: string, field: string, def?: Partial<SeriesDef>): void {
  field = field.replace(/^\./, '');
  if (series.some((s) => s.topic === topic && s.field === field)) {
    toast(`${topic}/${field} is already plotted`);
    return;
  }
  const used = new Set(series.map((s) => s.color));
  const color = def?.color ?? PALETTE.find((c) => !used.has(c)) ?? PALETTE[series.length % PALETTE.length];
  series.push({ topic, field, type: def?.type, color, visible: def?.visible ?? true, t: [], v: [] });
  syncSub(topic);
  renderLegend();
  save();
  dirty = true;
}

function removeSeries(s: Series): void {
  series.splice(series.indexOf(s), 1);
  syncSub(s.topic);
  renderLegend();
  save();
  dirty = true;
}

function syncSub(topic: string): void {
  const fields = series.filter((s) => s.topic === topic).map((s) => s.field);
  const cur = subs.get(topic);
  if (!fields.length) {
    cur?.close();
    subs.delete(topic);
    return;
  }
  if (cur) {
    cur.update({ fields });
    return;
  }
  const type = series.find((s) => s.topic === topic)?.type;
  subs.set(
    topic,
    host.subscribe(
      topic,
      'plot',
      { fields, useSourceTimestamp: ui.useStamp },
      (ev) => {
        if (ev.ev === 'subError' || (ev.ev === 'subInfo' && ev.state === 'error')) {
          toast(`${topic}: ${ev.error}`, 'error');
          return;
        }
        if (ev.ev !== 'plot') return;
        const flds = ev.fields as string[];
        const ts = ev.t as number[];
        const vs = ev.v as (number | null)[][];
        for (let k = 0; k < flds.length; k++) {
          const s = series.find((x) => x.topic === topic && x.field === flds[k]);
          if (!s) continue;
          for (let i = 0; i < ts.length; i++) {
            const val = vs[i][k];
            if (val === null || val === undefined) continue;
            s.t.push(ts[i]);
            s.v.push(val);
            s.last = val;
          }
          trim(s);
        }
        dirty = true;
      },
      type,
    ),
  );
}

function trim(s: Series): void {
  const cutoff = (s.t[s.t.length - 1] ?? 0) - 300;
  let drop = 0;
  while (drop < s.t.length && s.t[drop] < cutoff) drop++;
  drop = Math.max(drop, s.t.length - MAX_POINTS);
  if (drop > 0) {
    s.t.splice(0, drop);
    s.v.splice(0, drop);
  }
}

function renderLegend(): void {
  clear(legend);
  if (!series.length) legend.append(h('span', { class: 'muted' }, 'Add a topic field above, or use 📈 in the Topic Monitor message tree.'));
  for (const s of series) {
    const val = h('span', { class: 'mono muted', style: 'font-size: 11px' });
    s.last !== undefined && (val.textContent = s.last.toPrecision(5));
    const item = h(
      'span',
      {
        class: 'row',
        style: `gap: 4px; cursor: pointer; opacity: ${s.visible ? 1 : 0.45}`,
        title: 'Click to show/hide',
        onclick: () => {
          s.visible = !s.visible;
          save();
          renderLegend();
          dirty = true;
        },
      },
      h('span', { class: 'legend-swatch', style: `background: ${s.color}` }),
      h('span', { class: 'mono', style: 'font-size: 12px' }, `${s.topic}/${s.field}`),
      val,
      h(
        'button',
        {
          class: 'icon',
          title: 'Remove',
          onclick: (e: Event) => {
            e.stopPropagation();
            removeSeries(s);
          },
        },
        '✕',
      ),
    );
    (item as HTMLElement & { _val?: HTMLElement })._val = val;
    legend.append(item);
  }
}

setInterval(() => {
  // cheap in-place update of the legend values
  const items = legend.children;
  for (let i = 0; i < series.length && i < items.length; i++) {
    const v = (items[i] as HTMLElement & { _val?: HTMLElement })._val;
    const s = series[i];
    if (v && s.last !== undefined) v.textContent = s.last.toPrecision(5);
  }
}, 250);

// ---- drawing --------------------------------------------------------------
function now(): number {
  if (ui.useStamp) {
    let m = 0;
    for (const s of series) if (s.t.length) m = Math.max(m, s.t[s.t.length - 1]);
    return m || Date.now() / 1000;
  }
  return Date.now() / 1000;
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const norm = step0 / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return out;
}

function lowerBound(a: number[], x: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (a[m] < x) lo = m + 1;
    else hi = m;
  }
  return lo;
}

const fg = themeColor('--vscode-editor-foreground', '#d4d4d4');
const muted = themeColor('--vscode-descriptionForeground', '#8b949e');
const gridC = themeColor('--vscode-panel-border', '#333333');
const font = `11px ${themeColor('--vscode-editor-font-family', 'monospace')}`;

function draw(): void {
  const dpr = window.devicePixelRatio || 1;
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.font = font;
  const L = 64;
  const R = 12;
  const T = 10;
  const B = 26;
  const pw = Math.max(10, W - L - R);
  const ph = Math.max(10, H - T - B);
  const tEnd = paused ? pausedEnd : now();
  const tStart = tEnd - ui.window;

  // y range
  let yLo = Infinity;
  let yHi = -Infinity;
  const ranges = new Map<Series, [number, number]>();
  for (const s of series) {
    if (!s.visible || !s.t.length) continue;
    const i0 = Math.max(0, lowerBound(s.t, tStart) - 1);
    const i1 = Math.min(s.t.length, lowerBound(s.t, tEnd) + 1);
    ranges.set(s, [i0, i1]);
    if (ui.autoY)
      for (let i = i0; i < i1; i++) {
        const v = s.v[i];
        if (v < yLo) yLo = v;
        if (v > yHi) yHi = v;
      }
  }
  if (!ui.autoY) {
    yLo = ui.yMin;
    yHi = ui.yMax;
  }
  if (!Number.isFinite(yLo) || !Number.isFinite(yHi)) {
    yLo = -1;
    yHi = 1;
  }
  if (yHi - yLo < 1e-12) {
    const c = yLo;
    const d = Math.max(Math.abs(c) * 0.1, 0.5);
    yLo = c - d;
    yHi = c + d;
  } else if (ui.autoY) {
    const pad = (yHi - yLo) * 0.06;
    yLo -= pad;
    yHi += pad;
  }
  const X = (t: number) => L + ((t - tStart) / ui.window) * pw;
  const Y = (v: number) => T + (1 - (v - yLo) / (yHi - yLo)) * ph;

  // grid + axes
  ctx.strokeStyle = gridC;
  ctx.fillStyle = muted;
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of niceTicks(yLo, yHi, Math.max(2, Math.floor(ph / 40)))) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(L, y);
    ctx.lineTo(L + pw, y);
    ctx.stroke();
    ctx.fillText(Math.abs(v) >= 1e5 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(1) : String(+v.toPrecision(6)), L - 6, y);
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const dt of niceTicks(-ui.window, 0, Math.max(2, Math.floor(pw / 90)))) {
    const x = Math.round(X(tEnd + dt)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, T);
    ctx.lineTo(x, T + ph);
    ctx.stroke();
    ctx.fillText(dt === 0 ? '0 s' : `${+dt.toPrecision(4)} s`, x, T + ph + 6);
  }
  ctx.strokeStyle = muted;
  ctx.strokeRect(L + 0.5, T + 0.5, pw, ph);

  // series (min/max decimation per pixel column)
  ctx.save();
  ctx.beginPath();
  ctx.rect(L, T, pw, ph);
  ctx.clip();
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  for (const s of series) {
    const r = ranges.get(s);
    if (!r) continue;
    const [i0, i1] = r;
    ctx.strokeStyle = s.color;
    ctx.beginPath();
    const n = i1 - i0;
    if (n <= pw * 2) {
      for (let i = i0; i < i1; i++) {
        const x = X(s.t[i]);
        const y = Y(s.v[i]);
        if (i === i0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
    } else {
      let col = -1;
      let mn = 0;
      let mx = 0;
      let first = true;
      for (let i = i0; i < i1; i++) {
        const c = Math.floor(X(s.t[i]));
        const v = s.v[i];
        if (c !== col) {
          if (col >= 0) {
            if (first) {
              ctx.moveTo(col, Y(mn));
              first = false;
            } else ctx.lineTo(col, Y(mn));
            ctx.lineTo(col, Y(mx));
          }
          col = c;
          mn = mx = v;
        } else {
          if (v < mn) mn = v;
          if (v > mx) mx = v;
        }
      }
      if (col >= 0) {
        ctx.lineTo(col, Y(mn));
        ctx.lineTo(col, Y(mx));
      }
    }
    ctx.stroke();
  }
  ctx.restore();

  // hover readout
  if (hoverX !== undefined && hoverX >= L && hoverX <= L + pw) {
    const t = tStart + ((hoverX - L) / pw) * ui.window;
    ctx.strokeStyle = fg;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(hoverX + 0.5, T);
    ctx.lineTo(hoverX + 0.5, T + ph);
    ctx.stroke();
    ctx.globalAlpha = 1;
    const lines: [string, string][] = [['', `t = ${(t - tEnd).toFixed(3)} s`]];
    for (const s of series) {
      if (!s.visible || !s.t.length) continue;
      let i = lowerBound(s.t, t);
      if (i >= s.t.length) i = s.t.length - 1;
      if (i > 0 && Math.abs(s.t[i - 1] - t) < Math.abs(s.t[i] - t)) i--;
      if (Math.abs(s.t[i] - t) > ui.window / 20) continue;
      lines.push([s.color, `${s.field}: ${+s.v[i].toPrecision(6)}`]);
      ctx.fillStyle = s.color;
      ctx.beginPath();
      ctx.arc(X(s.t[i]), Y(s.v[i]), 3, 0, Math.PI * 2);
      ctx.fill();
    }
    const bw = Math.max(...lines.map(([, l]) => ctx.measureText(l).width)) + 22;
    const bx = hoverX + 12 + bw > L + pw ? hoverX - 12 - bw : hoverX + 12;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(bx, T + 6, bw, lines.length * 16 + 6);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach(([c, l], k) => {
      if (c) {
        ctx.fillStyle = c;
        ctx.fillRect(bx + 6, T + 13 + k * 16, 8, 8);
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(l, bx + (c ? 18 : 6), T + 10 + k * 16);
    });
  }
  if (!series.length) {
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    ctx.fillText('No series', L + pw / 2, T + ph / 2);
  }
}

function loop(): void {
  requestAnimationFrame(loop);
  if (!paused || dirty) {
    dirty = false;
    draw();
  }
}
loop();
canvas.addEventListener('mousemove', (e) => {
  hoverX = e.clientX - canvas.getBoundingClientRect().left;
  dirty = true;
});
canvas.addEventListener('mouseleave', () => {
  hoverX = undefined;
  dirty = true;
});
new ResizeObserver(() => (dirty = true)).observe(stage);

function exportCsv(): void {
  const tEnd = paused ? pausedEnd : now();
  const tStart = tEnd - ui.window;
  const rows = ['series,time,value'];
  for (const s of series) {
    for (let i = 0; i < s.t.length; i++) if (s.t[i] >= tStart && s.t[i] <= tEnd) rows.push(`${s.topic}/${s.field},${s.t[i].toFixed(6)},${s.v[i]}`);
  }
  host.saveFile('plot.csv', rows.join('\n'), { CSV: ['csv'] });
}

// ---- wiring ---------------------------------------------------------------
function handleArgs(args: Record<string, unknown>): void {
  const topic = typeof args.topic === 'string' ? args.topic : '';
  const field = typeof args.field === 'string' ? args.field : '';
  if (topic && field) addSeries(topic, field, { type: args.type as string | undefined });
  else if (topic) {
    topicIn.value = topic;
    void loadFields(topic).then((paths) => {
      if (paths.length === 1) addSeries(topic, paths[0]);
      else fieldIn.focus();
    });
  }
}

host.on('graph', () => refreshTopicList());
host.on('init', (args) => {
  refreshTopicList();
  for (const d of ui.series) addSeries(d.topic, d.field, d);
  handleArgs(args);
  renderLegend();
});
host.on('args', handleArgs);
host.start();
