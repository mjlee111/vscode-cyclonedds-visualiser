/**
 * Development harness: serves the webviews in a normal browser, backed by the
 * real Python backend, with a WebSocket shim standing in for the VS Code API.
 *
 *   npm run harness -- --port 8765
 *   open http://localhost:8765/
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import type { ToHost, ToView, ViewName } from '../../shared/protocol';
import { DdsBackend } from '../core/backend';
import { buildSpawnSpec } from '../core/env';
import { Hub } from '../core/hub';

const root = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const port = Number(argv[argv.indexOf('--port') + 1] || 8765) || 8765;
const VIEWS: ViewName[] = ['graph', 'topics', 'plot'];

const backend = new DdsBackend(
  () =>
    buildSpawnSpec({
      scriptPath: path.join(root, 'python', 'dds_backend.py'),
      pythonPath: process.env.DDS_VIS_PYTHON ?? '',
      domainId: Number(process.env.DDS_VIS_DOMAIN ?? 0),
      cycloneddsUri: process.env.CYCLONEDDS_URI ?? '',
      graphPollInterval: 1.0,
      typeLookupTimeout: 5,
      workspaceFolders: [],
    }),
  (line) => process.stderr.write(`[backend] ${line}\n`),
);
const hub = new Hub(backend);

const shim = `
(function(){
  const params = new URLSearchParams(location.search);
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?view=' + document.body.dataset.view + '&args=' + encodeURIComponent(params.get('args') || '{}'));
  ws.binaryType = 'arraybuffer';
  const queue = [];
  ws.onopen = () => { for (const m of queue.splice(0)) ws.send(m); };
  ws.onmessage = (e) => {
    let data;
    if (typeof e.data === 'string') data = JSON.parse(e.data);
    else {
      const dv = new DataView(e.data);
      const jl = dv.getUint32(0, true);
      data = JSON.parse(new TextDecoder().decode(new Uint8Array(e.data, 4, jl)));
      data.payload = new Uint8Array(e.data, 4 + jl);
    }
    window.dispatchEvent(new MessageEvent('message', { data }));
  };
  const key = 'ddsvis-state-' + document.body.dataset.view;
  window.acquireVsCodeApi = () => ({
    postMessage(m) {
      const s = JSON.stringify(m, (k, v) => (v instanceof Uint8Array ? { __b64: btoa(String.fromCharCode(...v)) } : v));
      if (ws.readyState === 1) ws.send(s); else queue.push(s);
    },
    getState() { try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch { return null; } },
    setState(s) { sessionStorage.setItem(key, JSON.stringify(s)); },
  });
})();`;

const LIGHT_THEME = `html{--vscode-editor-background:#ffffff;--vscode-editor-foreground:#1f2328;--vscode-foreground:#1f2328;
--vscode-sideBar-background:#f3f3f3;--vscode-panel-border:#d0d7de;--vscode-descriptionForeground:#656d76;
--vscode-input-background:#ffffff;--vscode-input-foreground:#1f2328;--vscode-input-border:#d0d7de;
--vscode-list-hoverBackground:#eaeef2;--vscode-editorWidget-background:#f6f8fa;--vscode-editorWidget-border:#d0d7de;
--vscode-button-secondaryBackground:#e7e9eb;--vscode-button-secondaryForeground:#1f2328;--vscode-charts-blue:#1a85ff;}`;

function page(view: string, theme = 'dark'): string {
  const css = fs.existsSync(path.join(root, 'dist', 'webview', `${view}.css`))
    ? `<link rel="stylesheet" href="/dist/webview/${view}.css">`
    : '';
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${view}</title>${css}
<style>body{--vscode-font-size:13px}${theme === 'light' ? LIGHT_THEME : ''}</style></head>
<body data-view="${view}"><div id="app"></div><script>${shim}</script><script src="/dist/webview/${view}.js"></script></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<h3>Cyclone DDS visualiser harness</h3><ul>${VIEWS.map((v) => `<li><a href="/view/${v}">${v}</a></li>`).join('')}</ul>`);
    return;
  }
  const m = /^\/view\/(\w+)$/.exec(url.pathname);
  if (m && VIEWS.includes(m[1] as ViewName)) {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(m[1], url.searchParams.get('theme') ?? 'dark'));
    return;
  }
  if (url.pathname.startsWith('/dist/webview/')) {
    const file = path.join(root, 'dist', 'webview', path.basename(url.pathname));
    if (fs.existsSync(file)) {
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      fs.createReadStream(file).pipe(res);
      return;
    }
  }
  res.writeHead(404);
  res.end('not found');
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const view = (url.searchParams.get('view') ?? 'graph') as ViewName;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(url.searchParams.get('args') ?? '{}');
  } catch {
    /* ignore */
  }
  const client = hub.createClient(view, args, {
    post: (msg: ToView) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if ((msg.type === 'event' || msg.type === 'response') && msg.payload) {
        const { payload, ...rest } = msg;
        const j = Buffer.from(JSON.stringify(rest));
        const head = Buffer.alloc(4);
        head.writeUInt32LE(j.length, 0);
        ws.send(Buffer.concat([head, j, Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)]));
      } else {
        ws.send(JSON.stringify(msg));
      }
    },
    command: (c, a) => console.log(`[${view}] command ${c} ${JSON.stringify(a)}`),
    copy: (t) => console.log(`[${view}] copy ${t.length} chars`),
    setTitle: (t) => console.log(`[${view}] title ${t}`),
    openFile: (p, l) => console.log(`[${view}] open ${p}:${l}`),
    saveFile: (n) => console.log(`[${view}] save ${n}`),
  });
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(String(data), (_k, v) =>
        v && typeof v === 'object' && typeof v.__b64 === 'string' ? Uint8Array.from(Buffer.from(v.__b64, 'base64')) : v,
      ) as ToHost;
      client.handle(msg);
    } catch (e) {
      console.error('bad ws message', e);
    }
  });
  ws.on('close', () => client.dispose());
});

server.listen(port, () => {
  console.log(`harness listening on http://localhost:${port}/`);
  backend.start();
});

const shutdown = () => {
  backend.stop();
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
