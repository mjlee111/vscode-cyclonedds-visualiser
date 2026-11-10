import * as fs from 'fs';
import type { SpawnSpec } from './backend';

export interface BackendConfig {
  /** Absolute path of python/dds_backend.py. */
  scriptPath: string;
  pythonPath: string;
  domainId: number;
  /** CYCLONEDDS_URI override (empty = inherit). */
  cycloneddsUri: string;
  graphPollInterval: number;
  typeLookupTimeout: number;
  reliableReaders?: boolean;
  workspaceFolders: string[];
  env?: NodeJS.ProcessEnv;
}

function expandVars(p: string, workspaceFolders: string[]): string {
  return p
    .replace(/\$\{workspaceFolder\}/g, workspaceFolders[0] ?? '')
    .replace(/\$\{env:([A-Za-z0-9_]+)\}/g, (_, n: string) => process.env[n] ?? '')
    .replace(/(^|file:\/\/)~(?=\/)/, (_, pre: string) => `${pre}${process.env.HOME ?? '~'}`);
}

export function resolvePython(pythonPath: string): string {
  if (pythonPath) return pythonPath.replace(/^~(?=\/)/, process.env.HOME ?? '~');
  if (process.platform === 'linux' && fs.existsSync('/usr/bin/python3')) return '/usr/bin/python3';
  return process.platform === 'win32' ? 'python' : 'python3';
}

export function buildSpawnSpec(cfg: BackendConfig): SpawnSpec {
  const python = resolvePython(cfg.pythonPath);
  const env: NodeJS.ProcessEnv = {
    ...(cfg.env ?? process.env),
    PYTHONUNBUFFERED: '1',
    DDS_VIS_DOMAIN: String(cfg.domainId),
    DDS_VIS_GRAPH_POLL: String(cfg.graphPollInterval),
    DDS_VIS_TYPE_TIMEOUT: String(cfg.typeLookupTimeout),
    DDS_VIS_RELIABLE_READERS: cfg.reliableReaders ? '1' : '0',
  };
  if (cfg.cycloneddsUri) {
    const uri = expandVars(cfg.cycloneddsUri.trim(), cfg.workspaceFolders);
    // a bare file path is accepted as well as file:// URIs and inline XML
    env.CYCLONEDDS_URI = uri.startsWith('<') || uri.includes('://') ? uri : `file://${uri}`;
  }
  if (python.startsWith('/usr/')) delete env.PYTHONHOME;
  return {
    command: python,
    args: ['-u', cfg.scriptPath],
    env,
    description: `${python} (domain ${cfg.domainId}${env.CYCLONEDDS_URI ? `, CYCLONEDDS_URI=${env.CYCLONEDDS_URI}` : ''})`,
  };
}
