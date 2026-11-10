// Types shared by the extension host, the dev harness and the webviews.

export interface DdsQosSummary {
  reliability: string;
  durability: string;
  history: string;
  ownership: string;
  deadline: string;
  liveliness: string;
  destinationOrder: string;
  representation: string[];
  partitions: string[];
  lifespan: string;
}

export interface DdsParticipant {
  key: string;
  name: string;
  hostname: string;
  process: string;
  pid: string;
  addresses: string;
  /** This visualiser's own participant. */
  self: boolean;
  label: string;
  host: string;
}

export interface DdsEndpoint {
  key: string;
  participant: string;
  kind: 'writer' | 'reader';
  topic: string;
  type: string;
  hasTypeInfo: boolean;
  name: string;
  qos: DdsQosSummary;
  self: boolean;
}

export interface DdsTopic {
  name: string;
  types: string[];
  /** Endpoint keys (own endpoints excluded). */
  writers: string[];
  readers: string[];
}

export interface DdsIncompat {
  topic: string;
  writer: string;
  reader: string;
  reasons: string[];
}

export interface DdsGraph {
  participants: DdsParticipant[];
  endpoints: DdsEndpoint[];
  topics: DdsTopic[];
  incompatible: DdsIncompat[];
  self: string;
}

export interface TopicStats {
  count: number;
  hz: number;
  bw: number;
  size: number;
  age: number | null;
  min?: number;
  max?: number;
  std?: number;
  mean?: number;
  stale?: boolean;
  delay?: number;
  delayAvg?: number;
}

export interface BackendInfo {
  domainId: number;
  cyclonedds: string;
  guid: string;
  hostname: string;
  pid: number;
  python: string;
  uri: string;
}

export interface BackendStatus {
  state: 'starting' | 'ready' | 'error' | 'stopped';
  info?: BackendInfo;
  error?: string;
}

export type ViewName = 'graph' | 'topics' | 'plot';

export type SubMode = 'stats' | 'json' | 'plot';

/** Messages sent from a webview to the host. */
export type ToHost =
  | { type: 'ready' }
  | { type: 'request'; id: number; op: string; params?: Record<string, unknown> }
  | { type: 'subscribe'; subId: string; topic: string; msgType?: string; mode: SubMode; opts?: Record<string, unknown> }
  | { type: 'unsubscribe'; subId: string }
  | { type: 'updateSub'; subId: string; opts: Record<string, unknown> }
  | { type: 'ack'; subId: string }
  | { type: 'command'; command: string; args?: unknown[] }
  | { type: 'setState'; state: unknown }
  | { type: 'saveFile'; name: string; data: Uint8Array | string; filters?: Record<string, string[]> }
  | { type: 'openFile'; path: string; line?: number }
  | { type: 'copy'; text: string }
  | { type: 'setTitle'; title: string };

/** Backend event forwarded to a webview. */
export interface BackendEvent {
  ev: string;
  subId?: string;
  pubId?: string;
  [k: string]: unknown;
}

/** Messages sent from the host to a webview. */
export type ToView =
  | { type: 'init'; view: ViewName; args: Record<string, unknown>; graph?: DdsGraph; stats: Record<string, TopicStats>; status: BackendStatus }
  | { type: 'graph'; graph: DdsGraph }
  | { type: 'stats'; stats: Record<string, TopicStats> }
  | { type: 'status'; status: BackendStatus }
  | { type: 'response'; id: number; ok: boolean; result?: unknown; error?: string; payload?: Uint8Array }
  | { type: 'event'; event: BackendEvent; payload?: Uint8Array }
  | { type: 'args'; args: Record<string, unknown> };
