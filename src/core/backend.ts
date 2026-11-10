import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import type { BackendEvent, BackendStatus } from '../../shared/protocol';

export interface SpawnSpec {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  description: string;
}

/**
 * Incremental parser for frames [u32 BE json_len][u32 BE bin_len][json][payload].
 * Chunks are kept in a list and concatenated once per frame to avoid
 * quadratic copying for large (image / point cloud) payloads.
 */
export class FrameParser {
  private chunks: Buffer[] = [];
  private total = 0;
  private need = 8;
  private header: { j: number; b: number } | undefined;

  constructor(private readonly onFrame: (json: unknown, payload: Buffer | undefined) => void) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.total += chunk.length;
    while (this.total >= this.need) {
      const buf = this.take(this.need);
      if (!this.header) {
        const j = buf.readUInt32BE(0);
        const b = buf.readUInt32BE(4);
        this.header = { j, b };
        this.need = j + b;
        if (this.need === 0) {
          this.header = undefined;
          this.need = 8;
        }
      } else {
        const { j, b } = this.header;
        this.header = undefined;
        this.need = 8;
        let json: unknown;
        try {
          json = JSON.parse(buf.toString('utf8', 0, j));
        } catch {
          continue;
        }
        this.onFrame(json, b > 0 ? buf.subarray(j, j + b) : undefined);
      }
    }
  }

  reset(): void {
    this.chunks = [];
    this.total = 0;
    this.need = 8;
    this.header = undefined;
  }

  private take(n: number): Buffer {
    const first = this.chunks[0];
    if (first.length >= n) {
      const out = first.subarray(0, n);
      if (first.length === n) this.chunks.shift();
      else this.chunks[0] = first.subarray(n);
      this.total -= n;
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    let off = 0;
    while (off < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - off);
      c.copy(out, off, 0, k);
      off += k;
      if (k === c.length) this.chunks.shift();
      else this.chunks[0] = c.subarray(k);
    }
    this.total -= n;
    return out;
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
  raw: boolean;
}

export interface RawReply<T = unknown> {
  result: T;
  payload?: Buffer;
}

/**
 * Owns the Python rclpy backend process.
 * Events: 'status' (BackendStatus), 'event' (BackendEvent, payload?), 'ready'.
 */
export class DdsBackend extends EventEmitter {
  status: BackendStatus = { state: 'stopped' };
  private proc: ChildProcess | undefined;
  private parser = new FrameParser((j, p) => this.onFrame(j as Record<string, unknown>, p));
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stopping = false;
  private restarts: number[] = [];
  private stderrTail: string[] = [];
  private restartTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly spawnSpec: () => SpawnSpec,
    private readonly log: (line: string) => void,
  ) {
    super();
    this.setMaxListeners(100);
  }

  start(): void {
    if (this.proc) return;
    this.stopping = false;
    let spec: SpawnSpec;
    try {
      spec = this.spawnSpec();
    } catch (e) {
      this.setStatus({ state: 'error', error: String(e) });
      return;
    }
    this.log(`starting backend: ${spec.description}`);
    this.stderrTail = [];
    this.parser.reset();
    this.setStatus({ state: 'starting' });
    const proc = spawn(spec.command, spec.args, { env: spec.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    proc.stdout!.on('data', (c: Buffer) => this.parser.push(c));
    let errBuf = '';
    proc.stderr!.on('data', (c: Buffer) => {
      errBuf += c.toString('utf8');
      let i: number;
      while ((i = errBuf.indexOf('\n')) >= 0) {
        const line = errBuf.slice(0, i);
        errBuf = errBuf.slice(i + 1);
        this.log(line);
        this.stderrTail.push(line);
        if (this.stderrTail.length > 40) this.stderrTail.shift();
      }
    });
    proc.stdin!.on('error', () => undefined);
    proc.on('error', (err) => {
      this.log(`backend spawn error: ${err.message}`);
      this.setStatus({ state: 'error', error: err.message });
    });
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.proc = undefined;
      this.failPending(new Error('backend exited'));
      this.log(`backend exited (code=${code}, signal=${signal})`);
      if (this.stopping) {
        this.setStatus({ state: 'stopped' });
        return;
      }
      const tail = this.stderrTail.filter((l) => l.trim()).slice(-6).join('\n');
      this.setStatus({ state: 'error', error: tail || `backend exited with code ${code}` });
      this.scheduleRestart();
    });
  }

  stop(): void {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const proc = this.proc;
    if (!proc) {
      this.setStatus({ state: 'stopped' });
      return;
    }
    try {
      proc.stdin!.end();
    } catch {
      /* ignore */
    }
    const killTimer = setTimeout(() => proc.kill('SIGTERM'), 1500);
    proc.once('exit', () => clearTimeout(killTimer));
  }

  restart(): void {
    this.restarts = [];
    const proc = this.proc;
    if (!proc) {
      this.start();
      return;
    }
    this.stop();
    proc.once('exit', () => setTimeout(() => this.start(), 100));
  }

  get running(): boolean {
    return this.status.state === 'ready';
  }

  /** Fire-and-forget command. */
  send(cmd: Record<string, unknown>): void {
    const proc = this.proc;
    if (!proc || !proc.stdin || proc.stdin.destroyed) return;
    proc.stdin.write(JSON.stringify(cmd) + '\n');
  }

  request<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs = 20000): Promise<T> {
    return this.call<T>(op, params, timeoutMs, false) as Promise<T>;
  }

  /** Like request(), but also returns the binary payload of the reply (if any). */
  requestRaw<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs = 20000): Promise<RawReply<T>> {
    return this.call<T>(op, params, timeoutMs, true) as Promise<RawReply<T>>;
  }

  private call<T>(op: string, params: Record<string, unknown>, timeoutMs: number, raw: boolean): Promise<T | RawReply<T>> {
    return new Promise<T | RawReply<T>>((resolve, reject) => {
      if (!this.proc || this.status.state !== 'ready') {
        reject(new Error('DDS backend is not running'));
        return;
      }
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request ${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, raw });
      this.send({ ...params, op, id });
    });
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }

  private scheduleRestart(): void {
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < 60000);
    if (this.restarts.length >= 4) {
      this.log('backend crashed repeatedly; not restarting automatically (use "DDS: Restart Backend")');
      return;
    }
    this.restarts.push(now);
    const delay = 1000 * this.restarts.length;
    this.restartTimer = setTimeout(() => this.start(), delay);
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private setStatus(s: BackendStatus): void {
    this.status = s;
    this.emit('status', s);
  }

  private onFrame(j: Record<string, unknown>, payload: Buffer | undefined): void {
    if (typeof j.id === 'number') {
      const p = this.pending.get(j.id);
      if (!p) return;
      this.pending.delete(j.id);
      clearTimeout(p.timer);
      if (j.ok) p.resolve(p.raw ? { result: j.result, payload } : j.result);
      else p.reject(new Error(String(j.error ?? 'unknown error')));
      return;
    }
    if (j.ev === 'ready') {
      this.setStatus({ state: 'ready', info: j.info as BackendStatus['info'] });
      this.emit('ready');
      return;
    }
    if (j.ev === 'log') {
      this.log(`[${j.level}] ${j.text}`);
    }
    this.emit('event', j as BackendEvent, payload);
  }
}
