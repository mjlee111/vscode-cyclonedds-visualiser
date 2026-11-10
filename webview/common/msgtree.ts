import { fmtValue, h } from './ui';

interface Truncated {
  __truncated__: true;
  length: number;
  head: unknown[];
}

function isTrunc(v: unknown): v is Truncated {
  return !!v && typeof v === 'object' && (v as Truncated).__truncated__ === true;
}

type Kind = 'leaf' | 'obj' | 'arr';

interface TNode {
  kind: Kind;
  el: HTMLElement;
  valEl: HTMLElement;
  childBox?: HTMLElement;
  children?: Map<string, TNode>;
  sig: string;
  value: unknown;
  path: string;
}

function kindOf(v: unknown): Kind {
  if (Array.isArray(v) || isTrunc(v)) return 'arr';
  if (v && typeof v === 'object') return 'obj';
  return 'leaf';
}

function entries(v: unknown): [string, unknown, boolean][] {
  if (isTrunc(v)) return v.head.map((x, i) => [String(i), x, true]);
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x, true]);
  return Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, x, false]);
}

function summary(v: unknown): string {
  if (isTrunc(v)) return `[${v.length} items, showing ${v.head.length}]`;
  if (Array.isArray(v)) {
    if (v.length <= 6 && v.every((x) => typeof x !== 'object' || x === null)) return `[${v.map(fmtValue).join(', ')}]`;
    return `[${v.length} items]`;
  }
  const keys = Object.keys(v as object);
  return `{${keys.slice(0, 4).join(', ')}${keys.length > 4 ? ', …' : ''}}`;
}

/**
 * Collapsible message tree with in-place value updates, so high-rate
 * messages do not rebuild the DOM or lose the expansion state.
 */
export class MsgTree {
  readonly el: HTMLElement;
  private root: TNode | undefined;
  private expanded = new Set<string>();
  private collapsed = new Set<string>();

  constructor(
    private readonly opts: {
      onLeaf?: (path: string, value: unknown) => void;
      leafActionTitle?: string;
      autoExpandDepth?: number;
    } = {},
  ) {
    this.el = h('div', { class: 'msgtree' });
  }

  set(value: unknown): void {
    if (!this.root || this.root.kind !== kindOf(value) || this.root.sig !== this.sigOf(value)) {
      this.el.textContent = '';
      this.root = this.build('', '', value, 0, false);
      this.el.append(this.root.el);
    } else {
      this.update(this.root, value, 0);
    }
  }

  clear(): void {
    this.el.textContent = '';
    this.root = undefined;
  }

  expandAll(on: boolean): void {
    this.collapsed.clear();
    this.expanded.clear();
    if (!on) this.collapsed.add('*');
    else this.expanded.add('*');
    const v = this.root?.value;
    this.root = undefined;
    if (v !== undefined) this.set(v);
    this.expanded.delete('*');
    this.collapsed.delete('*');
  }

  private sigOf(v: unknown): string {
    if (isTrunc(v)) return `t${v.length}:${v.head.length}`;
    if (Array.isArray(v)) return `a${v.length}`;
    if (v && typeof v === 'object') return 'o' + Object.keys(v).join(',');
    return 'l';
  }

  private isOpen(path: string, depth: number, v: unknown): boolean {
    if (this.expanded.has(path) || this.expanded.has('*')) return true;
    if (this.collapsed.has(path) || this.collapsed.has('*')) return false;
    const maxDepth = this.opts.autoExpandDepth ?? 3;
    if (depth === 0) return true;
    if (kindOf(v) === 'arr') {
      const n = isTrunc(v) ? v.length : (v as unknown[]).length;
      return n > 0 && n <= 8 && depth < maxDepth && !(v as unknown[]).every?.((x) => typeof x !== 'object');
    }
    return depth < maxDepth;
  }

  private childPath(parent: string, key: string, isIndex: boolean): string {
    if (isIndex) return `${parent}[${key}]`;
    return parent ? `${parent}.${key}` : key;
  }

  private build(path: string, key: string, v: unknown, depth: number, isIndex: boolean): TNode {
    const kind = kindOf(v);
    const tw = h('span', { class: 'tw' });
    const valEl = h('span', { class: `tv tv-${typeof v}` });
    const row = h('div', { class: 'tr' }, tw, key !== '' ? h('span', { class: isIndex ? 'tk ti' : 'tk' }, key) : null, key !== '' ? h('span', { class: 'tsep' }, ': ') : null, valEl);
    const el = h('div', { class: 'tn' }, row);
    const node: TNode = { kind, el, valEl, sig: this.sigOf(v), value: v, path };
    if (kind === 'leaf') {
      valEl.textContent = fmtValue(v);
      valEl.className = `tv tv-${v === null ? 'null' : typeof v}`;
      if (this.opts.onLeaf && (typeof v === 'number' || typeof v === 'boolean')) {
        const btn = h('span', { class: 'leaf-act', title: this.opts.leafActionTitle ?? '' }, '📈');
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          this.opts.onLeaf!(path, node.value);
        });
        row.append(btn);
      }
      return node;
    }
    node.children = new Map();
    const box = h('div', { class: 'tc' });
    node.childBox = box;
    el.append(box);
    const open = this.isOpen(path, depth, v);
    tw.textContent = open ? '▾' : '▸';
    valEl.textContent = open ? (kind === 'arr' ? `[${isTrunc(v) ? v.length : (v as unknown[]).length}]` : '') : summary(v);
    valEl.className = 'tv tv-summary';
    if (open) this.fill(node, depth);
    else box.style.display = 'none';
    row.classList.add('expandable');
    row.addEventListener('click', () => {
      const nowOpen = box.style.display === 'none';
      if (nowOpen) {
        this.expanded.add(path);
        this.collapsed.delete(path);
        box.style.display = '';
        tw.textContent = '▾';
        if (!node.children!.size) this.fill(node, depth);
        else this.update(node, node.value, depth);
        valEl.textContent = kind === 'arr' ? `[${isTrunc(node.value) ? (node.value as Truncated).length : (node.value as unknown[]).length}]` : '';
      } else {
        this.collapsed.add(path);
        this.expanded.delete(path);
        box.style.display = 'none';
        tw.textContent = '▸';
        valEl.textContent = summary(node.value);
      }
    });
    return node;
  }

  private fill(node: TNode, depth: number): void {
    const box = node.childBox!;
    box.textContent = '';
    node.children!.clear();
    for (const [k, x, isIdx] of entries(node.value)) {
      const c = this.build(this.childPath(node.path, k, isIdx), k, x, depth + 1, isIdx);
      node.children!.set(k, c);
      box.append(c.el);
    }
    if (isTrunc(node.value)) {
      box.append(h('div', { class: 'tn tmore' }, `… ${node.value.length - node.value.head.length} more items not shown`));
    }
  }

  private update(node: TNode, v: unknown, depth: number): void {
    node.value = v;
    if (node.kind === 'leaf') {
      const s = fmtValue(v);
      if (node.valEl.textContent !== s) node.valEl.textContent = s;
      return;
    }
    const open = node.childBox!.style.display !== 'none';
    if (!open) {
      node.valEl.textContent = summary(v);
      return;
    }
    for (const [k, x, isIdx] of entries(v)) {
      const c = node.children!.get(k);
      if (c && c.kind === kindOf(x) && c.sig === this.sigOf(x)) {
        this.update(c, x, depth + 1);
      } else {
        const nc = this.build(this.childPath(node.path, k, isIdx), k, x, depth + 1, isIdx);
        if (c) c.el.replaceWith(nc.el);
        else node.childBox!.append(nc.el);
        node.children!.set(k, nc);
      }
    }
  }
}

/** JSON -> YAML-ish text for copying, similar to `ros2 topic echo`. */
export function toYaml(v: unknown, indent = ''): string {
  if (isTrunc(v)) v = v.head;
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every((x) => typeof x !== 'object' || x === null)) return `[${v.map(fmtValue).join(', ')}]`;
    return '\n' + v.map((x) => `${indent}- ${toYaml(x, indent + '  ').replace(/^\n\s*/, '')}`).join('\n');
  }
  if (v && typeof v === 'object') {
    const ents = Object.entries(v);
    if (!ents.length) return '{}';
    return (
      (indent ? '\n' : '') +
      ents
        .map(([k, x]) => {
          const s = toYaml(x, indent + '  ');
          return `${indent}${k}:${s.startsWith('\n') ? s : ' ' + s}`;
        })
        .join('\n')
    );
  }
  return typeof v === 'string' ? `'${v}'` : String(v);
}
