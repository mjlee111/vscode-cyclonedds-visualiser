// Runs dist/extension.js against a stubbed `vscode` module and the real backend.
//   ROS_DOMAIN_ID=87 ROS_AUTOMATIC_DISCOVERY_RANGE=LOCALHOST node test/extension_host_test.js
'use strict';
const Module = require('module');
const path = require('path');

const root = path.resolve(__dirname, '..');
const DOMAIN = Number(process.env.DDS_TEST_DOMAIN ?? 88);
const CONFIG = { domainId: DOMAIN, cycloneddsUri: path.join(__dirname, 'cyclonedds-test.xml') };
const commands = new Map();
const panels = [];
const opened = [];
const treeViews = {};
const statusItems = [];
const errors = [];

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return { dispose() {} };
    };
  }
  fire(v) {
    for (const l of this.listeners) l(v);
  }
}
class Uri {
  constructor(p) {
    this.fsPath = p;
    this.path = p;
  }
  toString() {
    return `file://${this.fsPath}`;
  }
  static file(p) {
    return new Uri(p);
  }
  static joinPath(u, ...parts) {
    return new Uri(path.join(u.fsPath, ...parts));
  }
}
const saveEmitter = new EventEmitter();
class TreeItem {
  constructor(label, state) {
    this.label = label;
    this.collapsibleState = state;
  }
}
function makePanel(viewType, title) {
  const recv = new EventEmitter();
  const disposeEv = new EventEmitter();
  const panel = {
    viewType,
    title,
    posted: [],
    revealed: 0,
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-resource:',
      asWebviewUri: (u) => `vscode-resource:${u.fsPath}`,
      postMessage: async (m) => {
        panel.posted.push(m);
        return true;
      },
      onDidReceiveMessage: recv.event,
    },
    send: (m) => recv.fire(m),
    reveal() {
      panel.revealed++;
    },
    onDidDispose: disposeEv.event,
    onDidChangeViewState: () => ({ dispose() {} }),
    dispose() {
      disposeEv.fire();
    },
  };
  panels.push(panel);
  return panel;
}
const vscode = {
  EventEmitter,
  Uri,
  TreeItem,
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  MarkdownString: class {
    constructor(v) {
      this.value = v;
    }
  },
  Position: class {
    constructor(l, c) {
      this.line = l;
      this.character = c;
    }
  },
  Range: class {
    constructor(a, b) {
      this.start = a;
      this.end = b;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1 },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine: (l) => process.env.VERBOSE && console.log('[out]', l), show() {}, dispose() {} }),
    createTreeView: (id, opts) => {
      treeViews[id] = opts.treeDataProvider;
      return { dispose() {} };
    },
    createStatusBarItem: () => {
      const it = { text: '', show() {}, dispose() {} };
      statusItems.push(it);
      return it;
    },
    showErrorMessage: async (m) => {
      errors.push(m);
    },
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showQuickPick: async () => undefined,
    showSaveDialog: async () => undefined,
    showTextDocument: async () => undefined,
    createWebviewPanel: (viewType, title) => makePanel(viewType, title),
    registerWebviewPanelSerializer: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: (id, fn) => {
      commands.set(id, fn);
      return { dispose() {} };
    },
    executeCommand: async (id, ...args) => commands.get(id)?.(...args),
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (k, d) => (k in CONFIG ? CONFIG[k] : d) }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidSaveTextDocument: (fn) => saveEmitter.event(fn),
    openTextDocument: async (o) => {
      opened.push(o);
      return o;
    },
    fs: { writeFile: async () => undefined },
  },
  env: { clipboard: { writeText: async () => undefined } },
};

const origLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'vscode') return vscode;
  return origLoad.call(this, req, ...rest);
};

const fails = [];
function check(name, cond, detail) {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : `  -> ${JSON.stringify(detail)?.slice(0, 300)}`}`);
  if (!cond) fails.push(name);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  return undefined;
}

(async () => {
  const { spawn, execFileSync } = require('child_process');
  const demo = spawn('/usr/bin/python3', [path.join(root, 'python', 'dds_demo.py'), '--domain', String(DOMAIN)], {
    env: { ...process.env, CYCLONEDDS_URI: 'file://' + CONFIG.cycloneddsUri },
    stdio: 'ignore',
  });
  try {
    const ext = require(path.join(root, 'dist', 'extension.js'));
    const ctx = { subscriptions: [], extensionPath: root, extensionUri: Uri.file(root) };
    ext.activate(ctx);
    check('commands registered', ['ddsVis.openGraph', 'ddsVis.openTopics', 'ddsVis.openPlot', 'ddsVis.showType', 'ddsVis.restartBackend'].every((c) => commands.has(c)), [...commands.keys()]);
    const status = statusItems[0];
    const explorer = treeViews['ddsVis.explorer'];
    await until(() => {
      const secs = explorer.getChildren();
      return secs.length === 3 && explorer.getChildren(secs[0]).length >= 3;
    }, 20000);
    console.log('     status:', status.text);
    check('status bar: domain, participants, QoS warnings', new RegExp(`DDS D${DOMAIN} · [1-9]\\d* participants · \\d+ topics · \\$\\(warning\\) 2 QoS`).test(status.text), status.text);
    const sections = explorer.getChildren();
    check('explorer sections incl. QoS mismatches', sections.map((s) => s.section).join() === 'participants,topics,incompatible', sections);
    const parts = explorer.getChildren(sections[0]);
    const labels = parts.map((p) => p.participant.label);
    check('participants (self hidden)', ['robot_driver', 'controller', 'monitor'].every((l) => labels.includes(l)) && parts.every((p) => !p.participant.self), labels);
    const robot = parts.find((p) => p.participant.label === 'robot_driver');
    const groups = explorer.getChildren(robot);
    check('participant writer/reader groups', groups.map((g) => g.group).join() === 'writer,reader', groups.map((g) => g.group));
    const writers = explorer.getChildren(groups[0]);
    check('endpoint items', writers.some((e) => e.endpoint.topic === 'rt/lowstate'), writers.map((e) => e.endpoint.topic));
    for (const s of sections) for (const c of explorer.getChildren(s)) explorer.getTreeItem(c);
    for (const w of writers) explorer.getTreeItem(w);
    const topics = explorer.getChildren(sections[1]);
    const chat = explorer.getTreeItem(topics.find((t) => t.name === 'rt/chatter'));
    check('ROS 2 mapping hint', /ROS 2 topic \/chatter \(std_msgs\/msg\/String\)/.test(chat.tooltip.value), chat.tooltip.value);
    const inc = explorer.getChildren(sections[2]);
    check('mismatch items', inc.length === 2 && inc.every((i) => /reliability|partition/.test(explorer.getTreeItem(i).description)), inc.map((i) => explorer.getTreeItem(i).description));
    check('tools view', treeViews['ddsVis.tools'].getChildren().length === 3);

    await vscode.commands.executeCommand('ddsVis.openTopics', topics.find((t) => t.name === 'rt/lowstate'));
    const tp = panels[0];
    check('topics panel', tp && tp.viewType === 'ddsVis.topics' && /topics\.js/.test(tp.webview.html) && /nonce-/.test(tp.webview.html));
    tp.send({ type: 'ready' });
    const init = tp.posted.find((m) => m.type === 'init');
    check('init carries args + graph', init && init.args.topic === 'rt/lowstate' && init.graph && init.status.state === 'ready', init && init.args);
    tp.send({ type: 'subscribe', subId: 's-1', topic: 'rt/lowstate', mode: 'json', opts: { maxRate: 10 } });
    check('samples routed', !!(await until(() => tp.posted.some((m) => m.type === 'event' && m.event.subId === 's-1' && m.event.ev === 'msg' && m.event.msg.motors))));
    tp.send({ type: 'request', id: 3, op: 'typeInfo', params: { topic: 'rt/lowstate' } });
    const ti = await until(() => tp.posted.find((m) => m.type === 'response' && m.id === 3));
    check('typeInfo via hub', ti && ti.ok && /struct demo::LowState/.test(ti.result.idl), ti);
    await vscode.commands.executeCommand('ddsVis.openTopics', 'rt/imu');
    check('topics panel reused + args', panels.length === 1 && tp.posted.some((m) => m.type === 'args' && m.args.topic === 'rt/imu'));
    let forwarded = 0;
    const origExec = vscode.commands.executeCommand;
    vscode.commands.executeCommand = async (id, ...a) => {
      forwarded++;
      if (id === 'workbench.action.quit') throw new Error('must not forward');
      return origExec(id, ...a);
    };
    tp.send({ type: 'command', command: 'workbench.action.quit', args: [] });
    tp.send({ type: 'command', command: 'ddsVis.openPlot', args: [{ topic: 'rt/lowstate', field: 'motors[0].q' }] });
    await sleep(50);
    vscode.commands.executeCommand = origExec;
    check('only ddsVis.* commands forwarded', forwarded === 1, forwarded);
    check('plot panel from webview', panels.some((p) => p.viewType === 'ddsVis.plot'));
    await vscode.commands.executeCommand('ddsVis.showType', 'rt/device_status');
    check('showType document', opened.length === 1 && /@key long device_id;/.test(opened[0].content) && opened[0].language === 'cpp', opened[0] && opened[0].content.slice(0, 300));
    tp.dispose();
    await sleep(300);
    const before = tp.posted.length;
    await sleep(800);
    check('no events after dispose', tp.posted.length === before, tp.posted.length - before);
    check('no error notifications', errors.length === 0, errors);
    ext.deactivate();
    const t0 = Date.now();
    const children = () => {
      try {
        return execFileSync('pgrep', ['-a', '-P', String(process.pid)]).toString().trim().split('\n').filter((l) => /dds_backend/.test(l)).join('\n');
      } catch {
        return '';
      }
    };
    let kids = children();
    while (kids && Date.now() - t0 < 5000) {
      await sleep(100);
      kids = children();
    }
    check('backend exited on deactivate', kids === '', kids);
  } finally {
    demo.kill('SIGTERM');
  }
  console.log(`\n${fails.length} failure(s)`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
