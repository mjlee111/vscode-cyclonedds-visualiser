import type {
  DdsEndpoint,
  DdsParticipant,
  BackendEvent,
  BackendStatus,
  DdsGraph,
  SubMode,
  ToHost,
  ToView,
  TopicStats,
  ViewName,
} from '../../shared/protocol';

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const api: VsCodeApi = acquireVsCodeApi();

export type EventHandler = (ev: BackendEvent, payload?: Uint8Array) => void;

export interface Subscription {
  readonly id: string;
  readonly topic: string;
  update(opts: Record<string, unknown>): void;
  ack(): void;
  close(): void;
}

type Listener<T> = (v: T) => void;

let seq = 0;
const uid = Math.random().toString(36).slice(2, 8);
export function newId(prefix: string): string {
  return `${prefix}-${uid}-${++seq}`;
}

/** Webview side of the host protocol. */
class HostClient {
  view: ViewName | undefined;
  args: Record<string, unknown> = {};
  graph: DdsGraph | undefined;
  stats: Record<string, TopicStats> = {};
  status: BackendStatus = { state: 'starting' };

  private reqId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; binary: boolean }>();
  private handlers = new Map<string, EventHandler>();
  private subCmds = new Map<string, ToHost>();
  private listeners = {
    init: new Set<Listener<Record<string, unknown>>>(),
    graph: new Set<Listener<DdsGraph>>(),
    stats: new Set<Listener<Record<string, TopicStats>>>(),
    status: new Set<Listener<BackendStatus>>(),
    args: new Set<Listener<Record<string, unknown>>>(),
    pub: new Set<Listener<BackendEvent>>(),
  };
  private started = false;

  constructor() {
    window.addEventListener('message', (e: MessageEvent) => this.onMessage(e.data as ToView));
  }

  /** Call once all listeners are registered. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.post({ type: 'ready' });
  }

  post(msg: ToHost): void {
    api.postMessage(msg);
  }

  on(kind: 'init' | 'args', fn: Listener<Record<string, unknown>>): void;
  on(kind: 'graph', fn: Listener<DdsGraph>): void;
  on(kind: 'stats', fn: Listener<Record<string, TopicStats>>): void;
  on(kind: 'status', fn: Listener<BackendStatus>): void;
  on(kind: 'pub', fn: Listener<BackendEvent>): void;
  on(kind: keyof HostClient['listeners'], fn: Listener<never>): void {
    (this.listeners[kind] as Set<Listener<never>>).add(fn);
  }

  request<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.reqId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, binary: false });
      this.post({ type: 'request', id, op, params });
    });
  }

  /** Request whose reply carries binary data (e.g. mesh files). */
  requestBinary<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<{ result: T; payload?: Uint8Array }> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, binary: true });
      this.post({ type: 'request', id, op, params });
    });
  }

  subscribe(
    topic: string,
    mode: SubMode,
    opts: Record<string, unknown>,
    handler: EventHandler,
    msgType?: string,
  ): Subscription {
    const id = newId(mode);
    this.handlers.set(id, handler);
    const cmd: ToHost = { type: 'subscribe', subId: id, topic, mode, opts, msgType };
    this.subCmds.set(id, cmd);
    this.post(cmd);
    return {
      id,
      topic,
      update: (o) => this.post({ type: 'updateSub', subId: id, opts: o }),
      ack: () => this.post({ type: 'ack', subId: id }),
      close: () => {
        this.handlers.delete(id);
        this.subCmds.delete(id);
        this.post({ type: 'unsubscribe', subId: id });
      },
    };
  }

  command(command: string, ...args: unknown[]): void {
    this.post({ type: 'command', command, args });
  }

  copy(text: string): void {
    this.post({ type: 'copy', text });
  }

  setTitle(title: string): void {
    this.post({ type: 'setTitle', title });
  }

  saveFile(name: string, data: Uint8Array | string, filters?: Record<string, string[]>): void {
    this.post({ type: 'saveFile', name, data, filters });
  }

  /** Persisted per-panel UI state (survives reloads via the panel serializer). */
  loadState<T extends object>(defaults: T): T {
    const s = (api.getState() as { ui?: Partial<T> } | undefined)?.ui;
    return { ...defaults, ...(s ?? {}) };
  }

  saveState(ui: object): void {
    api.setState({ args: this.args, ui });
  }

  topicTypes(topic: string): string[] {
    return this.graph?.topics.find((t) => t.name === topic)?.types ?? [];
  }

  participant(key: string): DdsParticipant | undefined {
    return this.graph?.participants.find((p) => p.key === key);
  }

  endpoint(key: string): DdsEndpoint | undefined {
    return this.graph?.endpoints.find((e) => e.key === key);
  }

  private onMessage(m: ToView): void {
    switch (m.type) {
      case 'init':
        this.view = m.view;
        this.args = { ...((api.getState() as { args?: Record<string, unknown> })?.args ?? {}), ...m.args };
        this.graph = m.graph;
        this.stats = m.stats;
        this.status = m.status;
        this.listeners.init.forEach((f) => f(this.args));
        if (m.graph) this.listeners.graph.forEach((f) => f(m.graph!));
        this.listeners.status.forEach((f) => f(m.status));
        return;
      case 'graph':
        this.graph = m.graph;
        this.listeners.graph.forEach((f) => f(m.graph));
        return;
      case 'stats':
        this.stats = m.stats;
        this.listeners.stats.forEach((f) => f(m.stats));
        return;
      case 'status':
        this.status = m.status;
        this.listeners.status.forEach((f) => f(m.status));
        return;
      case 'args':
        this.args = { ...this.args, ...m.args };
        this.listeners.args.forEach((f) => f(m.args));
        return;
      case 'response': {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.ok) p.resolve(p.binary ? { result: m.result, payload: m.payload } : m.result);
        else p.reject(new Error(m.error ?? 'request failed'));
        return;
      }
      case 'event': {
        const ev = m.event;
        if (ev.subId !== undefined) {
          this.handlers.get(String(ev.subId))?.(ev, m.payload);
        } else if (ev.pubId !== undefined) {
          this.listeners.pub.forEach((f) => f(ev));
        }
        return;
      }
    }
  }
}

export const host = new HostClient();
