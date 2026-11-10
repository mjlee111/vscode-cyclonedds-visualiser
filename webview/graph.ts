import './common/base.css';
import './common/graph.css';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import type { DdsEndpoint, DdsGraph, DdsParticipant } from '../shared/protocol';
import { host, Subscription } from './common/host';
import { graphPalette, GraphPalette, onThemeChange } from './common/theme';
import { clear, debounce, fmtHz, h, statusBanner, toast } from './common/ui';

cytoscape.use(dagre);

type Mode = 'participants' | 'active' | 'all';
interface Ui {
  mode: Mode;
  rankdir: 'LR' | 'TB';
  hideRos: boolean;
  hideDeadSinks: boolean;
  hideLeaf: boolean;
  groupHost: boolean;
  showHz: boolean;
  legend: boolean;
  filter: string;
}
const ui = host.loadState<Ui>({
  mode: 'all',
  rankdir: 'LR',
  hideRos: true,
  hideDeadSinks: false,
  hideLeaf: false,
  groupHost: false,
  showHz: false,
  legend: true,
  filter: '',
});
const save = () => host.saveState(ui);

/** ROS 2 infrastructure topics (rmw mapping): logging, parameters, discovery, services, actions. */
const ROS_INTERNAL = /^(rt\/rosout|rt\/parameter_events|ros_discovery_info|rq\/|rr\/|rt\/.*\/_action\/)/;
const MODE_LABEL: Record<Mode, [string, string]> = {
  participants: ['Participants', 'Participants only; edges carry the connecting topics'],
  active: ['Active', 'Participants + topics that have both a writer and a reader'],
  all: ['All topics', 'Participants + every topic (one-sided topics drawn dashed)'],
};

// ---- toolbar --------------------------------------------------------------
const app = document.getElementById('app')!;
const modeBtns = new Map<Mode, HTMLButtonElement>();
const seg = h('div', { class: 'seg' });
for (const m of ['participants', 'active', 'all'] as Mode[]) {
  const b = h('button', { title: MODE_LABEL[m][1], onclick: () => setMode(m) }, MODE_LABEL[m][0]);
  modeBtns.set(m, b);
  seg.append(b);
}
const dirBtn = h('button', {
  class: 'tb-btn',
  title: 'Layout direction',
  onclick: () => {
    ui.rankdir = ui.rankdir === 'LR' ? 'TB' : 'LR';
    save();
    renderToolbar();
    applyStyle();
    runLayout(true);
  },
});
const filtersBtn = h('button', { class: 'tb-btn', title: 'Filters and display options' });
const searchIn = h('input', {
  type: 'search',
  placeholder: 'Filter: topic, participant, -exclude, regex',
  value: ui.filter,
  style: 'width: 240px',
  title: 'Comma separated terms matched against participant labels and topic names; prefix with - to exclude',
});
searchIn.addEventListener(
  'input',
  debounce(() => {
    ui.filter = searchIn.value;
    save();
    rebuild(true);
  }, 250),
);
const popover = h('div', { class: 'popover hidden' });
function popCheck(key: keyof Ui, label: string, hint: string, after: () => void): HTMLLabelElement {
  const cb = h('input', {
    type: 'checkbox',
    checked: ui[key] as boolean,
    onchange: () => {
      (ui as unknown as Record<string, unknown>)[key] = cb.checked;
      save();
      renderToolbar();
      after();
    },
  });
  return h('label', null, cb, h('span', null, label, h('small', null, hint)));
}
popover.append(
  h('div', { class: 'pop-title' }, 'Hide'),
  popCheck('hideRos', 'ROS 2 internals', 'rt/rosout, rt/parameter_events, ros_discovery_info, services (rq/, rr/), actions', () => rebuild(true)),
  popCheck('hideDeadSinks', 'Dead sinks', 'topics without readers', () => rebuild(true)),
  popCheck('hideLeaf', 'Unfed topics', 'topics without writers', () => rebuild(true)),
  h('div', { class: 'pop-title', style: 'margin-top: 6px' }, 'Display'),
  popCheck('groupHost', 'Group by host', 'draw each host as a box', () => rebuild(true)),
  popCheck('showHz', 'Topic rates', 'measure the rate of every shown topic (subscribes to them)', () => {
    syncHzSubs();
    updateLabels();
  }),
  popCheck('legend', 'Legend', 'show the legend in the corner', () => (legendChip.style.display = ui.legend ? '' : 'none')),
);
filtersBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = popover.classList.toggle('hidden') === false;
  filtersBtn.classList.toggle('open', open);
  if (open) {
    const r = filtersBtn.getBoundingClientRect();
    popover.style.left = `${r.left}px`;
    popover.style.top = `${r.bottom + 4}px`;
  }
});
document.addEventListener('click', (e) => {
  if (!popover.contains(e.target as Node) && e.target !== filtersBtn) {
    popover.classList.add('hidden');
    filtersBtn.classList.remove('open');
  }
});
function renderToolbar(): void {
  for (const [m, b] of modeBtns) b.classList.toggle('on', m === ui.mode);
  dirBtn.textContent = ui.rankdir === 'LR' ? '⇢ Left to right' : '⇣ Top to bottom';
  const n = [ui.hideRos, ui.hideDeadSinks, ui.hideLeaf, ui.groupHost, ui.showHz].filter(Boolean).length;
  filtersBtn.replaceChildren('Filters', h('span', { class: 'count-badge' }, String(n)), ' ▾');
}

const cyBox = h('div', { class: 'canvas-box grow' });
const statsChip = h('div', { class: 'chip', style: 'left: 10px; bottom: 10px' });
const legendChip = h('div', { class: 'chip', style: 'right: 10px; bottom: 10px' });
const notice = h('div', { class: 'notice hidden' });
const side = h('div', { class: 'side-panel scroll hidden' });
legendChip.style.display = ui.legend ? '' : 'none';
legendChip.append(
  h('span', { class: 'legend-item' }, h('span', { class: 'lg-node' }), 'participant'),
  h('span', { class: 'legend-item' }, h('span', { class: 'lg-topic' }), 'topic'),
  h('span', { class: 'legend-item', title: 'topic without writer or without reader' }, h('span', { class: 'lg-topic dashed' }), 'one-sided'),
  h('span', { class: 'legend-item', title: 'reader that cannot match the writers (QoS, partition or type)' }, h('span', { class: 'lg-bad' }), 'QoS mismatch'),
);
app.append(
  statusBanner(),
  h(
    'div',
    { class: 'toolbar' },
    seg,
    dirBtn,
    filtersBtn,
    searchIn,
    h('span', { class: 'grow' }),
    h('button', { class: 'tb-btn', title: 'Re-run layout', onclick: () => runLayout(true) }, '⟳ Layout'),
    h('button', { class: 'tb-btn', title: 'Fit to view', onclick: () => fit() }, '⤢ Fit'),
    h('button', { class: 'tb-btn', title: 'Save as PNG', onclick: () => savePng() }, '⤓ PNG'),
  ),
  h('div', { class: 'row grow', style: 'align-items: stretch; gap: 0' }, cyBox, side),
  popover,
);
renderToolbar();

// ---- cytoscape ------------------------------------------------------------
let P: GraphPalette = graphPalette();
const BAD = '#f14c4c';

function stylesheet(): cytoscape.Stylesheet[] {
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'font-family': P.font,
        'font-size': 12,
        color: P.fg,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': '260px',
        width: 'label',
        height: 'label',
        'min-zoomed-font-size': 5,
      } as cytoscape.Css.Node,
    },
    {
      selector: 'node.part',
      style: {
        shape: 'round-rectangle',
        'corner-radius': '14',
        'background-color': P.nodeFill,
        'border-width': 1.5,
        'border-color': P.accent,
        'font-weight': 600,
        'padding-left': '14px',
        'padding-right': '14px',
        'padding-top': '8px',
        'padding-bottom': '8px',
      } as unknown as cytoscape.Css.Node,
    },
    {
      selector: 'node.topic',
      style: {
        shape: 'round-rectangle',
        'corner-radius': '3',
        'background-color': P.topicFill,
        'border-width': 1,
        'border-color': P.topicBorder,
        color: P.topicText,
        'font-family': P.mono,
        'font-size': 11,
        'padding-left': '9px',
        'padding-right': '9px',
        'padding-top': '5px',
        'padding-bottom': '5px',
      } as unknown as cytoscape.Css.Node,
    },
    { selector: 'node.topic.onesided', style: { 'border-style': 'dashed', color: P.muted } },
    { selector: 'node.topic.bad', style: { 'border-color': BAD, 'border-width': 1.5 } },
    {
      selector: 'node.hostbox',
      style: {
        shape: 'round-rectangle',
        'corner-radius': '8',
        'background-color': P.fg,
        'background-opacity': 0.025,
        'border-width': 1,
        'border-style': 'dashed',
        'border-color': P.nsBorder,
        'text-valign': 'top',
        'text-halign': 'center',
        'text-margin-y': -4,
        'font-family': P.mono,
        'font-size': 11,
        color: P.nsText,
        padding: '16px',
      } as unknown as cytoscape.Css.Node,
    },
    {
      selector: 'edge',
      style: {
        width: 1.3,
        'line-color': P.edge,
        'target-arrow-color': P.edge,
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        'curve-style': ui.mode === 'participants' ? 'bezier' : 'round-taxi',
        'taxi-direction': ui.rankdir === 'LR' ? 'horizontal' : 'vertical',
        'taxi-turn': '50%',
        'taxi-radius': 8,
        'source-distance-from-node': 2,
        'target-distance-from-node': 2,
        label: 'data(label)',
        'font-family': P.mono,
        'font-size': 10,
        color: P.muted,
        'text-background-color': P.bg,
        'text-background-opacity': 0.9,
        'text-background-padding': '2px',
        'text-background-shape': 'roundrectangle',
      } as unknown as cytoscape.Css.Edge,
    },
    { selector: 'edge.bad', style: { 'line-color': BAD, 'target-arrow-color': BAD, 'line-style': 'dashed', color: BAD, width: 1.6 } },
    {
      // edges that point against the layout direction (cycles) are drawn as arcs so they do not overlap forward edges
      selector: 'edge.back',
      style: { 'curve-style': 'unbundled-bezier', 'control-point-distances': [70], 'control-point-weights': [0.5] } as unknown as cytoscape.Css.Edge,
    },
    { selector: '.faded', style: { opacity: 0.16 } },
    { selector: 'edge.hl', style: { 'line-color': P.accent, 'target-arrow-color': P.accent, width: 2.2, 'z-index': 10, color: P.fg } },
    { selector: 'edge.hl.bad', style: { 'line-color': BAD, 'target-arrow-color': BAD } },
    {
      selector: 'node.hl',
      style: { 'underlay-color': P.accent, 'underlay-opacity': 0.22, 'underlay-padding': 5, 'underlay-shape': 'round-rectangle' } as unknown as cytoscape.Css.Node,
    },
    { selector: 'node:selected', style: { 'border-width': 2.5, 'border-color': P.highlight } },
  ];
}

const cy = cytoscape({ container: cyBox, wheelSensitivity: 0.25, minZoom: 0.05, maxZoom: 4, style: stylesheet() });
cyBox.append(statsChip, legendChip, notice);

function applyStyle(): void {
  cy.style(stylesheet());
  const root = document.documentElement.style;
  root.setProperty('--lg-accent', P.accent);
  root.setProperty('--lg-node-fill', P.nodeFill);
  root.setProperty('--lg-topic-border', P.topicBorder);
  root.setProperty('--lg-topic-fill', P.topicFill);
}
applyStyle();
onThemeChange(() => {
  P = graphPalette();
  applyStyle();
});

let firstLayout = true;
let elementsSig = '';
let selectedId: string | undefined;
let userMoved = false;
const hzSubs = new Map<string, Subscription>();
let visibleTopics: string[] = [];

// ---- graph -> elements ----------------------------------------------------
function compileFilter(): { inc: RegExp[]; exc: RegExp[] } {
  const inc: RegExp[] = [];
  const exc: RegExp[] = [];
  for (let term of ui.filter.split(',').map((s) => s.trim()).filter(Boolean)) {
    const neg = term.startsWith('-');
    if (neg) term = term.slice(1);
    if (!term) continue;
    let re: RegExp;
    try {
      re = new RegExp(term);
    } catch {
      re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    (neg ? exc : inc).push(re);
  }
  return { inc, exc };
}

interface Built {
  els: cytoscape.ElementDefinition[];
  parts: number;
  topics: number;
  links: number;
  bad: number;
  oneSidedHidden: number;
  total: number;
}

function buildElements(g: DdsGraph): Built {
  const { inc, exc } = compileFilter();
  const parts = g.participants.filter((p) => !p.self);
  const total = parts.length;
  const passName = (s: string) => !exc.some((r) => r.test(s));
  const incOk = (s: string) => !inc.length || inc.some((r) => r.test(s));
  const eps = new Map(g.endpoints.map((e) => [e.key, e]));
  const badReaders = new Set(g.incompatible.map((i) => i.reader));
  const badTopics = new Set(g.incompatible.map((i) => i.topic));
  const partSet = new Set(parts.filter((p) => passName(p.label)).map((p) => p.key));

  interface T {
    name: string;
    writers: DdsEndpoint[];
    readers: DdsEndpoint[];
  }
  const topics: T[] = [];
  let oneSidedHidden = 0;
  for (const t of g.topics) {
    if (ui.hideRos && ROS_INTERNAL.test(t.name)) continue;
    if (!passName(t.name)) continue;
    const writers = t.writers.map((k) => eps.get(k)!).filter((e) => e && partSet.has(e.participant));
    const readers = t.readers.map((k) => eps.get(k)!).filter((e) => e && partSet.has(e.participant));
    if (!writers.length && !readers.length) continue;
    if (inc.length && !incOk(t.name) && ![...writers, ...readers].some((e) => incOk(labelOf(g, e.participant)))) continue;
    if (ui.hideDeadSinks && !readers.length) continue;
    if (ui.hideLeaf && !writers.length) continue;
    if (ui.mode === 'active' && (!writers.length || !readers.length)) {
      oneSidedHidden++;
      continue;
    }
    topics.push({ name: t.name, writers, readers });
  }
  visibleTopics = topics.map((t) => t.name);
  const usedParts = new Set<string>();
  for (const t of topics) for (const e of [...t.writers, ...t.readers]) usedParts.add(e.participant);
  const shownParts = parts.filter((p) => partSet.has(p.key) && (incOk(p.label) || usedParts.has(p.key)));

  const els: cytoscape.ElementDefinition[] = [];
  const hosts = new Set<string>();
  const parentOf = (p: DdsParticipant): string | undefined => {
    if (!ui.groupHost) return undefined;
    const id = `h:${p.host}`;
    if (!hosts.has(id)) {
      hosts.add(id);
      els.push({ group: 'nodes', data: { id, label: p.host }, classes: 'hostbox' });
    }
    return id;
  };
  for (const p of shownParts) els.push({ group: 'nodes', data: { id: `p:${p.key}`, label: p.label, parent: parentOf(p), key: p.key }, classes: 'part' });

  let links = 0;
  let bad = 0;
  if (ui.mode === 'participants') {
    const edges = new Map<string, { topics: Set<string>; bad: boolean }>();
    for (const t of topics)
      for (const w of t.writers)
        for (const r of t.readers) {
          if (w.participant === r.participant) continue;
          const k = `${w.participant}\u0000${r.participant}`;
          const e = edges.get(k) ?? edges.set(k, { topics: new Set(), bad: false }).get(k)!;
          e.topics.add(t.name);
          if (g.incompatible.some((i) => i.writer === w.key && i.reader === r.key)) e.bad = true;
        }
    for (const [k, e] of edges) {
      const [a, b] = k.split('\u0000');
      const names = [...e.topics];
      els.push({
        group: 'edges',
        data: { id: `e:${k}`, source: `p:${a}`, target: `p:${b}`, label: (names.length === 1 ? names[0] : `${names.length} topics`) + (e.bad ? ' ✕' : ''), topics: names },
        classes: e.bad ? 'bad' : '',
      });
      if (e.bad) bad++;
    }
    return { els, parts: shownParts.length, topics: 0, links: edges.size, bad, oneSidedHidden: 0, total };
  }
  for (const t of topics) {
    const tid = `t:${t.name}`;
    const oneSided = !t.writers.length || !t.readers.length;
    const cls = ['topic', oneSided ? 'onesided' : '', badTopics.has(t.name) ? 'bad' : ''].filter(Boolean).join(' ');
    els.push({ group: 'nodes', data: { id: tid, label: t.name, topic: t.name }, classes: cls });
    const seen = new Set<string>();
    for (const w of t.writers) {
      const id = `e:${w.participant}>${tid}`;
      if (seen.has(id)) continue;
      seen.add(id);
      els.push({ group: 'edges', data: { id, source: `p:${w.participant}`, target: tid, label: '' } });
      links++;
    }
    for (const r of t.readers) {
      const id = `e:${tid}>${r.participant}`;
      const isBad = badReaders.has(r.key);
      const prev = els.find((e) => e.data.id === id);
      if (prev) {
        if (isBad) prev.classes = 'bad';
        continue;
      }
      els.push({ group: 'edges', data: { id, source: tid, target: `p:${r.participant}`, label: isBad ? 'QoS ✕' : '' }, classes: isBad ? 'bad' : '' });
      links++;
      if (isBad) bad++;
    }
  }
  return { els, parts: shownParts.length, topics: topics.length, links, bad, oneSidedHidden, total };
}

function labelOf(g: DdsGraph, key: string): string {
  return g.participants.find((p) => p.key === key)?.label ?? key;
}

function setMode(m: Mode): void {
  ui.mode = m;
  save();
  renderToolbar();
  applyStyle();
  rebuild(true);
}

function showNotice(content: (string | Node)[] | undefined, center = false): void {
  notice.classList.toggle('hidden', !content);
  notice.classList.toggle('center', center);
  if (content) notice.replaceChildren(...content);
}

function rebuild(force = false): void {
  const g = host.graph;
  if (!g) {
    showNotice([h('span', { class: 'muted' }, 'Waiting for DDS discovery…')], true);
    return;
  }
  const b = buildElements(g);
  const ids = b.els
    .map((e) => String(e.data.id))
    .sort()
    .join('\n');
  const sig = ids + '#' + b.els.map((e) => `${e.data.label}|${e.classes ?? ''}`).join('\n');
  if (!force && sig === elementsSig) return;
  const structural = ids !== elementsSig.split('#')[0];
  elementsSig = sig;
  cy.batch(() => {
    cy.elements().remove();
    cy.add(b.els);
  });
  updateLabels();
  syncHzSubs();
  if (structural || force || firstLayout) runLayout(firstLayout || force || !userMoved);
  firstLayout = false;
  statsChip.replaceChildren(
    h('span', null, h('b', null, String(b.parts)), ' participants'),
    ui.mode === 'participants' ? h('span', null, h('b', null, String(b.links)), ' connections') : h('span', null, h('b', null, String(b.topics)), ' topics'),
    b.bad ? h('span', { style: `color: ${BAD}` }, h('b', { style: `color: ${BAD}` }, String(g.incompatible.length)), ' QoS mismatches') : '',
    host.status.info ? h('span', null, 'domain ', h('b', null, String(host.status.info.domainId))) : '',
  );
  if (!b.total) {
    showNotice(
      [
        h('b', null, `No DDS participants discovered${host.status.info ? ` on domain ${host.status.info.domainId}` : ''}`),
        h('span', { class: 'muted' }, 'Check ddsVis.domainId and the network interface in CYCLONEDDS_URI (ddsVis.cycloneddsUri).'),
      ],
      true,
    );
  } else if (!b.els.length) {
    showNotice([h('b', null, 'Nothing matches the current filters'), h('button', { class: 'secondary', onclick: () => resetFilters() }, 'Reset filters')], true);
  } else if (ui.mode === 'active' && b.topics === 0 && b.oneSidedHidden > 0) {
    showNotice([
      h('span', null, `No topic connects two participants — all ${b.oneSidedHidden} topics have only writers or only readers.`),
      h('button', { onclick: () => setMode('all') }, 'Show all topics'),
    ]);
  } else {
    showNotice(undefined);
  }
  if (selectedId) {
    const el = cy.getElementById(selectedId);
    if (el.nonempty()) showInfo(el);
    else hideInfo();
  }
}

function resetFilters(): void {
  ui.filter = '';
  searchIn.value = '';
  ui.hideDeadSinks = false;
  ui.hideLeaf = false;
  save();
  renderToolbar();
  rebuild(true);
}

// ---- layout: dagre per connected component, components packed in rows ----
function fit(): void {
  if (!cy.elements().length) return;
  cy.fit(undefined, 40);
  if (cy.zoom() > 1.25) {
    cy.zoom(1.25);
    cy.center();
  }
  userMoved = false;
}

function runLayout(doFit: boolean): void {
  const dagreOpts = { name: 'dagre', rankDir: ui.rankdir, nodeSep: 14, rankSep: 60, edgeSep: 8, fit: false, animate: false };
  if (ui.groupHost) {
    cy.layout({ ...dagreOpts, padding: 30 } as cytoscape.LayoutOptions).run();
    markBackEdges();
    if (doFit) fit();
    return;
  }
  const comps = cy.elements().components();
  const multi = comps.filter((c) => c.nodes().length > 1).sort((a, b) => b.nodes().length - a.nodes().length);
  const singles = comps
    .filter((c) => c.nodes().length === 1)
    .map((c) => c.nodes()[0])
    .sort((a, b) => Number(a.hasClass('topic')) - Number(b.hasClass('topic')) || String(a.data('label')).localeCompare(String(b.data('label'))));
  const boxes = multi.map((c) => {
    c.layout(dagreOpts as cytoscape.LayoutOptions).run();
    return { c, bb: c.boundingBox({ includeLabels: true }) };
  });
  const GAP = 56;
  const W = Math.max(cyBox.clientWidth, 400);
  const H = Math.max(cyBox.clientHeight, 300);
  const singleW = singles.length ? Math.max(...singles.map((n) => n.outerWidth())) + 28 : 0;
  const singleH = singles.length ? Math.max(...singles.map((n) => n.outerHeight())) + 18 : 0;
  const area = boxes.reduce((s, b) => s + (b.bb.w + GAP) * (b.bb.h + GAP), 0) + singles.length * singleW * singleH;
  const rowMax = Math.max(Math.sqrt(area * (W / H)) * 1.05, ...boxes.map((b) => b.bb.w), singleW);
  type Placed = { c: cytoscape.CollectionReturnValue; bb: cytoscape.BoundingBox12 & cytoscape.BoundingBoxWH; x: number };
  const rows: { items: Placed[]; w: number; h: number }[] = [];
  let row = { items: [] as Placed[], w: 0, h: 0 };
  for (const { c, bb } of boxes) {
    if (row.items.length && row.w + GAP + bb.w > rowMax) {
      rows.push(row);
      row = { items: [], w: 0, h: 0 };
    }
    const x = row.items.length ? row.w + GAP : 0;
    row.items.push({ c, bb, x });
    row.w = x + bb.w;
    row.h = Math.max(row.h, bb.h);
  }
  if (row.items.length) rows.push(row);
  const width = Math.max(rowMax, ...rows.map((r) => r.w));
  let y = 0;
  for (const r of rows) {
    const off = (width - r.w) / 2;
    for (const it of r.items) it.c.nodes().shift({ x: off + it.x - it.bb.x1, y: y + (r.h - it.bb.h) / 2 - it.bb.y1 });
    y += r.h + GAP;
  }
  if (singles.length) {
    const cols = Math.max(1, Math.min(singles.length, Math.floor((width + 28) / singleW)));
    const gridRows = Math.ceil(singles.length / cols);
    singles.forEach((n, i) => {
      const r = Math.floor(i / cols);
      const inRow = r === gridRows - 1 ? singles.length - r * cols : cols;
      const off = (width - inRow * singleW) / 2;
      n.position({ x: off + (i % cols) * singleW + singleW / 2, y: y + r * singleH + singleH / 2 });
    });
  }
  markBackEdges();
  if (doFit) fit();
}

function markBackEdges(): void {
  const lr = ui.rankdir === 'LR';
  cy.batch(() => {
    cy.edges().forEach((e) => {
      const s = e.source().position();
      const t = e.target().position();
      e.toggleClass('back', lr ? t.x < s.x - 1 : t.y < s.y - 1);
    });
  });
}

function updateLabels(): void {
  cy.batch(() => {
    cy.nodes('.topic').forEach((n) => {
      const t = n.data('topic') as string;
      const s = host.stats[t];
      n.data('label', ui.showHz && s ? `${t}\n${fmtHz(s.hz)} Hz` : t);
    });
  });
}

function syncHzSubs(): void {
  const want = new Set(ui.showHz && ui.mode !== 'participants' ? visibleTopics : []);
  for (const [t, s] of hzSubs) {
    if (!want.has(t)) {
      s.close();
      hzSubs.delete(t);
    }
  }
  for (const t of want) if (!hzSubs.has(t)) hzSubs.set(t, host.subscribe(t, 'stats', {}, () => undefined));
}

// ---- selection / info panel -----------------------------------------------
function highlight(el: cytoscape.SingularElementReturnValue | undefined): void {
  cy.batch(() => {
    cy.elements().removeClass('faded hl');
    if (!el) return;
    const hood = el.isEdge() ? el.union(el.connectedNodes()) : (el as cytoscape.NodeSingular).closedNeighborhood();
    cy.elements().not(hood).not('.hostbox').addClass('faded');
    hood.addClass('hl');
  });
}

function hideInfo(): void {
  selectedId = undefined;
  side.classList.add('hidden');
  highlight(undefined);
  cy.elements().unselect();
}

function qosLine(e: DdsEndpoint): string {
  const q = e.qos;
  return [q.reliability, q.durability, q.history, q.partitions.length ? `partition ${q.partitions.join(',')}` : '', q.ownership !== 'shared' ? q.ownership : '']
    .filter(Boolean)
    .join(' · ');
}

function endpointList(title: string, eps: DdsEndpoint[], g: DdsGraph, show: 'topic' | 'participant'): HTMLElement {
  const box = h('div', null, h('div', { class: 'section-title' }, `${title} · ${eps.length}`));
  if (!eps.length) box.append(h('div', { class: 'muted', style: 'font-size: 12px; padding: 2px 4px' }, 'none'));
  for (const e of eps) {
    const bad = g.incompatible.some((i) => i.reader === e.key || i.writer === e.key);
    const main = show === 'topic' ? e.topic : labelOf(g, e.participant);
    const row = h(
      'div',
      { class: 'item', title: `${e.type}\n${qosLine(e)}` },
      h('span', bad ? { style: `color: ${BAD}` } : null, `${bad ? '✕ ' : ''}${main}`),
      h('div', { class: 't' }, show === 'topic' ? e.type : qosLine(e)),
      show === 'topic' ? h('div', { class: 't' }, qosLine(e)) : '',
    );
    row.addEventListener('click', () => {
      const target = show === 'topic' ? cy.getElementById(`t:${e.topic}`) : cy.getElementById(`p:${e.participant}`);
      if (target.nonempty()) {
        cy.animate({ center: { eles: target }, duration: 200 });
        showInfo(target);
      } else if (show === 'topic') host.command('ddsVis.openTopics', { topic: e.topic });
    });
    box.append(row);
  }
  return box;
}

function showInfo(el: cytoscape.SingularElementReturnValue): void {
  selectedId = el.id();
  side.classList.remove('hidden');
  clear(side);
  highlight(el);
  const g = host.graph;
  if (!g) return;
  const close = h('button', { class: 'icon', style: 'float: right', onclick: () => hideInfo() }, '✕');
  if (el.hasClass('part')) {
    const p = g.participants.find((x) => x.key === el.data('key'));
    if (!p) return;
    const mine = g.endpoints.filter((e) => e.participant === p.key);
    const kv = h('div', { class: 'kv', style: 'margin: 4px 0' });
    const add = (k: string, v: string) => v && kv.append(h('span', null, k), h('span', { class: 'mono', style: 'word-break: break-all' }, v));
    add('GUID', p.key);
    add('host', p.hostname);
    add('process', p.process ? `${p.process} (pid ${p.pid})` : '');
    add('addresses', p.addresses);
    side.append(
      close,
      h('div', { class: 'kind' }, 'Participant'),
      h('h3', null, p.label),
      kv,
      endpointList('Writers', mine.filter((e) => e.kind === 'writer'), g, 'topic'),
      endpointList('Readers', mine.filter((e) => e.kind === 'reader'), g, 'topic'),
    );
  } else if (el.hasClass('topic')) {
    const name = el.data('topic') as string;
    const t = g.topics.find((x) => x.name === name);
    if (!t) return;
    const eps = new Map(g.endpoints.map((e) => [e.key, e]));
    const s = host.stats[name];
    const bad = g.incompatible.filter((i) => i.topic === name);
    side.append(
      close,
      h('div', { class: 'kind' }, 'Topic'),
      h('h3', null, name),
      h('div', { class: 'badge' }, t.types.join(', ')),
      s ? h('div', { class: 'muted', style: 'margin-top: 4px' }, `${fmtHz(s.hz)} Hz`) : '',
      ...bad.map((i) =>
        h(
          'div',
          { class: 'warnbox' },
          h('b', null, `${labelOf(g, eps.get(i.writer)?.participant ?? '')} → ${labelOf(g, eps.get(i.reader)?.participant ?? '')}`),
          ...i.reasons.map((r) => h('div', null, r)),
        ),
      ),
      h(
        'div',
        { class: 'row', style: 'flex-wrap: wrap; margin: 8px 0' },
        h('button', { onclick: () => host.command('ddsVis.openTopics', { topic: name }) }, 'Monitor'),
        h('button', { class: 'secondary', onclick: () => host.command('ddsVis.openPlot', { topic: name }) }, 'Plot'),
        h('button', { class: 'secondary', onclick: () => host.command('ddsVis.showType', { topic: name }) }, 'IDL'),
      ),
      endpointList('Writers', t.writers.map((k) => eps.get(k)!).filter(Boolean), g, 'participant'),
      endpointList('Readers', t.readers.map((k) => eps.get(k)!).filter(Boolean), g, 'participant'),
    );
  } else if (el.isEdge() && el.data('topics')) {
    const names = el.data('topics') as string[];
    side.append(close, h('div', { class: 'kind' }, 'Connection'), h('h3', null, `${labelOf(g, el.source().data('key'))} → ${labelOf(g, el.target().data('key'))}`));
    for (const n of names) {
      const row = h('div', { class: 'item' }, n, h('div', { class: 't' }, host.topicTypes(n).join(', ')));
      row.addEventListener('click', () => host.command('ddsVis.openTopics', { topic: n }));
      side.append(row);
    }
  } else {
    hideInfo();
  }
}

cy.on('tap', (e) => {
  if (e.target === cy) hideInfo();
  else if (!e.target.hasClass('hostbox')) showInfo(e.target);
});
cy.on('dbltap', 'node.topic', (e) => host.command('ddsVis.openTopics', { topic: e.target.data('topic') }));
cy.on('mouseover', 'node.part, node.topic, edge', (e) => {
  if (!selectedId) highlight(e.target);
  cyBox.style.cursor = 'pointer';
});
cy.on('mouseout', 'node, edge', () => {
  if (!selectedId) highlight(undefined);
  cyBox.style.cursor = '';
});
cy.on('dragfree', 'node', () => (userMoved = true));
cyBox.addEventListener('wheel', () => (userMoved = true), { passive: true });

function savePng(): void {
  const b64 = cy.png({ output: 'base64', full: true, scale: 2, bg: P.bg }) as unknown as string;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  host.saveFile('dds_graph.png', bytes, { Images: ['png'] });
  toast('Choose where to save the PNG…');
}

new ResizeObserver(() => cy.resize()).observe(cyBox);
// test hook
(window as unknown as { __cy: cytoscape.Core }).__cy = cy;

host.on('graph', () => rebuild(false));
host.on('stats', () => {
  if (ui.showHz) updateLabels();
});
host.on('status', () => rebuild(false));
host.on('init', () => rebuild(true));
host.start();
