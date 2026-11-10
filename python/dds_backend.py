#!/usr/bin/env python3
"""Cyclone DDS introspection backend for the VS Code Cyclone DDS visualiser.

Protocol
  stdin : one JSON command per line: {"op": str, "id"?: int, ...}
  stdout: binary frames  [u32 BE json_len][u32 BE bin_len][json utf-8][binary payload]
          - replies: {"id": int, "ok": bool, "result"|"error": ...}
          - events : {"ev": str, ...}
  stderr: human readable log

Discovery uses the DCPS builtin topics, message types are resolved at runtime
through XTypes type lookup, and topic statistics are taken from serialized
samples so that only displayed samples are deserialized.
"""

import concurrent.futures
import dataclasses
import enum
import fnmatch
import json
import math
import os
import queue
import struct
import sys
import threading
import time
import traceback
import typing
from collections import deque

# Keep the protocol channel private: anything printed to fd 1 goes to stderr.
_proto_fd = os.dup(1)
os.dup2(2, 1)
sys.stdout = sys.stderr
_proto = os.fdopen(_proto_fd, 'wb', buffering=1 << 20)
_proto_lock = threading.Lock()


def log(*args):
    print('[dds_backend]', *args, file=sys.stderr, flush=True)


try:
    from cyclonedds._clayer import ddspy_take
    from cyclonedds.builtin import (BuiltinDataReader, BuiltinTopicDcpsParticipant,
                                    BuiltinTopicDcpsPublication, BuiltinTopicDcpsSubscription)
    from cyclonedds.core import InstanceState, ReadCondition, SampleState, ViewState
    from cyclonedds.domain import DomainParticipant
    from cyclonedds.dynamic import get_types_for_typeid
    from cyclonedds.idl import IdlEnum, IdlStruct, IdlUnion
    from cyclonedds.qos import Policy, Qos
    from cyclonedds.sub import DataReader, Subscriber
    from cyclonedds.topic import Topic
    from cyclonedds.util import duration
except ImportError as e:  # pragma: no cover - reported to the extension
    log(f"cannot import the Cyclone DDS Python package: {e}. Install it with 'pip install cyclonedds' "
        "or set ddsVis.pythonPath.")
    sys.exit(3)

INF_NS = 0x7FFFFFFFFFFFFFFF
ANY_MASK = SampleState.Any | ViewState.Any | InstanceState.Any


# --------------------------------------------------------------------------
# Output channel
# --------------------------------------------------------------------------

def _sanitize(o):
    if isinstance(o, float):
        if math.isfinite(o):
            return o
        return 'NaN' if math.isnan(o) else ('Infinity' if o > 0 else '-Infinity')
    if isinstance(o, dict):
        return {k: _sanitize(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_sanitize(v) for v in o]
    return o


def emit(obj, payload=b''):
    try:
        j = json.dumps(obj, separators=(',', ':'), allow_nan=False)
    except ValueError:
        j = json.dumps(_sanitize(obj), separators=(',', ':'), allow_nan=False)
    jb = j.encode('utf-8')
    with _proto_lock:
        try:
            _proto.write(struct.pack('>II', len(jb), len(payload)))
            _proto.write(jb)
            if payload:
                _proto.write(payload)
            _proto.flush()
        except (BrokenPipeError, OSError):
            os._exit(0)


# --------------------------------------------------------------------------
# Samples and types
# --------------------------------------------------------------------------

def to_plain(v, limit=None):
    """Converts a decoded sample (IDL dataclasses) into JSON-friendly data."""
    if isinstance(v, IdlUnion):
        return {'discriminator': to_plain(v.discriminator, limit), 'value': to_plain(v.value, limit)}
    if dataclasses.is_dataclass(v) and not isinstance(v, type):
        return {f.name: to_plain(getattr(v, f.name), limit) for f in dataclasses.fields(v)}
    if isinstance(v, enum.Enum):
        return v.name
    if isinstance(v, bool):
        return v
    if isinstance(v, float):
        if math.isfinite(v):
            return v
        return 'NaN' if math.isnan(v) else ('Infinity' if v > 0 else '-Infinity')
    if isinstance(v, (int, str)):
        return v
    if isinstance(v, (bytes, bytearray)):
        seq = list(v)
        if limit is not None and len(seq) > limit:
            return {'__truncated__': True, 'length': len(seq), 'head': seq[:limit]}
        return seq
    if isinstance(v, (list, tuple)):
        n = len(v)
        if limit is not None and n > limit:
            return {'__truncated__': True, 'length': n, 'head': [to_plain(x, limit) for x in v[:limit]]}
        return [to_plain(x, limit) for x in v]
    return str(v)


def parse_path(path):
    """'motors[2].q' -> ['motors', 2, 'q']"""
    tokens = []
    for part in path.replace(']', '').split('.'):
        if not part:
            continue
        sub = part.split('[')
        if sub[0]:
            tokens.append(sub[0])
        for idx in sub[1:]:
            tokens.append(int(idx))
    return tokens


def resolve_path(v, tokens):
    for t in tokens:
        v = v[t] if isinstance(t, int) else getattr(v, t)
    return v


def to_number(v):
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, enum.Enum):
        return float(v.value)
    if isinstance(v, (int, float)):
        f = float(v)
        return f if math.isfinite(f) else None
    return None


_PRIM_IDL = {
    'int8': 'int8', 'int16': 'short', 'int32': 'long', 'int64': 'long long',
    'uint8': 'octet', 'uint16': 'unsigned short', 'uint32': 'unsigned long', 'uint64': 'unsigned long long',
    'float32': 'float', 'float64': 'double', 'char': 'char', 'wchar': 'wchar', 'byte': 'octet',
}
_NUMERIC = {'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64', 'float32', 'float64',
            'byte', 'char'}


def _idl_name(cls):
    n = getattr(cls, '__idl_typename__', None) or cls.__name__
    return n.replace('.', '::')


def _describe(hint):
    """Annotated type hint -> (kind, payload) used for IDL rendering and field discovery.
    kinds: prim(name) | str | bool | float | int | struct(cls) | enum(cls) | union(cls) | seq(inner, bound) | array(inner, dims)"""
    origin = typing.get_origin(hint)
    if origin is typing.Annotated:
        base, *meta = typing.get_args(hint)
        for m in meta:
            if isinstance(m, str):
                return ('prim', m)
            mname = type(m).__name__  # cyclonedds.idl.types holders: array, sequence, bounded_str, typedef
            if mname == 'array':
                return ('array', (m.subtype, m.length))
            if mname == 'sequence':
                return ('seq', (m.subtype, getattr(m, 'max_length', None)))
            if mname == 'bounded_str':
                return ('str', getattr(m, 'max_length', None))
            if mname == 'typedef' and hasattr(m, 'subtype'):
                return _describe(m.subtype)
        return _describe(base)
    if hint is str:
        return ('str', None)
    if hint is bool:
        return ('bool', None)
    if hint is float:
        return ('float', None)
    if hint is int:
        return ('int', None)
    if isinstance(hint, type):
        if issubclass(hint, IdlEnum):
            return ('enum', hint)
        if issubclass(hint, IdlUnion):
            return ('union', hint)
        if dataclasses.is_dataclass(hint):
            return ('struct', hint)
    if origin in (typing.Union,):
        args = [a for a in typing.get_args(hint) if a is not type(None)]
        if len(args) == 1:
            return _describe(args[0])
    return ('other', str(hint))


def _type_text(desc):
    kind, p = desc
    if kind == 'prim':
        return _PRIM_IDL.get(p, p)
    if kind == 'str':
        return f'string<{p}>' if p else 'string'
    if kind == 'bool':
        return 'boolean'
    if kind == 'float':
        return 'double'
    if kind == 'int':
        return 'long long'
    if kind in ('struct', 'enum', 'union'):
        return _idl_name(p)
    if kind == 'seq':
        inner, bound = p
        t = _type_text(_describe(inner))
        return f'sequence<{t}, {bound}>' if bound else f'sequence<{t}>'
    if kind == 'array':
        inner, dims = p
        return _type_text(_describe(inner))
    return str(p)


def _array_suffix(desc):
    kind, p = desc
    if kind != 'array':
        return ''
    inner, dims = p
    dims = dims if isinstance(dims, (list, tuple)) else [dims]
    return ''.join(f'[{d}]' for d in dims) + _array_suffix(_describe(inner))


def _hints(cls):
    try:
        return typing.get_type_hints(cls, include_extras=True)
    except Exception:
        return getattr(cls, '__annotations__', {})


def _key_fields(cls):
    keys = set()
    for name, ann in (getattr(cls, '__idl_field_annotations__', None) or {}).items():
        if isinstance(ann, dict) and ann.get('key'):
            keys.add(name)
    for k in getattr(cls, '__idl_annotations__', {}).get('keylist', []) or []:
        keys.add(k)
    return keys


def idl_text(root, deps):
    """Renders the resolved types as IDL (dependencies first)."""
    ordered, seen = [], set()

    def visit(cls):
        if cls in seen or not isinstance(cls, type):
            return
        seen.add(cls)
        if dataclasses.is_dataclass(cls) and not issubclass(cls, IdlUnion):
            for h in _hints(cls).values():
                for d in _deps_of(_describe(h)):
                    visit(d)
        ordered.append(cls)

    for d in list(deps.values()) + [root]:
        visit(d)
    out = []
    for cls in ordered:
        name = _idl_name(cls)
        if issubclass(cls, IdlEnum):
            out.append(f'enum {name} {{ ' + ', '.join(m.name for m in cls) + ' };')
        elif issubclass(cls, IdlUnion):
            out.append(f'union {name} switch (...) {{ /* {len(_hints(cls))} cases */ }};')
        elif dataclasses.is_dataclass(cls):
            keys = _key_fields(cls)
            lines = [f'struct {name} {{']
            for fname, h in _hints(cls).items():
                if fname.startswith('_'):
                    continue
                d = _describe(h)
                lines.append(f"  {'@key ' if fname in keys else ''}{_type_text(d)} {fname}{_array_suffix(d)};")
            lines.append('};')
            out.append('\n'.join(lines))
    return '\n\n'.join(out)


def _deps_of(desc):
    kind, p = desc
    if kind in ('struct', 'enum', 'union'):
        return [p]
    if kind in ('seq', 'array'):
        return _deps_of(_describe(p[0]))
    return []


def numeric_paths(cls, prefix='', depth=0, out=None):
    """Plot-able field paths of a struct type ('motors[0].q', 'tick', ...)."""
    out = [] if out is None else out
    if depth > 6 or len(out) > 500 or not dataclasses.is_dataclass(cls):
        return out
    for fname, h in _hints(cls).items():
        if fname.startswith('_'):
            continue
        path = f'{prefix}.{fname}' if prefix else fname
        d = _describe(h)
        while d[0] in ('seq', 'array'):
            path += '[0]'
            d = _describe(d[1][0])
        if d[0] == 'prim' and d[1] in _NUMERIC or d[0] in ('bool', 'float', 'int', 'enum'):
            out.append(path)
        elif d[0] == 'struct':
            numeric_paths(d[1], path, depth + 1, out)
    return out


# --------------------------------------------------------------------------
# QoS
# --------------------------------------------------------------------------

_DUR_ORDER = {'Volatile': 0, 'TransientLocal': 1, 'Transient': 2, 'Persistent': 3}
_LIVE_ORDER = {'Automatic': 0, 'ManualByParticipant': 1, 'ManualByTopic': 2}
_SNAKE = {'BestEffort': 'best_effort', 'Reliable': 'reliable', 'Volatile': 'volatile',
          'TransientLocal': 'transient_local', 'Transient': 'transient', 'Persistent': 'persistent',
          'KeepLast': 'keep_last', 'KeepAll': 'keep_all', 'Shared': 'shared', 'Exclusive': 'exclusive',
          'Automatic': 'automatic', 'ManualByParticipant': 'manual_by_participant', 'ManualByTopic': 'manual_by_topic',
          'ByReceptionTimestamp': 'by_reception_timestamp', 'BySourceTimestamp': 'by_source_timestamp'}


def fmt_dur(ns):
    if ns is None or ns >= INF_NS:
        return 'inf'
    s = ns / 1e9
    if s >= 1:
        return f'{s:g} s'
    return f'{s * 1e3:g} ms'


def qos_dict(qos):
    """Qos -> plain dict, plus participant properties (several Property entries)."""
    d = qos.asdict() if qos is not None else {}
    props = {}
    for p in (qos or []):
        if type(p).__name__ == 'Property':
            props[p.key] = p.value
    return d, props


def qos_summary(d):
    rel = d.get('Reliability', {}).get('kind', 'BestEffort')
    dur = d.get('Durability', {}).get('kind', 'Volatile')
    hist = d.get('History', {})
    hist_s = f"keep_last({hist.get('depth', 1)})" if hist.get('kind', 'KeepLast') == 'KeepLast' else 'keep_all'
    live = d.get('Liveliness', {})
    rep = d.get('DataRepresentation', {})
    reps = []
    if rep.get('use_cdrv0_representation', True):
        reps.append('XCDR1')
    if rep.get('use_xcdrv2_representation', False):
        reps.append('XCDR2')
    parts = list(d.get('Partition', {}).get('partitions') or [])
    return {
        'reliability': _SNAKE.get(rel, rel),
        'durability': _SNAKE.get(dur, dur),
        'history': hist_s,
        'ownership': _SNAKE.get(d.get('Ownership', {}).get('kind', 'Shared'), 'shared'),
        'deadline': fmt_dur(d.get('Deadline', {}).get('deadline', INF_NS)),
        'liveliness': f"{_SNAKE.get(live.get('kind', 'Automatic'), 'automatic')}, lease {fmt_dur(live.get('lease_duration', INF_NS))}",
        'destinationOrder': _SNAKE.get(d.get('DestinationOrder', {}).get('kind', 'ByReceptionTimestamp'), 'by_reception_timestamp'),
        'representation': reps,
        'partitions': parts,
        'lifespan': fmt_dur(d.get('Lifespan', {}).get('lifespan', INF_NS)),
    }


def _partition_match(a, b):
    a = a or ['']
    b = b or ['']
    for x in a:
        for y in b:
            if x == y or fnmatch.fnmatchcase(y, x) or fnmatch.fnmatchcase(x, y):
                return True
    return False


def incompatibilities(w, r):
    """Reasons why writer `w` and reader `r` (raw QoS dicts) cannot match."""
    reasons = []
    wr, rr = w['_qos'], r['_qos']
    if w['type'] != r['type']:
        reasons.append(f"type name differs ({w['type']} vs {r['type']})")
    if wr.get('Reliability', {}).get('kind', 'BestEffort') == 'BestEffort' and \
            rr.get('Reliability', {}).get('kind', 'BestEffort') == 'Reliable':
        reasons.append('reliability: reader requests reliable, writer offers best effort')
    wd = _DUR_ORDER.get(wr.get('Durability', {}).get('kind', 'Volatile'), 0)
    rd = _DUR_ORDER.get(rr.get('Durability', {}).get('kind', 'Volatile'), 0)
    if wd < rd:
        reasons.append(f"durability: reader requests {qos_summary(rr)['durability']}, writer offers {qos_summary(wr)['durability']}")
    if wr.get('Ownership', {}).get('kind', 'Shared') != rr.get('Ownership', {}).get('kind', 'Shared'):
        reasons.append('ownership kind differs')
    if wr.get('Deadline', {}).get('deadline', INF_NS) > rr.get('Deadline', {}).get('deadline', INF_NS):
        reasons.append('deadline: writer offers a longer deadline than the reader requests')
    wl, rl = wr.get('Liveliness', {}), rr.get('Liveliness', {})
    if _LIVE_ORDER.get(wl.get('kind', 'Automatic'), 0) < _LIVE_ORDER.get(rl.get('kind', 'Automatic'), 0) or \
            wl.get('lease_duration', INF_NS) > rl.get('lease_duration', INF_NS):
        reasons.append('liveliness: writer offers weaker liveliness than the reader requests')
    if wr.get('DestinationOrder', {}).get('kind') == 'ByReceptionTimestamp' and \
            rr.get('DestinationOrder', {}).get('kind') == 'BySourceTimestamp':
        reasons.append('destination order: reader requests by-source-timestamp')
    if not set(w['qos']['representation']) & set(r['qos']['representation']):
        reasons.append('data representation: no common representation')
    if not _partition_match(w['qos']['partitions'], r['qos']['partitions']):
        reasons.append(f"partition: writer {w['qos']['partitions'] or ['(default)']} vs reader {r['qos']['partitions'] or ['(default)']}")
    return reasons


# --------------------------------------------------------------------------
# Statistics
# --------------------------------------------------------------------------

class TopicStats:
    WINDOW = 5.0
    MAX_SAMPLES = 20000

    def __init__(self):
        self.times = deque()
        self.sizes = deque()
        self.count = 0
        self.last = None
        self.delays = deque(maxlen=200)

    def add(self, t, size):
        self.times.append(t)
        self.sizes.append(size)
        self.count += 1
        self.last = t
        lim = t - self.WINDOW
        while self.times and (self.times[0] < lim or len(self.times) > self.MAX_SAMPLES):
            self.times.popleft()
            self.sizes.popleft()

    def summary(self, now):
        n = len(self.times)
        out = {'count': self.count, 'hz': 0.0, 'bw': 0.0, 'size': 0,
               'age': None if self.last is None else now - self.last}
        if n:
            out['size'] = sum(self.sizes) / n
        if n >= 2:
            ts = list(self.times)
            periods = [b - a for a, b in zip(ts, ts[1:])]
            mean = sum(periods) / len(periods)
            span = ts[-1] - ts[0]
            stale = (now - self.last) > max(2.0, 4.0 * mean)
            if span > 0 and not stale:
                out['hz'] = (n - 1) / span
                out['bw'] = sum(self.sizes) / max(span, now - ts[0])
            out['min'] = min(periods)
            out['max'] = max(periods)
            out['std'] = math.sqrt(sum((p - mean) ** 2 for p in periods) / len(periods))
            out['mean'] = mean
            out['stale'] = stale
        if self.delays:
            d = list(self.delays)
            out['delay'] = d[-1]
            out['delayAvg'] = sum(d) / len(d)
        return out


# --------------------------------------------------------------------------
# Consumers
# --------------------------------------------------------------------------

class Consumer:
    default_rate = 10.0

    def __init__(self, sub_id, opts):
        self.sub_id = sub_id
        self.opts = dict(opts or {})
        self.last_sent = 0.0

    def update(self, opts):
        self.opts.update(opts or {})

    def due(self, now):
        r = float(self.opts.get('maxRate', self.default_rate) or 0)
        return r <= 0 or (now - self.last_sent) >= (1.0 / r) * 0.98

    def handle(self, sample, info, now, topic):
        pass

    def tick(self, now):
        pass


class StatsConsumer(Consumer):
    def due(self, now):
        return False


class JsonConsumer(Consumer):
    def handle(self, sample, info, now, topic):
        limit = int(self.opts.get('arrayLimit', 64))
        emit({'ev': 'msg', 'subId': self.sub_id, 't': time.time(), 'type': topic.type_name,
              'instance': info.instance_handle, 'msg': to_plain(sample, limit)})
        self.last_sent = now


class PlotConsumer(Consumer):
    default_rate = 0.0

    def __init__(self, sub_id, opts):
        super().__init__(sub_id, opts)
        self.buf_t, self.buf_v = [], []
        self._compile()

    def _compile(self):
        self.paths = list(self.opts.get('fields') or [])
        self.tokens = []
        for p in self.paths:
            try:
                self.tokens.append(parse_path(p))
            except Exception:
                self.tokens.append(None)

    def update(self, opts):
        super().update(opts)
        self._compile()

    def handle(self, sample, info, now, topic):
        t = None
        if self.opts.get('useSourceTimestamp') and info.source_timestamp > 0:
            t = info.source_timestamp / 1e9
        if t is None:
            t = time.time()
        vals = []
        for tok in self.tokens:
            try:
                vals.append(to_number(resolve_path(sample, tok)) if tok is not None else None)
            except Exception:
                vals.append(None)
        self.buf_t.append(t)
        self.buf_v.append(vals)
        self.last_sent = now
        if len(self.buf_t) > 5000:
            self.tick(now)

    def tick(self, now):
        if self.buf_t:
            emit({'ev': 'plot', 'subId': self.sub_id, 'fields': self.paths, 't': self.buf_t, 'v': self.buf_v})
            self.buf_t, self.buf_v = [], []


CONSUMERS = {'stats': StatsConsumer, 'json': JsonConsumer, 'plot': PlotConsumer}


# --------------------------------------------------------------------------
# Topic readers
# --------------------------------------------------------------------------

class TopicReader:
    """One dynamic-type DataReader per topic, shared by all consumers."""

    def __init__(self, backend, name):
        self.b = backend
        self.name = name
        self.type_name = None
        self.cls = None
        self.deps = {}
        self.state = 'waiting'   # waiting | resolving | ready | error
        self.error = None
        self.future = None
        self.reader = None
        self.subscriber = None
        self.qos_key = None
        self.consumers = {}
        self.stats = TopicStats()

    def _notify(self):
        for c in self.consumers.values():
            emit({'ev': 'subInfo', 'subId': c.sub_id, 'topic': self.name, 'state': self.state,
                  'type': self.type_name, 'error': self.error, 'qos': self.qos_key})

    def ensure(self):
        eps = [e for e in self.b.endpoints.values() if e['topic'] == self.name and not e['self']]
        writers = [e for e in eps if e['kind'] == 'writer']
        if self.cls is None:
            if self.future is not None:
                return
            with_type = [e for e in writers + eps if e['_type_id'] is not None]
            if not eps:
                self._set('waiting', None)
                return
            if not with_type:
                self._set('error', 'no endpoint of this topic publishes XTypes type information '
                                   '(needs Cyclone DDS >= 0.10 or another XTypes-capable DDS)')
                return
            src = with_type[0]
            self.type_name = src['type']
            self._set('resolving', None)
            self.future = self.b.pool.submit(get_types_for_typeid, self.b.dp, src['_type_id'],
                                              duration(seconds=self.b.type_timeout))
            return
        if not self.consumers:
            self._close_reader()  # type known, but nobody is listening
            self.qos_key = None
            return
        # adapt reader QoS so that it matches every current writer
        qos, key = self._reader_qos(writers)
        if self.reader is not None and key == self.qos_key:
            return
        self._close_reader()
        try:
            self.subscriber = Subscriber(self.b.dp, qos=Qos(Policy.Partition(qos['partitions'])) if qos['partitions'] else None)
            self.reader = DataReader(self.subscriber, self.b.topic(self.name, self.cls), qos=qos['qos'])
            self.qos_key = key
            self._set('ready', None)
        except Exception as e:
            self._set('error', f'cannot create reader: {e}')

    def _reader_qos(self, writers):
        rel = 'Reliable'
        dur = 'TransientLocal'
        own = 'Shared'
        parts = set()
        for w in writers:
            q = w['_qos']
            if q.get('Reliability', {}).get('kind', 'BestEffort') == 'BestEffort':
                rel = 'BestEffort'
            if _DUR_ORDER.get(q.get('Durability', {}).get('kind', 'Volatile'), 0) < _DUR_ORDER['TransientLocal']:
                dur = 'Volatile'
            own = q.get('Ownership', {}).get('kind', own)
            parts.update(w['qos']['partitions'] or [])
        if not writers:
            rel, dur = 'BestEffort', 'Volatile'
        if not self.b.reliable_readers:
            rel = 'BestEffort'
        policies = [
            Policy.Reliability.Reliable(duration(milliseconds=100)) if rel == 'Reliable' else Policy.Reliability.BestEffort,
            Policy.Durability.TransientLocal if dur == 'TransientLocal' else Policy.Durability.Volatile,
            Policy.History.KeepLast(256),
            Policy.Ownership.Exclusive if own == 'Exclusive' else Policy.Ownership.Shared,
            Policy.DataRepresentation(use_cdrv0_representation=True, use_xcdrv2_representation=True),
        ]
        partitions = sorted(parts)
        key = f"{_SNAKE[rel]}/{_SNAKE[dur]}/{own.lower()}/{','.join(partitions) or '(default)'}"
        return {'qos': Qos(*policies), 'partitions': partitions}, key

    def _set(self, state, error):
        changed = (state, error) != (self.state, self.error)
        self.state, self.error = state, error
        if changed:
            self._notify()

    def check_future(self):
        if self.future is None or not self.future.done():
            return
        fut, self.future = self.future, None
        try:
            self.cls, self.deps = fut.result()
        except Exception as e:
            self._set('error', f'type lookup failed: {e}')
            return
        self.ensure()

    def poll(self, now):
        if self.reader is None:
            return
        while True:
            try:
                batch = ddspy_take(self.reader._ref, ANY_MASK, 256)
            except Exception as e:
                log('take failed', self.name, e)
                return
            if isinstance(batch, int) or not batch:
                return
            due = [c for c in self.consumers.values() if c.due(now)]
            plot = [c for c in self.consumers.values() if isinstance(c, PlotConsumer)]
            latest = {}  # newest sample of each instance in this batch
            wall = time.time()
            for data, info in batch:
                if not info.valid_data:
                    continue
                self.stats.add(now, len(data))
                if info.source_timestamp > 0:
                    self.stats.delays.append(wall - info.source_timestamp / 1e9)
                latest[info.instance_handle] = (data, info)
                if plot:
                    sample = self._decode(data)
                    if sample is not None:
                        for c in plot:
                            c.handle(sample, info, now, self)
            others = [c for c in due if not isinstance(c, PlotConsumer)]
            if others:
                for data, info in latest.values():
                    sample = self._decode(data)
                    if sample is not None:
                        for c in others:
                            c.handle(sample, info, now, self)
            if len(batch) < 256:
                return

    def _decode(self, data):
        try:
            return self.cls.deserialize(data)
        except Exception as e:
            for c in self.consumers.values():
                emit({'ev': 'subError', 'subId': c.sub_id, 'error': f'decode failed: {e}'})
            return None

    def _close_reader(self):
        for ent in (self.reader, self.subscriber):  # reader first, then its subscriber
            if ent is not None:
                try:
                    ent.__del__()  # deletes the DDS entity now (idempotent)
                except Exception:
                    pass
        self.reader = None
        self.subscriber = None

    def close(self):
        self._close_reader()


# --------------------------------------------------------------------------
# Backend
# --------------------------------------------------------------------------

class Backend:
    def __init__(self):
        self.domain = int(os.environ.get('DDS_VIS_DOMAIN', '0') or 0)
        self.type_timeout = float(os.environ.get('DDS_VIS_TYPE_TIMEOUT', '5') or 5)
        self.poll = float(os.environ.get('DDS_VIS_GRAPH_POLL', '1.0') or 1.0)
        # best-effort readers never apply back-pressure to writers; reliable ones are opt-in
        self.reliable_readers = os.environ.get('DDS_VIS_RELIABLE_READERS', '0') == '1'
        self.dp = DomainParticipant(self.domain)
        self.self_key = str(self.dp.guid)
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        self.cmd_q = queue.Queue()
        self.exiting = False
        self.topics = {}          # topic name -> TopicReader
        self.consumers = {}       # subId -> (TopicReader, Consumer)
        self.dds_topics = {}      # (name, type idl name) -> Topic (Cyclone keeps one per name)
        self.deferred = []        # (rid, fn) replies waiting for type resolution
        self.endpoints = {}
        self.graph_sig = None
        self.graph = None
        self.pr = BuiltinDataReader(self.dp, BuiltinTopicDcpsParticipant)
        self.wr = BuiltinDataReader(self.dp, BuiltinTopicDcpsPublication)
        self.rr = BuiltinDataReader(self.dp, BuiltinTopicDcpsSubscription)
        alive = SampleState.Any | ViewState.Any | InstanceState.Alive
        self.pr_alive = ReadCondition(self.pr, alive)
        self.wr_alive = ReadCondition(self.wr, alive)
        self.rr_alive = ReadCondition(self.rr, alive)

    def topic(self, name, cls):
        key = name
        t = self.dds_topics.get(key)
        if t is None:
            t = self.dds_topics[key] = Topic(self.dp, name, cls)
        return t

    # ---- plumbing ------------------------------------------------------
    def reader_thread(self):
        for line in sys.stdin.buffer:
            line = line.strip()
            if not line:
                continue
            try:
                self.cmd_q.put(json.loads(line))
            except Exception as e:
                log('bad command', e)
        self.cmd_q.put({'op': '__exit__'})

    def reply(self, rid, result=None, error=None):
        if rid is None:
            return
        if error is not None:
            emit({'id': rid, 'ok': False, 'error': error})
        else:
            emit({'id': rid, 'ok': True, 'result': result})

    def dispatch(self, cmd):
        op = cmd.get('op', '')
        rid = cmd.get('id')
        if op == '__exit__':
            self.exiting = True
            return
        fn = getattr(self, 'op_' + op, None)
        if fn is None:
            self.reply(rid, error=f'unknown op {op}')
            return
        try:
            self.reply(rid, result=fn(cmd))
        except Deferred as d:
            self.deferred.append((rid, d.fn, time.monotonic() + d.timeout))
        except Exception as e:
            log(f'op {op} failed:', traceback.format_exc())
            self.reply(rid, error=str(e) or e.__class__.__name__)

    def info(self):
        import importlib.metadata
        try:
            ver = importlib.metadata.version('cyclonedds')
        except Exception:
            ver = '?'
        return {'domainId': self.domain, 'cyclonedds': ver, 'guid': self.self_key,
                'pid': os.getpid(), 'python': sys.version.split()[0], 'uri': os.environ.get('CYCLONEDDS_URI', ''),
                'reliableReaders': self.reliable_readers}

    def run(self):
        threading.Thread(target=self.reader_thread, daemon=True).start()
        emit({'ev': 'ready', 'info': self.info()})
        next_graph = next_stats = next_tick = 0.0
        try:
            while not self.exiting:
                now = time.monotonic()
                while True:
                    try:
                        cmd = self.cmd_q.get_nowait()
                    except queue.Empty:
                        break
                    self.dispatch(cmd)
                    if self.exiting:
                        break
                for tr in list(self.topics.values()):
                    tr.check_future()
                    tr.poll(now)
                self._check_deferred(now)
                if now >= next_graph:
                    next_graph = now + self.poll
                    self.poll_graph()
                if now >= next_stats:
                    next_stats = now + 1.0
                    self.emit_stats(now)
                if now >= next_tick:
                    next_tick = now + 0.05
                    for _, c in list(self.consumers.values()):
                        c.tick(now)
                time.sleep(0.004)
        except KeyboardInterrupt:
            pass
        finally:
            for tr in self.topics.values():
                tr.close()
            self.pool.shutdown(wait=False, cancel_futures=True)

    def _check_deferred(self, now):
        keep = []
        for rid, fn, deadline in self.deferred:
            try:
                res = fn()
            except Deferred:
                if now > deadline:
                    self.reply(rid, error='timed out waiting for type information')
                else:
                    keep.append((rid, fn, deadline))
                continue
            except Exception as e:
                self.reply(rid, error=str(e))
                continue
            self.reply(rid, result=res)
        self.deferred = keep

    # ---- discovery -----------------------------------------------------
    def _endpoint(self, e, kind):
        d, _ = qos_dict(e.qos)
        pkey = str(e.participant_key)
        return {'key': str(e.key), 'participant': pkey, 'kind': kind, 'topic': e.topic_name,
                'type': e.type_name.replace('.', '::'), 'hasTypeInfo': e.type_id is not None,
                'name': d.get('EntityName', {}).get('name', ''), 'qos': qos_summary(d),
                'self': pkey == self.self_key, '_qos': d, '_type_id': e.type_id}

    def snapshot(self):
        parts = []
        for p in self.pr.read(N=100000, condition=self.pr_alive):
            d, props = qos_dict(p.qos)
            key = str(p.key)
            name = d.get('EntityName', {}).get('name', '')
            host = props.get('__Hostname', '')
            proc = props.get('__ProcessName', '')
            pid = props.get('__Pid', '')
            label = name or (f'{proc} ({pid})' if proc else key.split('-')[0])
            parts.append({'key': key, 'name': name, 'hostname': host, 'process': proc, 'pid': pid,
                          'addresses': props.get('__NetworkAddresses', ''), 'self': key == self.self_key,
                          'label': label, 'host': host or '?'})
        eps = {}
        for e in self.wr.read(N=100000, condition=self.wr_alive):
            ep = self._endpoint(e, 'writer')
            eps[ep['key']] = ep
        for e in self.rr.read(N=100000, condition=self.rr_alive):
            if e.topic_name.startswith('DCPS') and e.type_name.startswith('org::eclipse::cyclonedds::builtin'):
                continue  # Cyclone's own builtin-topic readers
            ep = self._endpoint(e, 'reader')
            eps[ep['key']] = ep
        self.endpoints = eps
        topics = {}
        for ep in eps.values():
            if ep['self']:
                continue
            t = topics.setdefault(ep['topic'], {'name': ep['topic'], 'types': [], 'writers': [], 'readers': []})
            if ep['type'] not in t['types']:
                t['types'].append(ep['type'])
            t['writers' if ep['kind'] == 'writer' else 'readers'].append(ep['key'])
        incompat = []
        for t in topics.values():
            for wk in t['writers']:
                for rk in t['readers']:
                    reasons = incompatibilities(eps[wk], eps[rk])
                    if reasons:
                        incompat.append({'topic': t['name'], 'writer': wk, 'reader': rk, 'reasons': reasons})
        public = [{k: v for k, v in ep.items() if not k.startswith('_')} for ep in eps.values()]
        return {'participants': sorted(parts, key=lambda p: (p['host'], p['label'])),
                'endpoints': sorted(public, key=lambda e: (e['topic'], e['kind'])),
                'topics': sorted(topics.values(), key=lambda t: t['name']),
                'incompatible': incompat, 'self': self.self_key}

    def poll_graph(self):
        try:
            g = self.snapshot()
        except Exception:
            log('graph poll failed', traceback.format_exc())
            return
        sig = json.dumps(g, sort_keys=True)
        if sig != self.graph_sig:
            self.graph_sig = sig
            self.graph = g
            emit({'ev': 'graph', 'graph': g})
        for tr in list(self.topics.values()):
            if tr.consumers:
                tr.ensure()

    def emit_stats(self, now):
        out = {name: tr.stats.summary(now) for name, tr in self.topics.items() if tr.consumers}
        if out:
            emit({'ev': 'stats', 'stats': out})

    # ---- ops -----------------------------------------------------------
    def op_ping(self, cmd):
        return self.info()

    def op_graph(self, cmd):
        if self.graph is None:
            self.poll_graph()
        return self.graph

    def op_topicInfo(self, cmd):
        name = cmd['topic']
        eps = [e for e in self.endpoints.values() if e['topic'] == name]
        out = []
        for e in eps:
            full = {k: v for k, v in e.items() if not k.startswith('_')}
            full['qosRaw'] = _sanitize({k: {kk: ('inf' if isinstance(vv, int) and vv >= INF_NS else vv)
                                            for kk, vv in v.items()} if isinstance(v, dict) else v
                                        for k, v in e['_qos'].items()})
            out.append(full)
        incompat = [i for i in (self.graph or {}).get('incompatible', []) if i['topic'] == name]
        return {'topic': name, 'endpoints': out, 'incompatible': incompat}

    def op_typeInfo(self, cmd):
        name = cmd['topic']
        tr = self.topics.get(name)
        temp = tr is None
        if temp:
            tr = self.topics[name] = TopicReader(self, name)

        def result():
            if tr.cls is not None:
                if temp and not tr.consumers:
                    pass  # keep the resolved type cached; no reader is created without consumers
                return {'topic': name, 'type': tr.type_name, 'idl': idl_text(tr.cls, tr.deps),
                        'numericPaths': numeric_paths(tr.cls)}
            if tr.state == 'error':
                raise ValueError(tr.error)
            if tr.future is None:
                tr.ensure()
                if tr.state in ('error', 'waiting') and tr.future is None:
                    raise ValueError(tr.error or 'no endpoint of this topic is known')
            raise Deferred(result, self.type_timeout + 2)

        return result()

    def op_subscribe(self, cmd):
        sub_id = cmd['subId']
        if sub_id in self.consumers:
            self.op_unsubscribe({'subId': sub_id})
        cls = CONSUMERS.get(cmd.get('mode', 'json'))
        if cls is None:
            raise ValueError(f"unknown mode {cmd.get('mode')}")
        name = cmd['topic']
        tr = self.topics.get(name)
        if tr is None:
            tr = self.topics[name] = TopicReader(self, name)
        c = cls(sub_id, cmd.get('opts'))
        tr.consumers[sub_id] = c
        self.consumers[sub_id] = (tr, c)
        tr.ensure()
        emit({'ev': 'subInfo', 'subId': sub_id, 'topic': name, 'state': tr.state, 'type': tr.type_name,
              'error': tr.error, 'qos': tr.qos_key})
        return {'topic': name, 'state': tr.state}

    def op_unsubscribe(self, cmd):
        entry = self.consumers.pop(cmd['subId'], None)
        if entry is None:
            return False
        tr, c = entry
        tr.consumers.pop(c.sub_id, None)
        if not tr.consumers:
            tr.close()
            tr.qos_key = None
        return True

    def op_updateSub(self, cmd):
        entry = self.consumers.get(cmd['subId'])
        if entry:
            entry[1].update(cmd.get('opts'))
        return bool(entry)

    def op_ack(self, cmd):
        return None


class Deferred(Exception):
    """Raised by an op whose reply must wait (e.g. for type lookup)."""

    def __init__(self, fn, timeout):
        super().__init__('deferred')
        self.fn = fn
        self.timeout = timeout


def main():
    try:
        backend = Backend()
    except Exception as e:
        log(f'cannot create a DomainParticipant: {e}')
        sys.exit(4)
    log('started', json.dumps(backend.info()))
    backend.run()
    log('exiting')
    os._exit(0)


if __name__ == '__main__':
    main()
