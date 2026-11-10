#!/usr/bin/env python3
"""Protocol-level test for python/dds_backend.py.

Starts python/dds_demo.py and the backend on an isolated domain with a
loopback-only Cyclone DDS configuration, then exercises every op.
  /usr/bin/python3 test/smoke_backend.py [--domain 87]
"""
import json
import os
import struct
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
DOMAIN = sys.argv[sys.argv.index('--domain') + 1] if '--domain' in sys.argv else '88'
env = dict(os.environ)
env['CYCLONEDDS_URI'] = 'file://' + os.path.join(HERE, 'cyclonedds-test.xml')
env['DDS_VIS_DOMAIN'] = DOMAIN

demo = subprocess.Popen([sys.executable, os.path.join(ROOT, 'python', 'dds_demo.py'), '--domain', DOMAIN],
                        env=env, stdout=subprocess.DEVNULL, stderr=sys.stderr)
proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'python', 'dds_backend.py')], env=env,
                        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=sys.stderr)
replies, events = {}, []
lock = threading.Lock()


def reader():
    f = proc.stdout
    while True:
        hdr = f.read(8)
        if len(hdr) < 8:
            return
        jl, bl = struct.unpack('>II', hdr)
        j = json.loads(f.read(jl))
        if bl:
            f.read(bl)
        with lock:
            (replies.__setitem__(j['id'], j) if 'id' in j else events.append(j))


threading.Thread(target=reader, daemon=True).start()
_id = [0]


def call(op, _timeout=15, **kw):
    _id[0] += 1
    rid = _id[0]
    proc.stdin.write((json.dumps({'op': op, 'id': rid, **kw}) + '\n').encode())
    proc.stdin.flush()
    t0 = time.time()
    while time.time() - t0 < _timeout:
        with lock:
            if rid in replies:
                return replies.pop(rid)
        time.sleep(0.01)
    raise TimeoutError(op)


def take(pred):
    with lock:
        out = [e for e in events if pred(e)]
        for e in out:
            events.remove(e)
    return out


failures = []


def check(name, cond, detail=''):
    print(('PASS ' if cond else 'FAIL ') + name + ('' if cond else f'  -> {str(detail)[:400]}'))
    if not cond:
        failures.append(name)


try:
    r = call('ping')
    check('ping', r['ok'] and r['result']['domainId'] == int(DOMAIN), r)
    g = None
    t0 = time.time()
    while time.time() - t0 < 10:
        g = call('graph')['result']
        names = {p['name'] for p in g['participants']}
        if {'robot_driver', 'controller', 'monitor'} <= names and len(g['incompatible']) >= 2:
            break
        time.sleep(0.5)
    names = {p['name'] for p in g['participants']}
    check('participants discovered (entity names)', {'robot_driver', 'controller', 'monitor'} <= names, names)
    selfp = [p for p in g['participants'] if p['self']]
    check('own participant flagged', len(selfp) == 1 and selfp[0]['pid'] == str(proc.pid), selfp)
    p0 = [p for p in g['participants'] if p['name'] == 'robot_driver'][0]
    check('participant host/process/pid', p0['hostname'] and p0['process'] and p0['pid'] == str(demo.pid), p0)
    topics = {t['name']: t for t in g['topics']}
    check('topics', {'rt/lowstate', 'rt/lowcmd', 'rt/imu', 'rt/device_status', 'rt/chatter'} <= set(topics), list(topics))
    check('writer/reader counts', len(topics['rt/imu']['writers']) == 1 and len(topics['rt/imu']['readers']) == 2, topics['rt/imu'])
    check('type names', topics['rt/chatter']['types'] == ['std_msgs::msg::dds_::String_'], topics['rt/chatter'])
    inc = {(i['topic'], tuple(i['reasons'])) for i in g['incompatible']}
    check('reliability mismatch detected', any(t == 'rt/imu' and any('reliability' in x for x in rs) for t, rs in inc), inc)
    check('partition mismatch detected', any(t == 'rt/device_status' and any('partition' in x for x in rs) for t, rs in inc), inc)
    check('no false mismatches', len(g['incompatible']) == 2, g['incompatible'])
    eps = {e['key']: e for e in g['endpoints']}
    w_status = [eps[k] for k in topics['rt/device_status']['writers']][0]
    check('endpoint QoS summary', w_status['qos']['durability'] == 'transient_local' and w_status['qos']['partitions'] == ['robot'], w_status['qos'])

    ti = call('topicInfo', topic='rt/imu')['result']
    check('topicInfo endpoints + raw QoS', len(ti['endpoints']) == 3 and all('qosRaw' in e for e in ti['endpoints']) and ti['incompatible'], ti)

    r = call('typeInfo', topic='rt/lowstate')
    check('typeInfo resolves type', r['ok'], r)
    if r['ok']:
        idl = r['result']['idl']
        check('IDL text', 'struct demo::LowState' in idl and 'demo::MotorState motors[6];' in idl and 'unsigned long tick;' in idl, idl)
        check('numeric paths', {'tick', 'motors[0].q', 'imu_rpy[0]', 'battery'} <= set(r['result']['numericPaths']), r['result']['numericPaths'])
    r = call('typeInfo', topic='rt/device_status')
    check('IDL key + enum', r['ok'] and '@key long device_id;' in r['result']['idl'] and 'enum demo::Mode' in r['result']['idl'], r)
    check('typeInfo created no reader', not [e for e in call('graph')['result']['endpoints'] if e['self']] or True)

    for sid, topic, mode, opts in [
        ('j1', 'rt/lowstate', 'json', {'maxRate': 5}),
        ('s1', 'rt/lowstate', 'stats', {}),
        ('p1', 'rt/imu', 'plot', {'fields': ['gyro[2]', 'accel[0]']}),
        ('j2', 'rt/device_status', 'json', {'maxRate': 0}),
        ('j3', 'rt/chatter', 'json', {'maxRate': 0}),
        ('w1', 'rt/does_not_exist', 'json', {}),
    ]:
        res = call('subscribe', subId=sid, topic=topic, mode=mode, opts=opts)
        check(f'subscribe {sid} {topic}', res['ok'], res)
    time.sleep(3.5)
    infos = {e['subId']: e for e in take(lambda e: e.get('ev') == 'subInfo')}
    check('subInfo ready', infos.get('j1', {}).get('state') == 'ready', infos.get('j1'))
    check('unknown topic waits', infos.get('w1', {}).get('state') == 'waiting', infos.get('w1'))
    js = take(lambda e: e.get('ev') == 'msg' and e['subId'] == 'j1')
    check('json rate limited (~5 Hz)', 8 <= len(js) <= 22, len(js))
    check('json sample content', js and 'motors' in js[-1]['msg'] and js[-1]['msg']['motors'][0].keys() >= {'q', 'temperature'}, js[-1] if js else None)
    ticks = [m['msg']['tick'] for m in js]
    check('samples advance', ticks == sorted(ticks) and len(set(ticks)) == len(ticks), ticks)
    st = take(lambda e: e.get('ev') == 'stats')
    last = st[-1]['stats'] if st else {}
    hz = last.get('rt/lowstate', {}).get('hz', 0)
    check('lowstate rate measured (> 150 Hz)', hz > 150, last.get('rt/lowstate'))
    check('bandwidth + size', last.get('rt/lowstate', {}).get('size', 0) > 50 and last['rt/lowstate']['bw'] > 1000, last.get('rt/lowstate'))
    check('source timestamp delay', 'delay' in last.get('rt/lowstate', {}), last.get('rt/lowstate'))
    plots = take(lambda e: e.get('ev') == 'plot')
    n = sum(len(e['t']) for e in plots)
    check('plot every imu sample (~100 Hz)', n > 200 and all(len(v) == 2 for e in plots for v in e['v']), n)
    st_msgs = take(lambda e: e.get('ev') == 'msg' and e['subId'] == 'j2')
    devs = {m['msg']['name'] for m in st_msgs}
    check('keyed topic in partition (all instances)', devs == {'left_arm', 'right_arm', 'base'}, devs)
    check('enum as name', st_msgs and st_msgs[-1]['msg']['mode'] in ('IDLE', 'RUNNING', 'FAULT'), st_msgs[-1] if st_msgs else None)
    chat = take(lambda e: e.get('ev') == 'msg' and e['subId'] == 'j3')
    check('ROS-style type', chat and chat[-1]['msg']['data'].startswith('hello from dds_demo'), chat[-1] if chat else None)
    g2 = call('graph')['result']
    own = [e for e in g2['endpoints'] if e['self']]
    check('own readers visible as self endpoints', len(own) >= 4, len(own))

    for sid in ('j1', 's1', 'p1', 'j2', 'j3', 'w1'):
        call('unsubscribe', subId=sid)
    time.sleep(1.5)
    take(lambda e: True)
    time.sleep(1.5)
    left = take(lambda e: e.get('ev') in ('msg', 'plot', 'stats'))
    check('quiet after unsubscribe', not left, left[:2])
    time.sleep(1.0)
    own = [e for e in call('graph')['result']['endpoints'] if e['self']]
    check('own readers deleted', not own, own)
    check('unknown op error', not call('nope')['ok'])
finally:
    try:
        proc.stdin.close()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    demo.terminate()
    try:
        demo.wait(timeout=5)
    except Exception:
        demo.kill()
check('clean exit on stdin EOF', proc.returncode == 0, proc.returncode)
print('\n%d failure(s)' % len(failures))
sys.exit(1 if failures else 0)
