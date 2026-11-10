// Theme-derived colours for canvas renderers (cytoscape, three.js) that need literal colours.
import { themeColor } from './ui';

type Rgb = [number, number, number];

export function parseColor(c: string): Rgb | undefined {
  const s = c.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let hex = m[1];
    if (hex.length <= 4) hex = hex.split('').map((x) => x + x).join('');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length >= 3) return [p[0], p[1], p[2]];
  }
  return undefined;
}

/** Linear blend of two colours; t = weight of `b`. */
export function mix(a: string, b: string, t: number): string {
  const A = parseColor(a) ?? [128, 128, 128];
  const B = parseColor(b) ?? [128, 128, 128];
  const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

export interface GraphPalette {
  bg: string;
  fg: string;
  accent: string;
  warn: string;
  ok: string;
  nodeFill: string;
  topicFill: string;
  topicBorder: string;
  topicText: string;
  muted: string;
  edge: string;
  dupFill: string;
  nsBorder: string;
  nsText: string;
  highlight: string;
  font: string;
  mono: string;
}

export function graphPalette(): GraphPalette {
  const bg = themeColor('--vscode-editor-background', '#1e1e1e');
  const fg = themeColor('--vscode-editor-foreground', '#d4d4d4');
  const accent = themeColor('--vscode-charts-blue', themeColor('--vscode-focusBorder', '#3794ff'));
  const warn = themeColor('--vscode-charts-orange', '#d18616');
  const ok = themeColor('--vscode-charts-green', '#89d185');
  return {
    bg,
    fg,
    accent,
    warn,
    ok,
    nodeFill: mix(bg, accent, 0.2),
    topicFill: mix(bg, fg, 0.06),
    topicBorder: mix(bg, fg, 0.32),
    topicText: mix(bg, fg, 0.85),
    muted: mix(bg, fg, 0.5),
    edge: mix(bg, fg, 0.36),
    dupFill: mix(bg, warn, 0.2),
    nsBorder: mix(bg, fg, 0.22),
    nsText: mix(bg, fg, 0.55),
    highlight: themeColor('--vscode-charts-yellow', '#e2c08d'),
    font: themeColor('--vscode-font-family', 'system-ui, sans-serif'),
    mono: themeColor('--vscode-editor-font-family', 'monospace'),
  };
}

/** Calls `fn` when VS Code switches the colour theme (body class / style change). */
export function onThemeChange(fn: () => void): void {
  let last = document.body.className;
  new MutationObserver(() => {
    if (document.body.className !== last) {
      last = document.body.className;
      fn();
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
}
