import * as fs from 'fs';
import * as vscode from 'vscode';
import type { ToHost, ViewName } from '../../shared/protocol';
import type { Hub, HubClient } from '../core/hub';

export const VIEW_META: Record<ViewName, { title: string; reuse: 'singleton' | 'last' }> = {
  graph: { title: 'DDS Graph', reuse: 'singleton' },
  topics: { title: 'DDS Topics', reuse: 'singleton' },
  plot: { title: 'DDS Plot', reuse: 'last' },
};

interface PanelEntry {
  view: ViewName;
  panel: vscode.WebviewPanel;
  client: HubClient;
  lastFocus: number;
}

function nonce(): string {
  let s = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

export class PanelManager implements vscode.Disposable {
  private entries = new Set<PanelEntry>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly hub: Hub,
  ) {}

  open(view: ViewName, args: Record<string, unknown> = {}): void {
    const meta = VIEW_META[view];
    const same = [...this.entries].filter((e) => e.view === view).sort((a, b) => b.lastFocus - a.lastFocus);
    let target: PanelEntry | undefined;
    target = same[0];
    void meta;
    if (target) {
      target.panel.reveal(undefined, false);
      if (Object.keys(args).length) target.client.setArgs(args);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      `ddsVis.${view}`,
      meta.title,
      vscode.ViewColumn.Active,
      this.webviewOptions(),
    );
    this.attach(view, panel, args);
  }

  serializer(view: ViewName): vscode.WebviewPanelSerializer {
    return {
      deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown) => {
        const args = ((state as { args?: Record<string, unknown> } | undefined)?.args ?? {}) as Record<string, unknown>;
        panel.webview.options = this.webviewOptions();
        this.attach(view, panel, args);
      },
    };
  }

  /** Sends `args` to every open panel of `view` that matches `filter`. */
  notify(view: ViewName, filter: (args: Record<string, unknown>) => boolean, args: Record<string, unknown>): void {
    for (const e of this.entries) if (e.view === view && filter(e.client.args)) e.client.setArgs(args);
  }

  dispose(): void {
    for (const e of [...this.entries]) e.panel.dispose();
  }

  private webviewOptions(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.ctx.extensionUri, 'media'),
      ],
    };
  }

  private attach(view: ViewName, panel: vscode.WebviewPanel, args: Record<string, unknown>): void {
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'dds-tab.svg');
    const entry: PanelEntry = { view, panel, client: undefined as unknown as HubClient, lastFocus: Date.now() };
    entry.client = this.hub.createClient(view, args, {
      post: (msg) => void panel.webview.postMessage(msg),
      command: (command, cargs) => void vscode.commands.executeCommand(command, ...cargs),
      copy: (text) => void vscode.env.clipboard.writeText(text),
      setTitle: (title) => (panel.title = title),
      openFile: (p, line) => void this.openFile(p, line),
      saveFile: (name, data, filters) => void this.saveFile(name, data, filters),
    });
    this.entries.add(entry);
    panel.webview.onDidReceiveMessage((m: ToHost) => entry.client.handle(m));
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) entry.lastFocus = Date.now();
    });
    panel.onDidDispose(() => {
      entry.client.dispose();
      this.entries.delete(entry);
    });
    panel.webview.html = this.html(panel.webview, view);
  }

  private html(webview: vscode.Webview, view: ViewName): string {
    const base = vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview');
    const js = webview.asWebviewUri(vscode.Uri.joinPath(base, `${view}.js`));
    const cssPath = vscode.Uri.joinPath(base, `${view}.css`);
    const css = fs.existsSync(cssPath.fsPath) ? `<link rel="stylesheet" href="${webview.asWebviewUri(cssPath)}">` : '';
    const n = nonce();
    const src = webview.cspSource;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${src} blob: data:; style-src ${src} 'unsafe-inline'; font-src ${src}; script-src 'nonce-${n}'; worker-src blob:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${css}
<title>${VIEW_META[view].title}</title>
</head>
<body data-view="${view}">
<div id="app"></div>
<script nonce="${n}" src="${js}"></script>
</body>
</html>`;
  }

  private async openFile(p: string, line?: number): Promise<void> {
    if (!p || !fs.existsSync(p)) {
      void vscode.window.showWarningMessage(`File not found: ${p}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(p));
    const pos = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
  }

  private async saveFile(name: string, data: Uint8Array | string, filters?: Record<string, string[]>): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
      filters,
    });
    if (!uri) return;
    const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    await vscode.workspace.fs.writeFile(uri, bytes);
    void vscode.window.showInformationMessage(`Saved ${uri.fsPath}`);
  }
}
