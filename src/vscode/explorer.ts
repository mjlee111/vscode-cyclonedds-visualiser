import * as vscode from 'vscode';
import type { DdsEndpoint, DdsGraph, DdsIncompat, DdsParticipant } from '../../shared/protocol';
import type { Hub } from '../core/hub';

type Section = 'participants' | 'topics' | 'incompatible';

export type ExplorerItem =
  | { kind: 'section'; section: Section }
  | { kind: 'host'; host: string }
  | { kind: 'participant'; participant: DdsParticipant }
  | { kind: 'group'; participant: DdsParticipant; group: 'writer' | 'reader' }
  | { kind: 'endpoint'; endpoint: DdsEndpoint; parent: string }
  | { kind: 'topic'; name: string; types: string[] }
  | { kind: 'incompat'; incompat: DdsIncompat; index: number }
  | { kind: 'message'; text: string };

/** ROS 2 maps topic /a/b to DDS topic rt/a/b and type pkg/msg/T to pkg::msg::dds_::T_. */
export function rosHint(topic: string, type: string): string | undefined {
  if (!/::dds_::/.test(type)) return undefined;
  const m = /^(rt|rq|rr)(\/.*)$/.exec(topic);
  const kind = m?.[1] === 'rq' ? 'service request' : m?.[1] === 'rr' ? 'service reply' : 'topic';
  const rosType = type.replace(/::dds_::/, '::').replace(/_$/, '').replace(/::/g, '/');
  return `ROS 2 ${kind} ${m ? m[2] : topic} (${rosType})`;
}

export class ExplorerProvider implements vscode.TreeDataProvider<ExplorerItem> {
  private readonly emitter = new vscode.EventEmitter<ExplorerItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly hub: Hub) {
    hub.onGraph(() => this.emitter.fire(undefined));
    hub.backend.on('status', () => this.emitter.fire(undefined));
  }

  private get graph(): DdsGraph | undefined {
    return this.hub.graph;
  }

  private participants(): DdsParticipant[] {
    return (this.graph?.participants ?? []).filter((p) => !p.self);
  }

  getChildren(el?: ExplorerItem): ExplorerItem[] {
    const g = this.graph;
    if (!el) {
      if (this.hub.status.state !== 'ready') {
        const s = this.hub.status;
        const text = s.state === 'starting' ? 'Starting DDS backend…' : s.state === 'error' ? `Backend error: ${s.error ?? ''}` : 'Backend stopped';
        return [{ kind: 'message', text }];
      }
      const out: ExplorerItem[] = [
        { kind: 'section', section: 'participants' },
        { kind: 'section', section: 'topics' },
      ];
      if (g?.incompatible.length) out.push({ kind: 'section', section: 'incompatible' });
      return out;
    }
    if (!g) return [];
    switch (el.kind) {
      case 'section':
        if (el.section === 'participants') {
          const hosts = [...new Set(this.participants().map((p) => p.host))].sort();
          if (hosts.length > 1) return hosts.map((host) => ({ kind: 'host', host }));
          return this.participants().map((participant) => ({ kind: 'participant', participant }));
        }
        if (el.section === 'topics') return g.topics.map((t) => ({ kind: 'topic', name: t.name, types: t.types }));
        return g.incompatible.map((incompat, index) => ({ kind: 'incompat', incompat, index }));
      case 'host':
        return this.participants()
          .filter((p) => p.host === el.host)
          .map((participant) => ({ kind: 'participant', participant }));
      case 'participant': {
        const out: ExplorerItem[] = [];
        for (const group of ['writer', 'reader'] as const) {
          if (g.endpoints.some((e) => e.participant === el.participant.key && e.kind === group)) out.push({ kind: 'group', participant: el.participant, group });
        }
        return out;
      }
      case 'group':
        return g.endpoints
          .filter((e) => e.participant === el.participant.key && e.kind === el.group)
          .map((endpoint) => ({ kind: 'endpoint', endpoint, parent: el.participant.key }));
      default:
        return [];
    }
  }

  getTreeItem(el: ExplorerItem): vscode.TreeItem {
    const g = this.graph;
    switch (el.kind) {
      case 'message': {
        const it = new vscode.TreeItem(el.text);
        it.iconPath = new vscode.ThemeIcon(this.hub.status.state === 'error' ? 'error' : 'loading~spin');
        it.command = { command: 'ddsVis.showOutput', title: 'Show log' };
        return it;
      }
      case 'section': {
        const label = { participants: 'Participants', topics: 'Topics', incompatible: 'QoS Mismatches' }[el.section];
        const count =
          el.section === 'participants' ? this.participants().length : el.section === 'topics' ? g?.topics.length : g?.incompatible.length;
        const it = new vscode.TreeItem(label, el.section === 'incompatible' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        it.id = `section:${el.section}`;
        it.description = String(count ?? 0);
        it.iconPath =
          el.section === 'incompatible'
            ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
            : new vscode.ThemeIcon(el.section === 'participants' ? 'vm' : 'radio-tower');
        return it;
      }
      case 'host': {
        const it = new vscode.TreeItem(el.host, vscode.TreeItemCollapsibleState.Expanded);
        it.id = `host:${el.host}`;
        it.iconPath = new vscode.ThemeIcon('server');
        it.description = String(this.participants().filter((p) => p.host === el.host).length);
        return it;
      }
      case 'participant': {
        const p = el.participant;
        const it = new vscode.TreeItem(p.label, vscode.TreeItemCollapsibleState.Collapsed);
        it.id = `participant:${p.key}`;
        const w = g?.endpoints.filter((e) => e.participant === p.key && e.kind === 'writer').length ?? 0;
        const r = g?.endpoints.filter((e) => e.participant === p.key && e.kind === 'reader').length ?? 0;
        it.description = `${w} writers · ${r} readers`;
        it.tooltip = new vscode.MarkdownString(
          [`**${p.label}**`, `GUID \`${p.key}\``, p.process ? `process ${p.process} (pid ${p.pid})` : '', p.hostname ? `host ${p.hostname}` : '', p.addresses ? `addresses ${p.addresses}` : '']
            .filter(Boolean)
            .join('\n\n'),
        );
        it.iconPath = new vscode.ThemeIcon('vm');
        it.contextValue = 'participant';
        return it;
      }
      case 'group': {
        const it = new vscode.TreeItem(el.group === 'writer' ? 'Writers' : 'Readers', vscode.TreeItemCollapsibleState.Collapsed);
        it.id = `group:${el.participant.key}:${el.group}`;
        it.iconPath = new vscode.ThemeIcon(el.group === 'writer' ? 'arrow-up' : 'arrow-down');
        return it;
      }
      case 'endpoint': {
        const e = el.endpoint;
        const it = new vscode.TreeItem(e.topic);
        it.id = `endpoint:${e.key}`;
        const bad = g?.incompatible.some((i) => i.writer === e.key || i.reader === e.key);
        it.description = `${e.type.split('::').pop()} · ${e.qos.reliability} · ${e.qos.durability}${e.qos.partitions.length ? ` · [${e.qos.partitions.join(',')}]` : ''}`;
        it.tooltip = new vscode.MarkdownString(
          [`**${e.kind} ${e.name || ''}** on \`${e.topic}\``, `type \`${e.type}\``, ...Object.entries(e.qos).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') || '(default)' : v}`)].join('\n\n'),
        );
        it.iconPath = bad ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')) : new vscode.ThemeIcon('symbol-event');
        it.contextValue = 'topic';
        it.command = { command: 'ddsVis.openTopics', title: 'Monitor', arguments: [{ topic: e.topic }] };
        return it;
      }
      case 'topic': {
        const it = new vscode.TreeItem(el.name);
        it.id = `topic:${el.name}`;
        const t = g?.topics.find((x) => x.name === el.name);
        const hint = rosHint(el.name, el.types[0] ?? '');
        it.description = `${el.types.map((x) => x.split('::').pop()).join(', ')} · ${t?.writers.length ?? 0}W ${t?.readers.length ?? 0}R`;
        it.tooltip = new vscode.MarkdownString([`**${el.name}**`, `\`${el.types.join(', ')}\``, hint ?? ''].filter(Boolean).join('\n\n'));
        const bad = g?.incompatible.some((i) => i.topic === el.name);
        it.iconPath = bad ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground')) : new vscode.ThemeIcon('symbol-event');
        it.contextValue = 'topic';
        it.command = { command: 'ddsVis.openTopics', title: 'Monitor', arguments: [{ topic: el.name }] };
        return it;
      }
      case 'incompat': {
        const i = el.incompat;
        const w = g?.endpoints.find((e) => e.key === i.writer);
        const r = g?.endpoints.find((e) => e.key === i.reader);
        const pl = (e?: DdsEndpoint) => g?.participants.find((p) => p.key === e?.participant)?.label ?? '?';
        const it = new vscode.TreeItem(i.topic);
        it.id = `incompat:${i.writer}:${i.reader}`;
        it.description = `${pl(w)} → ${pl(r)}: ${i.reasons[0]}`;
        it.tooltip = new vscode.MarkdownString([`**${i.topic}**`, `writer: ${pl(w)}`, `reader: ${pl(r)}`, ...i.reasons.map((x) => `- ${x}`)].join('\n\n'));
        it.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
        it.contextValue = 'topic';
        it.command = { command: 'ddsVis.openTopics', title: 'Monitor', arguments: [{ topic: i.topic }] };
        return it;
      }
    }
  }
}

interface Tool {
  label: string;
  command: string;
  icon: string;
  detail: string;
}

export const TOOLS: Tool[] = [
  { label: 'DDS Graph', command: 'ddsVis.openGraph', icon: 'type-hierarchy', detail: 'participants · topics · QoS matching' },
  { label: 'Topic Monitor', command: 'ddsVis.openTopics', icon: 'pulse', detail: 'Hz · bandwidth · QoS · samples' },
  { label: 'Plot', command: 'ddsVis.openPlot', icon: 'graph-line', detail: 'numeric fields over time' },
];

export class ToolsProvider implements vscode.TreeDataProvider<Tool> {
  getChildren(el?: Tool): Tool[] {
    return el ? [] : TOOLS;
  }

  getTreeItem(t: Tool): vscode.TreeItem {
    const it = new vscode.TreeItem(t.label);
    it.description = t.detail;
    it.iconPath = new vscode.ThemeIcon(t.icon);
    it.command = { command: t.command, title: t.label };
    return it;
  }
}
