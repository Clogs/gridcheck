# Gridcheck client agent. Runs inside the EVE client (Python 2.7); bootstrap.py
# fetches it from the bridge (bridge/client.js) once the login completes.
#
# The bridge sends each command as an OnGridcheckClient notification carrying
# {"id", "op", "args"}. Each runs on its own tasklet and answers with
# gridcheckClient.Reply(token, {"id", "ok", "value" | "error"}). A command that
# loops without yielding stalls the client, as any client code would.
#
# Client names used here, checked against decompiled build 3396210:
#   logmodule._LogException      every LogException, unhandled tasklet errors included
#   eveprefs.boot.build          the client's build number
#   michelle.GetBallpark()       ballpark: ego, currentTime, GetBallsAndItems(), GetBall()
#   uicore.desktop, uicore.registry.GetWindows()
#   ui nodes: name, display, state, children, GetAbsolute(), IsEnabled(), text, caption
import collections
import json
import os
import time
import traceback

import blue
import uthread

try:
    import __builtin__ as builtins
except ImportError:
    import builtins

VERSION = 2
REPR_LIMIT = 20000
TEXT_LIMIT = 300
# JavaScript numbers hold integers exactly up to 2^53 - 1; larger ones go as strings.
MAX_SAFE_INT = 2 ** 53 - 1
EVENT_RING = 500
EVENT_BATCH = 100
EVENT_PENDING_MAX = 1000
FLUSH_MS = 500
MAX_SEND_FAILURES = 5
UI_MAX_VISITED = 50000
SESSION_KEYS = ('userid', 'charid', 'corpid', 'allianceid', 'solarsystemid2', 'solarsystemid',
                'stationid', 'structureid', 'shipid', 'locationid', 'role')
# destiny's ball modes, as bridge/destiny.js names them.
MODE_NAMES = ('GOTO', 'FOLLOW', 'STOP', 'WARP', 'ORBIT', 'MISSILE', 'MUSHROOM', 'BOID', 'TROLL',
              'MINIBALL', 'FIELD', 'RIGID', 'FORMATION')
DEFAULT_NOTIFY = ('OnSessionChanged',)
# carbonui.uiconst UI_NORMAL, UI_DISABLED, UI_HIDDEN, UI_PICKCHILDREN.
STATE_NAMES = {0: 'normal', 1: 'disabled', 2: 'hidden', 3: 'pickChildren'}

try:
    TEXT = basestring
    UNICODE = unicode
    INTS = (int, long)
except NameError:
    TEXT = str
    UNICODE = str
    INTS = (int,)
SCALARS = INTS + (float, TEXT, bool)


def attempt(read, default=None):
    try:
        return read()
    except Exception:
        return default


def as_text(value):
    if isinstance(value, UNICODE):
        return value
    if isinstance(value, bytes):
        try:
            return value.decode('utf-8')
        except UnicodeDecodeError:
            return value.decode('latin-1')
    return value


def clip(value, limit=TEXT_LIMIT):
    if value is None:
        return None
    text = as_text(value) if isinstance(value, (bytes, UNICODE)) else repr(value)
    return text if len(text) <= limit else text[:limit] + '...'


def scalar(value):
    if value is None or isinstance(value, SCALARS):
        return value
    return repr(value)


# What json.dumps can send and JavaScript reads back unchanged: big integers
# become strings, NaN and infinities their repr, bytes text.
def json_safe(value, depth=0):
    if value is None or isinstance(value, bool):
        return value
    if isinstance(value, INTS):
        return str(value) if abs(value) > MAX_SAFE_INT else value
    if isinstance(value, float):
        return value if value == value and value not in (float('inf'), float('-inf')) else repr(value)
    if isinstance(value, (bytes, UNICODE)):
        return as_text(value)
    if depth > 40:
        return repr(value)
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            key = as_text(key) if isinstance(key, (bytes, UNICODE)) else str(key) if isinstance(key, INTS + (float,)) else repr(key)
            out[key] = json_safe(item, depth + 1)
        return out
    if isinstance(value, (list, tuple, set, frozenset)):
        return [json_safe(item, depth + 1) for item in value]
    return value


def jsonable(value):
    try:
        json.dumps(value)
        return True
    except Exception:
        return False


def dumps(value):
    return json.dumps(json_safe(value), default=repr)


def session_snapshot(session):
    return dict((key, scalar(getattr(session, key, None))) for key in SESSION_KEYS)


def client_build():
    try:
        from eveprefs import boot
        return scalar(getattr(boot, 'build', None))
    except Exception:
        return None


def whole(value):
    try:
        return int(round(value))
    except Exception:
        return None


class Listener(object):
    """Records one notify event; the service manager calls it by the event's name."""

    def __init__(self, events, name):
        self.events = events
        self.name = name
        setattr(self, name, self.handle)

    def handle(self, *args, **kwargs):
        self.events.record('notify', {'event': self.name, 'args': clip(args + ((kwargs,) if kwargs else ()))})


class EventLog(object):
    """A ring of client exceptions, selected notify events and agent errors,
    pushed to the bridge in batches through gridcheckClient.Events."""

    def __init__(self, agent):
        self.agent = agent
        self.ring = collections.deque(maxlen=EVENT_RING)
        self.pending = []
        self.dropped = 0
        self.seq = 0
        self.flushing = False
        self.failures = 0
        self.listeners = {}
        self.logmodule = None
        self.original = None

    def start(self, notify):
        self.hook_exceptions()
        self.select(notify)

    def stop(self):
        if self.logmodule is not None and getattr(self.logmodule._LogException, 'gridcheck_original', None) is self.original:
            self.logmodule._LogException = self.original
        self.logmodule = None
        self.select(())

    # LogException hands every exception to the module-level _LogException, so
    # one wrap there sees unhandled tasklet errors too ("EXCEPTION #51").
    def hook_exceptions(self):
        try:
            import logmodule
            original = logmodule._LogException
        except Exception as error:
            self.record('agent-error', {'error': 'exceptions not recorded: %r' % (error,)})
            return
        original = getattr(original, 'gridcheck_original', original)
        events = self

        def _LogException(exc_info, *args, **kwargs):
            try:
                events.exception(exc_info, args[0] if args else '', args[1] if len(args) > 1 else '')
            except Exception:
                pass
            return original(exc_info, *args, **kwargs)

        _LogException.gridcheck_original = original
        logmodule._LogException = _LogException
        self.logmodule = logmodule
        self.original = original

    def exception(self, exc_info, extra, channel):
        exctype, exc, tb = exc_info
        frames = traceback.extract_tb(tb)[-12:] if tb is not None else []
        lines = ['%s(%s) %s' % (frame[0], frame[1], frame[2]) for frame in frames]
        name = getattr(exctype, '__name__', None) or repr(exctype)
        message = attempt(lambda: traceback.format_exception_only(exctype, exc)[-1].strip(), repr(exc))
        if message.startswith(name + ': '):
            message = message[len(name) + 2:]
        self.record('exception', {
            'type': name,
            'message': clip(message),
            'extra': clip(extra) or None,
            'channel': clip(channel) or None,
            'where': lines[-1] if lines else None,
            'traceback': lines,
        })

    def select(self, names):
        wanted = set()
        for name in names or ():
            name = str(name)
            if not name.startswith('On') or not name.replace('_', '').isalnum() or name == 'OnGridcheckClient':
                raise ValueError('a notify event is a name starting On, such as OnSessionChanged; got %r' % (name,))
            wanted.add(name)
        for name in list(self.listeners):
            if name not in wanted:
                attempt(lambda: self.agent.sm.UnregisterForNotifyEvent(self.listeners[name], name))
                del self.listeners[name]
        for name in wanted:
            if name not in self.listeners:
                listener = Listener(self, name)
                self.agent.sm.RegisterForNotifyEvent(listener, name)
                self.listeners[name] = listener

    def record(self, kind, fields):
        self.seq += 1
        event = dict(fields)
        event.update({'seq': self.seq, 'kind': kind, 'atMs': int(time.time() * 1000)})
        self.ring.append(event)
        self.pending.append(event)
        if len(self.pending) > EVENT_PENDING_MAX:
            excess = len(self.pending) - EVENT_PENDING_MAX
            del self.pending[:excess]
            self.dropped += excess
        if not self.flushing and self.failures < MAX_SEND_FAILURES and self.agent.active:
            self.flushing = True
            uthread.new(self.flush)

    def flush(self):
        try:
            blue.pyos.synchro.SleepWallclock(FLUSH_MS)
            while self.pending and self.agent.active:
                batch = self.pending[:EVENT_BATCH]
                payload = dumps({'events': batch, 'dropped': self.dropped})
                self.agent.remote().Events(self.agent.token, payload)
                del self.pending[:len(batch)]
                self.dropped = 0
                self.failures = 0
        except Exception as error:
            self.failures += 1
            print('GRIDCHECK_CLIENT:EVENTS_FAILED %r' % (error,))
        finally:
            self.flushing = False

    def since(self, seq, limit):
        rows = [event for event in self.ring if event['seq'] > seq]
        return rows[-limit:] if limit else rows


def node_text(node):
    for attr in ('text', 'caption'):
        value = attempt(lambda: getattr(node, attr, None))
        if isinstance(value, TEXT) and value:
            return clip(value)
    return None


def node_children(node):
    children = attempt(lambda: getattr(node, 'children', None))
    if children is None:
        return []
    return attempt(lambda: list(children), [])


def node_info(node):
    rect = attempt(node.GetAbsolute)
    enabled = attempt(node.IsEnabled)
    state = attempt(lambda: node.state)
    return {
        'cls': type(node).__name__,
        'name': clip(attempt(lambda: node.name)),
        'text': node_text(node),
        'rect': [whole(value) for value in rect] if rect else None,
        'display': bool(attempt(lambda: node.display, False)),
        'state': STATE_NAMES.get(state, scalar(state)),
        'enabled': None if enabled is None else bool(enabled),
    }


def window_info(window):
    info = node_info(window)
    info['windowID'] = scalar(attempt(lambda: getattr(window, 'windowID', None)))
    info['minimized'] = attempt(lambda: bool(window.IsMinimized()))
    return info


def lower(value):
    return as_text(value).lower() if isinstance(value, (bytes, UNICODE)) and value else None


def bounded(value, default, low, high):
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def mode_name(mode):
    try:
        return MODE_NAMES[int(mode)]
    except (TypeError, ValueError, IndexError):
        return None if mode is None else 'UNKNOWN_%s' % (mode,)


def ball_row(ball, slim, ego):
    position = [attempt(lambda: float(getattr(ball, axis))) for axis in ('x', 'y', 'z')]
    row = {
        'itemID': attempt(lambda: ball.id),
        'typeID': attempt(lambda: slim.typeID),
        'groupID': attempt(lambda: slim.groupID),
        'categoryID': attempt(lambda: slim.categoryID),
        'ownerID': attempt(lambda: slim.ownerID),
        'name': clip(attempt(lambda: getattr(slim, 'name', None))),
        'position': position,
        'velocity': [attempt(lambda: float(getattr(ball, axis))) for axis in ('vx', 'vy', 'vz')],
        'mode': mode_name(attempt(lambda: ball.mode)),
        'radius': attempt(lambda: float(ball.radius)),
        'followID': attempt(lambda: ball.followId) or None,
        'followRange': attempt(lambda: float(ball.followRange)),
        'isFree': attempt(lambda: bool(ball.isFree)),
    }
    if ego is not None and None not in position:
        row['distanceMeters'] = round(sum((a - b) ** 2 for a, b in zip(position, ego)) ** 0.5, 1)
    return row


class Agent(object):
    __notifyevents__ = ['OnGridcheckClient']

    def __init__(self, sm, token):
        self.sm = sm
        self.token = token
        self.active = True
        self.namespace = {'__builtins__': builtins, '__name__': 'gridcheck_eval'}
        self.events = EventLog(self)

    def start(self):
        self.sm.RegisterForNotifyEvent(self, 'OnGridcheckClient')
        self.events.start(DEFAULT_NOTIFY)
        uthread.new(self.hello)
        return self

    def dispose(self):
        self.active = False
        attempt(self.events.stop)
        try:
            self.sm.UnregisterForNotifyEvent(self, 'OnGridcheckClient')
        except Exception:
            pass

    def remote(self):
        return self.sm.RemoteSvc('gridcheckClient')

    def identity(self):
        return {'agent': VERSION, 'build': client_build(), 'pid': os.getpid()}

    def hello(self):
        try:
            self.remote().Hello(self.token, dumps(self.identity()))
        except Exception as error:
            print('GRIDCHECK_CLIENT:HELLO_FAILED %r' % (error,))

    def OnGridcheckClient(self, payload=None, *args):
        if self.active:
            uthread.new(self.run, payload)

    def run(self, payload):
        command_id = None
        op = None
        try:
            command = json.loads(payload)
            command_id = command.get('id')
            op = command.get('op')
            handler = getattr(self, 'op_' + str(op), None)
            if handler is None:
                raise ValueError('unknown op: %s' % op)
            reply = {'ok': True, 'value': handler(command.get('args') or {})}
        except Exception:
            error = traceback.format_exc()
            reply = {'ok': False, 'error': error}
            attempt(lambda: self.events.record('agent-error', {'op': clip(op), 'error': clip(error.strip().splitlines()[-1])}))
        reply['id'] = command_id
        try:
            self.remote().Reply(self.token, dumps(reply))
        except Exception as error:
            print('GRIDCHECK_CLIENT:REPLY_FAILED %r' % (error,))

    def current_uicore(self):
        found = getattr(builtins, 'uicore', None)
        if found is not None:
            return found
        try:
            from carbonui.uicore import uicore
            return uicore
        except Exception:
            return None

    def op_ping(self, args):
        value = self.identity()
        value.update({
            'wallclock': scalar(blue.os.GetWallclockTime()),
            'session': session_snapshot(getattr(builtins, 'session', None)),
            'events': {'seq': self.events.seq, 'notify': sorted(self.events.listeners),
                       'exceptions': self.events.logmodule is not None},
        })
        return value

    # args: {"code": "..."}. An expression answers its value; statements answer
    # whatever they leave in `result`. Names persist between calls; sm, session,
    # uicore and agent are always current.
    def op_eval(self, args):
        code = str(args.get('code') or '')
        namespace = self.namespace
        namespace['sm'] = self.sm
        namespace['session'] = getattr(builtins, 'session', None)
        namespace['uicore'] = self.current_uicore()
        namespace['agent'] = self
        try:
            compiled = compile(code, '<gridcheck-eval>', 'eval')
        except SyntaxError:
            compiled = None
        if compiled is not None:
            value = eval(compiled, namespace)
        else:
            namespace.pop('result', None)
            eval(compile(code, '<gridcheck-eval>', 'exec'), namespace)
            value = namespace.get('result')
        text = repr(value)
        safe = json_safe(value)
        return {
            'repr': text[:REPR_LIMIT],
            'truncated': len(text) > REPR_LIMIT,
            'json': safe if jsonable(safe) else None,
        }

    # args: {"depth", "cls", "name", "text", "hidden", "limit"}. Without a filter,
    # the tree from uicore.desktop to depth (default 3). With one, every node at
    # any depth whose class, name or text contains it (case-insensitive), each
    # with its path. Hidden subtrees are skipped unless hidden is true.
    def op_ui(self, args):
        uicore = self.current_uicore()
        desktop = getattr(uicore, 'desktop', None)
        if desktop is None:
            raise ValueError('uicore.desktop is not ready')
        filters = dict((key, lower(args.get(key))) for key in ('cls', 'name', 'text'))
        finding = any(filters.values())
        depth = bounded(args.get('depth'), 40 if finding else 3, 0, 60)
        limit = bounded(args.get('limit'), 200 if finding else 2000, 1, 20000)
        hidden = bool(args.get('hidden'))
        counts = {'visited': 0, 'listed': 0, 'truncated': False}
        matches = []

        def matched(info):
            for key, attr in (('cls', 'cls'), ('name', 'name'), ('text', 'text')):
                wanted = filters[key]
                if wanted and wanted not in (lower(info.get(attr)) or ''):
                    return False
            return True

        def walk(node, level, path):
            counts['visited'] += 1
            info = node_info(node)
            kids = node_children(node)
            info['children'] = len(kids)
            here = '%s/%s' % (path, info['name'] or info['cls'])
            if finding and matched(info):
                info['path'] = here
                matches.append(info)
                if len(matches) >= limit:
                    counts['truncated'] = True
            elif not finding:
                counts['listed'] += 1
            if level >= depth or counts['truncated']:
                return info
            shown = []
            for kid in kids:
                if counts['truncated'] or counts['visited'] >= UI_MAX_VISITED:
                    counts['truncated'] = True
                    break
                if not hidden and not attempt(lambda: kid.display, False):
                    continue
                if not finding and counts['listed'] >= limit:
                    counts['truncated'] = True
                    break
                child = walk(kid, level + 1, here)
                if not finding:
                    shown.append(child)
            if not finding:
                info['kids'] = shown
            return info

        tree = walk(desktop, 0, '')
        registry = getattr(uicore, 'registry', None)
        windows = attempt(registry.GetWindows, []) if registry is not None else []
        value = {
            'windows': [window_info(window) for window in windows or []],
            'visited': counts['visited'],
            'truncated': counts['truncated'],
        }
        if finding:
            value['matches'] = matches
        else:
            value['tree'] = tree
        return value

    # args: {"range": meters from the ego ball, "limit"}. What michelle's
    # ballpark holds: every ball with a slim item, nearest first.
    def op_ballpark(self, args):
        session = getattr(builtins, 'session', None)
        park = self.sm.GetService('michelle').GetBallpark()
        value = {
            'inSpace': park is not None,
            'solarSystemID': scalar(getattr(session, 'solarsystemid2', None)),
            'shipID': scalar(getattr(session, 'shipid', None)),
            'balls': [],
        }
        if park is None:
            return value
        ego_ball = attempt(lambda: park.GetBall(park.ego))
        ego = [attempt(lambda: float(getattr(ego_ball, axis))) for axis in ('x', 'y', 'z')] if ego_ball is not None else None
        if ego is not None and None in ego:
            ego = None
        within = args.get('range')
        within = float(within) if isinstance(within, (int, float)) and within > 0 else None
        limit = bounded(args.get('limit'), 2000, 1, 20000)
        rows = []
        for ball, slim in park.GetBallsAndItems():
            row = ball_row(ball, slim, ego)
            if within is not None and row.get('distanceMeters') is not None and row['distanceMeters'] > within:
                continue
            rows.append(row)
        rows.sort(key=lambda row: (row.get('distanceMeters') is None, row.get('distanceMeters'), row['itemID']))
        value.update({
            'egoID': attempt(lambda: park.ego),
            'currentTime': attempt(lambda: park.currentTime),
            'ballCount': attempt(lambda: len(park.balls)),
            'count': len(rows),
            'truncated': len(rows) > limit,
            'balls': rows[:limit],
        })
        return value

    # args: {"since": seq, "limit", "notify": [names]}. The agent's own ring;
    # notify replaces which notify events it records.
    def op_events(self, args):
        if 'notify' in args:
            names = args.get('notify') or []
            self.events.select(names if isinstance(names, list) else [names])
        since = bounded(args.get('since'), 0, 0, 2 ** 62)
        limit = bounded(args.get('limit'), 100, 0, EVENT_RING)
        return {
            'seq': self.events.seq,
            'notify': sorted(self.events.listeners),
            'exceptions': self.events.logmodule is not None,
            'events': self.events.since(since, limit),
        }


def install(sm, token):
    return Agent(sm, token).start()
