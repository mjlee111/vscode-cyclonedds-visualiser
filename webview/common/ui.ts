import type { BackendStatus, DdsGraph } from '../../shared/protocol';
import { host } from './host';

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: Partial<CSSStyleDeclaration> | string };

/** Tiny DOM builder: h('div', {class: 'x', onclick: fn}, 'text', child). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') {
        if (typeof v === 'string') el.setAttribute('style', v);
        else Object.assign(el.style, v);
      } else if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k in el && typeof v !== 'string') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else if (k === 'value' || k === 'checked') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k, v === true ? '' : String(v));
      }
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function icon(name: string, title?: string): HTMLSpanElement {
  return h('span', { class: `ico ico-${name}`, title });
}

export function fmtHz(hz: number | undefined): string {
  if (!hz) return '—';
  if (hz >= 100) return hz.toFixed(0);
  if (hz >= 10) return hz.toFixed(1);
  return hz.toFixed(2);
}

export function fmtBytes(b: number | undefined): string {
  if (b === undefined || b === null || isNaN(b)) return '—';
  if (b < 1024) return `${b.toFixed(0)} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / 1024 / 1024).toFixed(2)} MB`;
  return `${(b / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtBw(b: number | undefined): string {
  return b ? `${fmtBytes(b)}/s` : '—';
}

export function fmtSec(s: number | undefined | null): string {
  if (s === undefined || s === null || isNaN(s)) return '—';
  const a = Math.abs(s);
  if (a < 1e-3) return `${(s * 1e6).toFixed(0)} µs`;
  if (a < 1) return `${(s * 1e3).toFixed(2)} ms`;
  return `${s.toFixed(3)} s`;
}

export function fmtStamp(t: number | undefined | null): string {
  if (!t) return '—';
  const d = new Date(t * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: number | undefined;
  return (...a: A) => {
    if (t !== undefined) clearTimeout(t);
    t = window.setTimeout(() => fn(...a), ms);
  };
}

/** Transient message at the bottom right. */
export function toast(text: string, kind: 'info' | 'error' | 'ok' = 'info', ms = 3500): void {
  let host = document.getElementById('toasts');
  if (!host) {
    host = h('div', { id: 'toasts' });
    document.body.append(host);
  }
  const t = h('div', { class: `toast toast-${kind}` }, text);
  host.append(t);
  setTimeout(() => t.remove(), ms);
}

/** A <select> listing topics matching `filter`, kept in sync with the graph. */
export class TopicSelect {
  readonly el: HTMLSelectElement;
  private value = '';

  constructor(
    private readonly filter: (types: string[], name: string) => boolean,
    private readonly onChange: (topic: string, type: string | undefined) => void,
    private readonly placeholder = '— select topic —',
  ) {
    this.el = h('select', { class: 'topic-select', onchange: () => this.changed() });
    host.on('graph', (g) => this.render(g));
    this.render(host.graph);
  }

  get topic(): string {
    return this.value;
  }

  set(topic: string): void {
    this.value = topic;
    this.render(host.graph);
  }

  private changed(): void {
    this.value = this.el.value;
    this.onChange(this.value, host.topicTypes(this.value)[0]);
  }

  private render(g: DdsGraph | undefined): void {
    const topics = (g?.topics ?? []).filter((t) => this.filter(t.types, t.name));
    const names = topics.map((t) => t.name);
    const sig = names.join('|') + '#' + this.value;
    if (this.el.dataset.sig === sig) return;
    this.el.dataset.sig = sig;
    clear(this.el);
    this.el.append(h('option', { value: '' }, this.placeholder));
    for (const t of topics) this.el.append(h('option', { value: t.name }, `${t.name}  [${t.types[0]?.split('::').pop()}]`));
    if (this.value && !names.includes(this.value)) this.el.append(h('option', { value: this.value }, `${this.value} (not available)`));
    this.el.value = this.value;
  }
}

/** Banner shown while the backend is not ready. */
export function statusBanner(): HTMLElement {
  const el = h('div', { class: 'status-banner hidden' });
  const render = (s: BackendStatus) => {
    el.classList.toggle('hidden', s.state === 'ready');
    el.classList.toggle('error', s.state === 'error');
    el.textContent =
      s.state === 'starting'
        ? 'Starting ROS backend…'
        : s.state === 'error'
          ? `ROS backend error: ${s.error ?? ''}`
          : 'ROS backend stopped';
  };
  host.on('status', render);
  render(host.status);
  return el;
}

/** Floating-point aware compact number formatting for message values. */
export function fmtValue(v: unknown): string {
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-4 || a >= 1e15)) return v.toExponential(4);
    return String(Math.round(v * 1e6) / 1e6); // keeps e.g. epoch seconds readable
  }
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}


/** Reads a VS Code theme color variable (with fallback). */
export function themeColor(name: string, fallback: string): string {
  const v = getComputedStyle(document.body).getPropertyValue(name).trim();
  return v || fallback;
}
