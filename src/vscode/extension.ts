import * as path from 'path';
import * as vscode from 'vscode';
import type { BackendStatus, ViewName } from '../../shared/protocol';
import { DdsBackend } from '../core/backend';
import { BackendConfig, buildSpawnSpec } from '../core/env';
import { Hub } from '../core/hub';
import { ExplorerItem, ExplorerProvider, TOOLS, ToolsProvider } from './explorer';
import { PanelManager } from './panels';

let backend: DdsBackend | undefined;

function readConfig(ctx: vscode.ExtensionContext): BackendConfig {
  const c = vscode.workspace.getConfiguration('ddsVis');
  return {
    scriptPath: path.join(ctx.extensionPath, 'python', 'dds_backend.py'),
    pythonPath: c.get<string>('pythonPath', ''),
    domainId: c.get<number>('domainId', 0),
    cycloneddsUri: c.get<string>('cycloneddsUri', ''),
    graphPollInterval: c.get<number>('graphPollInterval', 1.0),
    typeLookupTimeout: c.get<number>('typeLookupTimeout', 5),
    reliableReaders: c.get<boolean>('reliableReaders', false),
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
  };
}

/** Normalises command arguments from the tree, the palette or a webview. */
function argsFrom(a: unknown): Record<string, unknown> {
  if (a === undefined || a === null) return {};
  if (typeof a === 'string') return { topic: a };
  const item = a as ExplorerItem & Record<string, unknown>;
  if (item.kind === 'topic') return { topic: item.name };
  if (item.kind === 'endpoint') return { topic: item.endpoint.topic };
  if (item.kind === 'incompat') return { topic: item.incompat.topic };
  if (item.kind === 'participant') return { participant: item.participant.key };
  return { ...(a as Record<string, unknown>) };
}

export function activate(ctx: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('Cyclone DDS Visualiser');
  backend = new DdsBackend(
    () => buildSpawnSpec(readConfig(ctx)),
    (line) => out.appendLine(line),
  );
  const hub = new Hub(backend);
  const panels = new PanelManager(ctx, hub);
  ctx.subscriptions.push(out, panels, { dispose: () => backend?.dispose() });

  const explorer = new ExplorerProvider(hub);
  ctx.subscriptions.push(
    vscode.window.createTreeView('ddsVis.explorer', { treeDataProvider: explorer, showCollapseAll: true }),
    vscode.window.createTreeView('ddsVis.tools', { treeDataProvider: new ToolsProvider() }),
  );

  // ---- status bar ------------------------------------------------------
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  status.command = 'ddsVis.quickOpen';
  const renderStatus = (): void => {
    const s: BackendStatus = hub.status;
    if (s.state === 'ready') {
      const g = hub.graph;
      const parts = g ? g.participants.filter((p) => !p.self).length : 0;
      const topics = g ? g.topics.length : 0;
      const bad = g?.incompatible.length ?? 0;
      status.text = `$(radio-tower) DDS D${s.info?.domainId ?? 0} · ${parts} participants · ${topics} topics${bad ? ` · $(warning) ${bad} QoS` : ''}`;
      status.tooltip = `Cyclone DDS ${s.info?.cyclonedds}\nparticipant ${s.info?.guid}\nCYCLONEDDS_URI: ${s.info?.uri || '(default)'}\nClick for DDS tools`;
      status.backgroundColor = bad ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    } else if (s.state === 'starting') {
      status.text = '$(sync~spin) DDS starting…';
      status.tooltip = 'Starting the Cyclone DDS backend';
      status.backgroundColor = undefined;
    } else {
      status.text = s.state === 'error' ? '$(error) DDS backend error' : '$(circle-slash) DDS stopped';
      status.tooltip = s.error ?? 'Backend not running. Click for options.';
      status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    status.show();
  };
  hub.onGraph(renderStatus);
  backend.on('status', renderStatus);
  ctx.subscriptions.push(status);
  renderStatus();

  let warned = false;
  backend.on('status', (s: BackendStatus) => {
    if (s.state === 'ready') warned = false;
    if (s.state !== 'error' || warned) return;
    warned = true;
    const err = s.error ?? '';
    const hint = /cannot import the Cyclone DDS Python package|No module named 'cyclonedds'/.test(err)
      ? 'The backend cannot import the Cyclone DDS Python package. Install it with "pip install cyclonedds", or set "ddsVis.pythonPath" to an interpreter that has it.'
      : `Cyclone DDS backend failed: ${err.split('\n').pop()}`;
    void vscode.window.showErrorMessage(hint, 'Open Settings', 'Show Log', 'Restart').then((pick) => {
      if (pick === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'ddsVis');
      if (pick === 'Show Log') out.show();
      if (pick === 'Restart') backend?.restart();
    });
  });

  // ---- commands --------------------------------------------------------
  const openCmd: [string, ViewName][] = [
    ['ddsVis.openGraph', 'graph'],
    ['ddsVis.openTopics', 'topics'],
    ['ddsVis.openPlot', 'plot'],
  ];
  for (const [cmd, view] of openCmd) {
    ctx.subscriptions.push(
      vscode.commands.registerCommand(cmd, (a?: unknown) => {
        if (hub.status.state === 'stopped') backend?.start();
        panels.open(view, argsFrom(a));
      }),
      vscode.window.registerWebviewPanelSerializer(`ddsVis.${view}`, panels.serializer(view)),
    );
  }

  ctx.subscriptions.push(
    vscode.commands.registerCommand('ddsVis.restartBackend', () => backend?.restart()),
    vscode.commands.registerCommand('ddsVis.showOutput', () => out.show()),
    vscode.commands.registerCommand('ddsVis.copyName', (a?: unknown) => {
      const args = argsFrom(a);
      const name = (args.topic ?? args.participant) as string | undefined;
      if (name) void vscode.env.clipboard.writeText(name);
    }),
    vscode.commands.registerCommand('ddsVis.quickOpen', async () => {
      const items = [
        ...TOOLS.map((t) => ({ label: `$(${t.icon}) ${t.label}`, description: t.detail, command: t.command })),
        { label: '$(debug-restart) Restart DDS backend', description: '', command: 'ddsVis.restartBackend' },
        { label: '$(output) Show backend log', description: '', command: 'ddsVis.showOutput' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Cyclone DDS tools' });
      if (pick) void vscode.commands.executeCommand(pick.command);
    }),
    vscode.commands.registerCommand('ddsVis.showType', async (a?: unknown) => {
      let topic = argsFrom(a).topic as string | undefined;
      if (!topic) {
        topic = await vscode.window.showQuickPick((hub.graph?.topics ?? []).map((t) => t.name), { placeHolder: 'Topic' });
        if (!topic) return;
      }
      try {
        const info = await hub.backend.request<{ type: string; idl: string }>('typeInfo', { topic }, 30000);
        const content = `// ${topic}\n// type ${info.type} (resolved from XTypes type information)\n\n${info.idl}\n`;
        const doc = await vscode.workspace.openTextDocument({ content, language: 'cpp' });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (e) {
        void vscode.window.showErrorMessage(`Cannot show the type of ${topic}: ${(e as Error).message}`);
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (['pythonPath', 'domainId', 'cycloneddsUri', 'graphPollInterval', 'typeLookupTimeout', 'reliableReaders'].some((k) => e.affectsConfiguration(`ddsVis.${k}`))) {
        out.appendLine('configuration changed; restarting backend');
        backend?.restart();
      }
    }),
  );

  backend.start();
}

export function deactivate(): void {
  backend?.dispose();
  backend = undefined;
}
