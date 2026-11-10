import './common/base.css';
import './common/graph.css';
import type { DdsEndpoint, DdsTopic, TopicStats } from '../shared/protocol';
import { host, Subscription } from './common/host';
import { MsgTree, toYaml } from './common/msgtree';
import { clear, fmtBw, fmtBytes, fmtHz, fmtSec, h, statusBanner, toast } from './common/ui';

interface Ui {
  monitored: string[];
  filter: string;
  arrayLimit: number;
  rate: number;
  sort: 'name' | 'type' | 'hz' | 'bw';
  hideRos: boolean;
}
const ui = host.loadState<Ui>({ monitored: [], filter: '', arrayLimit: 64, rate: 10, sort: 'name', hideRos: true });
const save = () => host.saveState(ui);
const ROS_INTERNAL = /^(rt\/rosout|rt\/parameter_events|ros_discovery_info|rq\/|rr\/|rt\/.*\/_action\/)/;
const BAD = '#f14c4c';

interface Row {
  tr: HTMLTableRowElement;
  cb: HTMLInputElement;
  hz: HTMLTableCellElement;
  bw: HTMLTableCellElement;
  size: HTMLTableCellElement;
}
const rows = new Map<string, Row>();
const statsSubs = new Map<string, Subscription>();
let selected = '';
let echoSub: Subscription | undefined;
let paused = false;
let instances = new Map<number, unknown>();
let shownInstance = -1; // -1 = latest of any instance
let lastMsg: unknown;
let msgCount = 0;

// ---- layout ---------------------------------------------------------------
const app = document.getElementById('app')!;
const filterInput = h('input', {
  type: 'search',
  placeholder: 'Filter topics or types (substring or /regex/)',
  value: ui.filter,
  style: 'width: 280px',
  oninput: () => {
    ui.filter = filterInput.value;
    save();
    applyFilter();
  },
});
const countLabel = h('span', { class: 'muted' });
const rosCb = h('input', {
  type: 'checkbox',
  checked: ui.hideRos,
  onchange: () => {
    ui.hideRos = rosCb.checked;
    save();
    renderTable();
  },
});
const tbody = h('tbody');
function sortTh(label: string, key: Ui['sort'], num = false): HTMLTableCellElement {
  return h(
    'th',
    {
      class: `sortable${num ? ' num' : ''}`,
      onclick: () => {
        ui.sort = key;
        save();
        renderTable();
      },
    },
    label,
  );
}
const table = h(
  'table',
  { class: 'grid' },
  h(
    'thead',
    null,
    h(
      'tr',
      null,
      h('th', { title: 'Measure rate and bandwidth' }, '◉'),
      sortTh('Topic', 'name'),
      sortTh('Type', 'type'),
      h('th', { class: 'num', title: 'writers' }, 'W'),
      h('th', { class: 'num', title: 'readers' }, 'R'),
      sortTh('Hz', 'hz', true),
      sortTh('Bandwidth', 'bw', true),
      h('th', { class: 'num' }, 'Size'),
    ),
  ),
  tbody,
);
const left = h('div', { class: 'scroll', style: 'flex: 0 0 55%; min-width: 280px' }, table);
const detail = h('div', { class: 'scroll grow', style: 'padding: 8px 12px' });
const splitter = h('div', { class: 'splitter' });
const body = h('div', { class: 'row grow', style: 'align-items: stretch; gap: 0' }, left, splitter, detail);
app.append(
  statusBanner(),
  h(
    'div',
    { class: 'toolbar' },
    filterInput,
    h('button', { class: 'secondary', title: 'Measure every visible topic', onclick: () => setAll(true) }, 'Monitor all'),
    h('button', { class: 'secondary', onclick: () => setAll(false) }, 'None'),
    h('label', { title: 'Hide rt/rosout, rt/parameter_events, ros_discovery_info, ROS services and actions' }, rosCb, 'Hide ROS 2 internals'),
    h('span', { class: 'grow' }),
    countLabel,
  ),
  body,
);
let dragging = false;
splitter.addEventListener('mousedown', (e) => {
  dragging = true;
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  const r = body.getBoundingClientRect();
  left.style.flex = `0 0 ${Math.min(85, Math.max(20, ((e.clientX - r.left) / r.width) * 100))}%`;
});
window.addEventListener('mouseup', () => (dragging = false));
renderDetailEmpty();

// ---- table ----------------------------------------------------------------
function matches(name: string, type: string): boolean {
  const f = ui.filter.trim();
  if (!f) return true;
  if (f.length > 2 && f.startsWith('/') && f.endsWith('/')) {
    try {
      return new RegExp(f.slice(1, -1)).test(name) || new RegExp(f.slice(1, -1)).test(type);
    } catch {
      return true;
    }
  }
  const lf = f.toLowerCase();
  return name.toLowerCase().includes(lf) || type.toLowerCase().includes(lf);
}

function applyFilter(): void {
  let shown = 0;
  for (const [name, r] of rows) {
    const vis = matches(name, r.tr.dataset.type ?? '');
    r.tr.classList.toggle('hidden', !vis);
    if (vis) shown++;
  }
  countLabel.textContent = `${shown} / ${rows.size} topics`;
}

function sortedTopics(): DdsTopic[] {
  let topics = [...(host.graph?.topics ?? [])];
  if (ui.hideRos) topics = topics.filter((t) => !ROS_INTERNAL.test(t.name));
  const st = host.stats;
  switch (ui.sort) {
    case 'type':
      return topics.sort((a, b) => (a.types[0] ?? '').localeCompare(b.types[0] ?? '') || a.name.localeCompare(b.name));
    case 'hz':
      return topics.sort((a, b) => (st[b.name]?.hz ?? -1) - (st[a.name]?.hz ?? -1));
    case 'bw':
      return topics.sort((a, b) => (st[b.name]?.bw ?? -1) - (st[a.name]?.bw ?? -1));
    default:
      return topics.sort((a, b) => a.name.localeCompare(b.name));
  }
}

function renderTable(): void {
  rows.clear();
  clear(tbody);
  const bad = new Set((host.graph?.incompatible ?? []).map((i) => i.topic));
  for (const t of sortedTopics()) {
    const cb = h('input', {
      type: 'checkbox',
      checked: statsSubs.has(t.name),
      onclick: (e: Event) => e.stopPropagation(),
      onchange: () => setMonitored(t.name, cb.checked),
    });
    const r: Row = {
      tr: h('tr', { onclick: () => select(t.name) }),
      cb,
      hz: h('td', { class: 'num' }, '—'),
      bw: h('td', { class: 'num' }, '—'),
      size: h('td', { class: 'num' }, '—'),
    };
    r.tr.dataset.type = t.types.join(',');
    r.tr.append(
      h('td', null, cb),
      h('td', { class: 'mono', title: bad.has(t.name) ? 'QoS mismatch between a writer and a reader' : t.name }, bad.has(t.name) ? h('span', { style: `color: ${BAD}` }, '✕ ') : '', t.name),
      h('td', { class: 'muted ellipsis', title: t.types.join(', ') }, t.types.join(', ')),
      h('td', { class: 'num' }, String(t.writers.length)),
      h('td', { class: 'num' }, String(t.readers.length)),
      r.hz,
      r.bw,
      r.size,
    );
    if (t.name === selected) r.tr.classList.add('selected');
    rows.set(t.name, r);
    tbody.append(r.tr);
  }
  applyFilter();
  updateStats(host.stats);
}

function updateStats(stats: Record<string, TopicStats>): void {
  for (const [name, r] of rows) {
    const s = stats[name];
    r.hz.textContent = s ? fmtHz(s.hz) : '—';
    r.bw.textContent = s ? fmtBw(s.bw) : '—';
    r.size.textContent = s && s.size ? fmtBytes(s.size) : '—';
    r.hz.classList.toggle('warn', !!s && !!s.stale);
  }
  if (selected) renderStats(stats[selected]);
}

function setMonitored(topic: string, on: boolean): void {
  const cur = statsSubs.get(topic);
  if (on && !cur) {
    statsSubs.set(topic, host.subscribe(topic, 'stats', {}, () => undefined));
    if (!ui.monitored.includes(topic)) ui.monitored.push(topic);
  } else if (!on && cur) {
    cur.close();
    statsSubs.delete(topic);
    ui.monitored = ui.monitored.filter((t) => t !== topic);
  }
  const r = rows.get(topic);
  if (r) r.cb.checked = on;
  save();
}

function setAll(on: boolean): void {
  for (const [name, r] of rows) if (!r.tr.classList.contains('hidden') || !on) setMonitored(name, on);
}

// ---- detail ---------------------------------------------------------------
let statsBox: HTMLElement | undefined;
let infoBox: HTMLElement | undefined;
let stateBox: HTMLElement | undefined;
let instSel: HTMLSelectElement | undefined;
const tree = new MsgTree({
  leafActionTitle: 'Plot this field',
  onLeaf: (path) => host.command('ddsVis.openPlot', { topic: selected, field: path }),
});

function renderDetailEmpty(): void {
  clear(detail);
  detail.append(h('div', { class: 'empty' }, 'Select a topic to see its writers, readers, QoS, statistics and live samples.'));
}

function select(topic: string): void {
  if (topic === selected) return;
  rows.get(selected)?.tr.classList.remove('selected');
  selected = topic;
  rows.get(topic)?.tr.classList.add('selected');
  host.args.topic = topic;
  save();
  echoSub?.close();
  echoSub = undefined;
  lastMsg = undefined;
  instances = new Map();
  shownInstance = -1;
  msgCount = 0;
  paused = false;
  tree.clear();
  renderDetail();
  startEcho();
}

function instanceLabel(handle: number, msg: unknown): string {
  const scalars = Object.entries((msg as Record<string, unknown>) ?? {})
    .filter(([, v]) => typeof v !== 'object')
    .slice(0, 2)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`);
  return scalars.length ? scalars.join(', ') : `instance ${handle}`;
}

function renderInstances(): void {
  if (!instSel) return;
  instSel.classList.toggle('hidden', instances.size <= 1);
  const sig = [...instances.keys()].join(',') + '#' + shownInstance;
  if (instSel.dataset.sig === sig) return;
  instSel.dataset.sig = sig;
  clear(instSel);
  instSel.append(h('option', { value: '-1', selected: shownInstance === -1 }, `latest of ${instances.size} instances`));
  for (const [hd, msg] of instances) instSel.append(h('option', { value: String(hd), selected: hd === shownInstance }, instanceLabel(hd, msg)));
}

function startEcho(): void {
  echoSub?.close();
  if (!selected) return;
  echoSub = host.subscribe(selected, 'json', { maxRate: ui.rate, arrayLimit: ui.arrayLimit }, (ev) => {
    if (ev.ev === 'subInfo') {
      renderState(String(ev.state), ev.error as string | null, ev.qos as string | null);
      return;
    }
    if (ev.ev === 'subError') {
      renderState('error', String(ev.error), null);
      return;
    }
    if (ev.ev !== 'msg') return;
    msgCount++;
    const handle = Number(ev.instance ?? 0);
    instances.set(handle, ev.msg);
    renderInstances();
    if (shownInstance !== -1 && handle !== shownInstance) return;
    lastMsg = ev.msg;
    if (!paused) tree.set(ev.msg);
  });
}

function renderState(state: string, error: string | null, qos: string | null): void {
  if (!stateBox) return;
  const text: Record<string, string> = {
    waiting: 'Waiting for a writer or reader of this topic…',
    resolving: 'Resolving the data type through XTypes type lookup…',
    ready: `Reading samples (reader QoS ${qos ?? ''})`,
    error: error ?? 'error',
  };
  stateBox.textContent = text[state] ?? state;
  stateBox.className = state === 'error' ? 'err' : 'muted';
}

function qosCells(e: DdsEndpoint): HTMLElement[] {
  const q = e.qos;
  return [
    h('td', null, q.reliability),
    h('td', null, q.durability),
    h('td', null, q.history),
    h('td', null, q.partitions.length ? q.partitions.join(', ') : h('span', { class: 'muted' }, 'default')),
    h('td', null, q.ownership),
    h('td', null, q.deadline),
    h('td', { title: q.liveliness }, q.liveliness.split(',')[0]),
  ];
}

async function renderEndpoints(): Promise<void> {
  if (!selected || !infoBox) return;
  const g = host.graph;
  if (!g) return;
  const topic = selected;
  const t = g.topics.find((x) => x.name === topic);
  clear(infoBox);
  if (!t) {
    infoBox.append(h('div', { class: 'muted' }, 'Topic not discovered (any more).'));
    return;
  }
  const eps = new Map(g.endpoints.map((e) => [e.key, e]));
  const label = (k: string) => g.participants.find((p) => p.key === k)?.label ?? k;
  const bad = g.incompatible.filter((i) => i.topic === topic);
  for (const i of bad) {
    infoBox.append(
      h(
        'div',
        { class: 'warnbox', style: 'border-left-color: ' + BAD },
        h('b', null, `QoS mismatch: ${label(eps.get(i.writer)?.participant ?? '')} (writer) → ${label(eps.get(i.reader)?.participant ?? '')} (reader)`),
        ...i.reasons.map((r) => h('div', null, r)),
      ),
    );
  }
  const tbl = h(
    'table',
    { class: 'grid' },
    h(
      'thead',
      null,
      h('tr', null, ...['', 'Participant', 'Reliability', 'Durability', 'History', 'Partition', 'Ownership', 'Deadline', 'Liveliness'].map((x) => h('th', null, x))),
    ),
  );
  const tb = h('tbody');
  for (const key of [...t.writers, ...t.readers]) {
    const e = eps.get(key);
    if (!e) continue;
    const isBad = bad.some((i) => i.reader === key || i.writer === key);
    tb.append(
      h(
        'tr',
        { title: `${e.kind} ${e.name}\n${e.type}${e.hasTypeInfo ? '' : '\n(no XTypes type information)'}\nGUID ${e.key}` },
        h('td', null, h('span', { class: `badge ${e.kind === 'writer' ? 'info' : 'ok'}` }, e.kind === 'writer' ? 'W' : 'R')),
        h('td', { class: 'mono', style: isBad ? `color: ${BAD}` : '' }, `${isBad ? '✕ ' : ''}${label(e.participant)}${e.name ? ` / ${e.name}` : ''}`),
        ...qosCells(e),
      ),
    );
  }
  tbl.append(tb);
  infoBox.append(h('div', { class: 'section-title' }, `Endpoints · ${t.writers.length} writers · ${t.readers.length} readers`), h('div', { class: 'scroll' }, tbl));
}

function renderDetail(): void {
  clear(detail);
  const types = host.topicTypes(selected);
  const ros = /::dds_::/.test(types[0] ?? '') ? `ROS 2: ${selected.replace(/^r[tqr]/, '')} (${(types[0] ?? '').replace('::dds_::', '::').replace(/_$/, '').replace(/::/g, '/')})` : '';
  const pauseBtn = h(
    'button',
    {
      class: 'secondary',
      onclick: () => {
        paused = !paused;
        pauseBtn.textContent = paused ? 'Resume' : 'Pause';
        if (!paused && lastMsg !== undefined) tree.set(lastMsg);
      },
    },
    'Pause',
  );
  const rateSel = h(
    'select',
    {
      title: 'Display rate',
      onchange: () => {
        ui.rate = Number(rateSel.value);
        save();
        echoSub?.update({ maxRate: ui.rate });
      },
    },
    ...[1, 2, 5, 10, 30, 0].map((r) => h('option', { value: String(r), selected: r === ui.rate }, r ? `${r} Hz` : 'all')),
  );
  const limitIn = h('input', {
    type: 'number',
    min: '1',
    value: String(ui.arrayLimit),
    title: 'Max array items shown',
    style: 'width: 64px',
    onchange: () => {
      ui.arrayLimit = Math.max(1, Number(limitIn.value) || 64);
      save();
      echoSub?.update({ arrayLimit: ui.arrayLimit });
    },
  });
  instSel = h('select', {
    class: 'hidden',
    title: 'Keyed topic: choose an instance',
    onchange: () => {
      shownInstance = Number(instSel!.value);
      const m = shownInstance === -1 ? lastMsg : instances.get(shownInstance);
      if (m !== undefined) tree.set(m);
    },
  });
  const idlPre = h('pre', { class: 'mono', style: 'white-space: pre; overflow: auto; margin: 4px 0' }, 'loading…');
  const idl = h(
    'details',
    null,
    h('summary', { class: 'muted', style: 'cursor: pointer; margin-top: 6px' }, 'IDL'),
    idlPre,
  );
  idl.addEventListener('toggle', () => {
    if (!idl.open || idlPre.dataset.loaded) return;
    idlPre.dataset.loaded = '1';
    host
      .request<{ idl: string }>('typeInfo', { topic: selected })
      .then((r) => (idlPre.textContent = r.idl))
      .catch((e: Error) => (idlPre.textContent = `// ${e.message}`));
  });
  statsBox = h('div', { class: 'kv' });
  infoBox = h('div');
  stateBox = h('div', { class: 'muted' }, 'Subscribing…');
  detail.append(
    h('div', { class: 'row', style: 'flex-wrap: wrap' }, h('h3', { class: 'mono', style: 'margin: 4px 0' }, selected), ...types.map((t) => h('span', { class: 'badge' }, t))),
    ros ? h('div', { class: 'muted', style: 'font-size: 12px' }, ros) : '',
    h(
      'div',
      { class: 'row', style: 'flex-wrap: wrap; margin: 6px 0' },
      h('button', { class: 'secondary', onclick: () => host.command('ddsVis.openPlot', { topic: selected }) }, '📈 Plot'),
      h('button', { class: 'secondary', onclick: () => host.command('ddsVis.showType', { topic: selected }) }, '{ } IDL in editor'),
    ),
    idl,
    h('div', { class: 'section-title' }, 'Statistics'),
    statsBox,
    infoBox,
    h('div', { class: 'section-title' }, 'Sample'),
    stateBox,
    h(
      'div',
      { class: 'row', style: 'flex-wrap: wrap; margin: 6px 0' },
      pauseBtn,
      rateSel,
      h('label', null, 'array items', limitIn),
      instSel,
      h('button', { class: 'icon', title: 'Expand all', onclick: () => tree.expandAll(true) }, '⊞'),
      h('button', { class: 'icon', title: 'Collapse all', onclick: () => tree.expandAll(false) }, '⊟'),
      h('button', { class: 'icon', title: 'Copy as YAML', onclick: () => lastMsg !== undefined && (host.copy(toYaml(lastMsg)), toast('Copied YAML', 'ok')) }, 'YAML'),
      h('button', { class: 'icon', title: 'Copy as JSON', onclick: () => lastMsg !== undefined && (host.copy(JSON.stringify(lastMsg, null, 2)), toast('Copied JSON', 'ok')) }, 'JSON'),
    ),
    tree.el,
  );
  renderStats(host.stats[selected]);
  void renderEndpoints();
}

function renderStats(s: TopicStats | undefined): void {
  if (!statsBox) return;
  clear(statsBox);
  const kv = (k: string, v: string, cls = '') => statsBox!.append(h('span', null, k), h('span', { class: `mono ${cls}` }, v));
  if (!s) {
    kv('Rate', 'waiting…');
    return;
  }
  kv('Rate', s.stale ? `${fmtHz(s.hz)} Hz (no recent samples)` : `${fmtHz(s.hz)} Hz`, s.stale ? 'warn' : '');
  kv('Period', s.mean !== undefined ? `mean ${fmtSec(s.mean)} · min ${fmtSec(s.min)} · max ${fmtSec(s.max)} · σ ${fmtSec(s.std)}` : '—');
  kv('Bandwidth', `${fmtBw(s.bw)} · avg sample ${fmtBytes(s.size)} (serialized)`);
  if (s.delay !== undefined) kv('Latency (now − source timestamp)', `${fmtSec(s.delay)} · avg ${fmtSec(s.delayAvg)}`);
  kv('Received', `${s.count} samples${s.age !== null ? ` · last ${fmtSec(s.age)} ago` : ''}${msgCount ? ` · ${msgCount} shown` : ''}`);
}

// ---- wiring ---------------------------------------------------------------
host.on('init', (args) => {
  for (const t of ui.monitored) setMonitored(t, true);
  renderTable();
  if (typeof args.topic === 'string') select(args.topic);
});
host.on('args', (args) => {
  if (typeof args.topic === 'string') {
    select(args.topic);
    rows.get(args.topic)?.tr.scrollIntoView({ block: 'center' });
  }
});
let graphSig = '';
host.on('graph', (g) => {
  const sig = JSON.stringify([g.topics, g.incompatible.map((i) => i.writer + i.reader)]);
  if (sig === graphSig) return;
  graphSig = sig;
  renderTable();
  if (selected) void renderEndpoints();
});
host.on('stats', (s) => updateStats(s));
host.start();
