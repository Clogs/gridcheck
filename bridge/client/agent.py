# Gridcheck client agent. Runs inside the EVE client (Python 2.7); bootstrap.py
# fetches it from the bridge (bridge/client.js) once the login completes.
#
# The bridge sends each command as an OnGridcheckClient notification carrying
# {"id", "op", "args"}. Each runs on its own tasklet and answers with
# gridcheckClient.Reply(token, {"id", "ok", "value" | "error"}). A command that
# loops without yielding stalls the client, as any client code would.
#
# Every client name used here, with the module that defines it in build 3396210
# (CHECKED_BUILD), from the whole client decompiled by tools/ClientCodeGrabber.
# Keep that tree outside the repo; check a name there before adding it.
#   blue.pyos.synchro.SleepWallclock, blue.os.GetWallclockTime, blue.os.GetSimTime  native (blue)
#   session.mutating, session.nextSessionChange (blue sim time; a change before it is refused)
#                                        carbon/common/script/sys/sessions.py PerformSessionChange
#   uthread.new                          uthread
#   logmodule._LogException(exc_info, extraText, channel, ...)
#                                        logmodule/__init__.py; LogException calls it by its global
#   eveprefs.boot.build                  eveprefs/__init__.py (boot set at startup)
#   evetypes.GetName(typeID)             evetypes/__init__.py
#   sm.GetService, RemoteSvc, RegisterForNotifyEvent, UnregisterForNotifyEvent
#                                        carbon/common/script/sys/serviceManager.py
#   michelle.GetBallpark()               eve/client/script/remote/michelle.py
#   ballpark (Park, on destiny.Ballpark): ego, currentTime, balls, GetBall(id), GetBallsAndItems()
#                                        eve/client/script/remote/michelle.py; currentTime, balls native
#   ball x y z vx vy vz mode radius followId followRange isFree, id
#                                        native destiny.Ball, read the same way in parklife/spaceMgr.py
#   slim item typeID groupID categoryID ownerID name   michelle.py's slim items
#   uicore: desktop, uilib, registry, cmd, layer   carbonui/uicore.py (carbonui.uicore.uicore)
#   uicore.registry GetWindows(), GetModalWindow(), GetFocus(), SetFocus(item)
#                                        carbonui/services/registry.py
#   nodes: name, display, state, children, text, caption, GetAbsolute(), IsEnabled(),
#          HasEventHandler(name), OnClick, OnDblClick     carbonui/primitives/base.py
#   Button.press() (checks enabled)      carbonui/control/button.py
#   window windowID, IsMinimized()       carbonui/control/window.py
#   edits SetValue(text), GetText()      carbonui/control/singlelineedits/baseSingleLineEdit.py, edit.py
#   uicore.uilib _OnChar(key, flags, isDead), _OnKeyDown(key, flags), _OnKeyUp(key, flags)
#                                        carbonui/uilib.py: where the window's key events land
#   uicore.cmd (EveCommandService): IsCommandEnabled(cm), ExecuteCommand(cm, *args), CmdStopShip
#                                        eve/client/script/ui/eveCommands.py
#   commandMap GetAllCommands(), GetCommandByName(name); a mapping's name, category,
#          GetDescription(), GetShortcutAsString()   carbonui/services/command.py
#   movementFunctions Approach(id), Orbit(id, followRange), KeepAtRange(id, followRange),
#          WarpToItem(id, warpRange=), DockOrJumpOrActivateGate(id)
#                                        eve/client/script/ui/services/menuSvcExtras/movementFunctions.py
#   undocking ExitDockableLocation()     eve/client/script/ui/shared/dockedUI/undockingSvc.py
#   menu Dock(itemID)                    eve/client/script/ui/services/menusvc.py
#   target TryLockTarget(id), UnlockTarget(id), GetTargets(), GetTargeting()
#                                        eve/client/script/parklife/targetMgr.py
#   uicore.layer.shipui isopen           carbonui/control/layer.py
#   shipui.slotsContainer                eve/client/script/ui/inflight/shipHud/shipUI.py
#   slotsContainer.modulesByID           eve/client/script/ui/inflight/shipHud/slotsContainer.py
#   ModuleButton moduleinfo, locationFlag, online, def_effect (isActive), ActivateModule(),
#          DeactivateModule(), ActivateEffect(effect, targetID=)
#                                        eve/client/script/ui/inflight/shipModuleButton/shipmodulebutton.py
#   gameui LogOffCharacter()             eve/client/script/parklife/gameui.py
#   CharacterSelection.ConfirmWithCharID(charID)
#                                        eve/client/script/ui/login/charSelection/characterSelection.py
#   trinity.device.GetRenderContext().GetDefaultBackBuffer() (width, height, format, isReadable, Resolve),
#          Tr2RenderTarget, Tr2HostBitmap (format, ChangeFormat, Save), PIXEL_FORMAT
#                                        native (trinity), as carbonui/services/command.py PrintScreen uses them
import ast
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

VERSION = 6
# The build the client names above were checked against. Ops that use them
# refuse on another build unless the command passes anyBuild; these don't.
CHECKED_BUILD = 3396210
BUILD_FREE_OPS = ('ping', 'eval', 'events')
REPR_LIMIT = 20000
# How long a drive op waits for what it started before answering; past it the
# action carries on (a dialog it opened may be waiting for an answer).
SETTLE_MS = 3000
# How long act waits by default for the action to be done (in space, docked,
# out of warp ...); wait overrides it, and wait 0 answers once it has started.
DONE_MS = {'warpTo': 120000, 'undock': 60000, 'dock': 60000, 'jump': 60000, 'logoff': 60000, 'select': 60000,
           'lock': 30000, 'deactivate': 60000}
QUICK_DONE_MS = 10000
DONE_POLL_MS = 200
# The client refuses these while its session-change timer runs ("You should be
# squeezed out in 5 seconds"); act waits it out first, as PerformSessionChange
# itself does when asked to wait.
SESSION_ACTIONS = ('undock', 'dock', 'jump')
SESSION_MARGIN_MS = 1000
# blue time counts 100 ns.
BLUE_PER_MS = 10000
WARP_MODE = 3
# A warp the server took has the ship aligning (GOTO) well before this.
WARP_START_MS = 5000
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
# Inventory flags of the fitting racks: LoSlot0 11, MedSlot0 19, HiSlot0 27, eight each.
RACKS = (('high', 27), ('med', 19), ('low', 11))
# Categories a ship docks at: Station, Structure.
DOCKABLE_CATEGORIES = (3, 65)
VK_RETURN, VK_BACK, VK_SPACE = 13, 8, 32

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
    rect = attempt(lambda: node.GetAbsolute())
    enabled = attempt(lambda: node.IsEnabled())
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


def node_label(node):
    return clip(attempt(lambda: node.name)) or type(node).__name__


def walk_nodes(root, hidden):
    """Every node under root, depth first, as (node, path, ancestors); the paths
    are the ones op ui prints. Hidden subtrees are skipped unless hidden."""
    stack = [(root, '/' + node_label(root), ())]
    visited = 0
    while stack and visited < UI_MAX_VISITED:
        node, here, chain = stack.pop()
        visited += 1
        yield node, here, chain
        kids = node_children(node)
        for kid in reversed(kids):
            if hidden or attempt(lambda: kid.display, False):
                stack.append((kid, '%s/%s' % (here, node_label(kid)), chain + (node,)))


def has_handler(node, name):
    found = attempt(lambda: node.HasEventHandler(name))
    if found is None:
        found = callable(getattr(node, name, None))
    return bool(found)


def clickable(node, here, chain, name):
    """The node, or its nearest ancestor, that handles name, with its path."""
    parts = here.split('/')
    for depth, candidate in enumerate(reversed(chain + (node,))):
        if has_handler(candidate, name):
            return candidate, '/'.join(parts[:len(parts) - depth])
    return None, None


def call_handler(node, name, *args):
    handler = getattr(node, name)
    if isinstance(handler, tuple):
        return handler[0](*(tuple(handler[1:]) + args))
    return handler(*args)


def slot_name(flag):
    for rack, first in RACKS:
        if first <= flag < first + 8:
            return '%s%d' % (rack, flag - first + 1)
    return None


def slot_flag(name):
    text = str(name or '').lower()
    for rack, first in RACKS:
        if text.startswith(rack) and text[len(rack):].isdigit():
            index = int(text[len(rack):])
            if 1 <= index <= 8:
                return first + index - 1
    return None


# The character Windows sends with a key press, for keys that have one.
def char_for(vk):
    if vk in (VK_RETURN, VK_BACK, VK_SPACE) or 0x30 <= vk <= 0x39:
        return vk
    if 0x41 <= vk <= 0x5A:
        return vk + 32
    return None


def type_name(typeID):
    try:
        import evetypes
        return clip(evetypes.GetName(typeID))
    except Exception:
        return None


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
        return {'agent': VERSION, 'build': client_build(), 'checkedBuild': CHECKED_BUILD, 'pid': os.getpid()}

    def check_build(self, op, args):
        if op in BUILD_FREE_OPS or args.get('anyBuild'):
            return
        build = client_build()
        if str(build) != str(CHECKED_BUILD):
            raise ValueError('%s uses client code checked against build %s; this client is build %s. ping and eval still '
                             'work; anyBuild (--any-build) runs it anyway' % (op, CHECKED_BUILD, build or 'unknown'))

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
            args = command.get('args') or {}
            self.check_build(op, args)
            reply = {'ok': True, 'value': handler(args)}
        except Exception:
            error = traceback.format_exc()
            reply = {'ok': False, 'error': error}
            # An eval's own mistakes are its caller's alone; a poll loop of them would bury the timeline.
            if op != 'eval':
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
            'where': attempt(self.where),
            'events': {'seq': self.events.seq, 'notify': sorted(self.events.listeners),
                       'exceptions': self.events.logmodule is not None},
        })
        return value

    # args: {"code": "..."}. An expression answers its value; statements that
    # end in an expression answer that, as a REPL does; other statements answer
    # whatever they leave in `result`. Names persist between calls; sm, session,
    # uicore, agent, blue and uthread are always current.
    def op_eval(self, args):
        code = str(args.get('code') or '')
        namespace = self.namespace
        namespace['sm'] = self.sm
        namespace['session'] = getattr(builtins, 'session', None)
        namespace['uicore'] = self.current_uicore()
        namespace['agent'] = self
        namespace['blue'] = blue
        namespace['uthread'] = uthread
        try:
            compiled = compile(code, '<gridcheck-eval>', 'eval')
        except SyntaxError:
            compiled = None
        if compiled is not None:
            value = eval(compiled, namespace)
        else:
            namespace.pop('result', None)
            tree = ast.parse(code, '<gridcheck-eval>', 'exec')
            last = tree.body[-1] if tree.body and isinstance(tree.body[-1], ast.Expr) else None
            if last is not None:
                tree.body = tree.body[:-1]
            eval(compile(tree, '<gridcheck-eval>', 'exec'), namespace)
            if last is not None:
                value = eval(compile(ast.fix_missing_locations(ast.Expression(last.value)), '<gridcheck-eval>', 'eval'), namespace)
            else:
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

    # args: {"path": an absolute .png path}. The back buffer as the client last
    # drew it, saved as the client's own PrintScreen saves it. The client keeps
    # drawing while its window is covered or minimized, so this works then too.
    def op_screenshot(self, args):
        target = as_text(args.get('path') or '')
        if not os.path.isabs(target) or not target.lower().endswith('.png'):
            raise ValueError('path: an absolute path ending .png')
        import trinity
        started = time.time()
        back = trinity.device.GetRenderContext().GetDefaultBackBuffer()
        if back.isReadable:
            bitmap = trinity.Tr2HostBitmap(back)
        else:
            readable = trinity.Tr2RenderTarget(back.width, back.height, 1, back.format)
            back.Resolve(readable)
            bitmap = trinity.Tr2HostBitmap(readable)
        # PrintScreen drops the alpha channel too.
        if bitmap.format == trinity.PIXEL_FORMAT.B8G8R8A8_UNORM:
            bitmap.ChangeFormat(trinity.PIXEL_FORMAT.B8G8R8X8_UNORM)
        if not bitmap.Save(target):
            raise RuntimeError('the client could not save %s' % target)
        return {'file': target, 'width': back.width, 'height': back.height, 'ms': int((time.time() - started) * 1000)}

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

    # ---- driving the client ----

    # Runs start() on its own tasklet and waits up to args.wait ms (default
    # SETTLE_MS) for it. What it started may open a dialog and wait for an
    # answer; then finished is false and modal names the dialog.
    def settle(self, start, args, what, limit=None, record=True):
        box = {}

        def work():
            try:
                box['value'] = start()
            except Exception:
                box['error'] = traceback.format_exc()
            box['done'] = True

        uthread.new(work)
        if limit is None:
            limit = bounded(args.get('wait'), SETTLE_MS, 0, 60000)
        waited = 0
        while not box.get('done') and waited < limit:
            blue.pyos.synchro.SleepWallclock(50)
            waited += 50
        failed = box.get('error', '').strip().splitlines()[-1:]
        outcome = failed[0] if failed else 'finished' if box.get('done') else 'still running after %d ms' % waited
        if record or failed:
            self.events.record('action', {'op': clip(what, 120), 'args': clip(outcome)})
        if 'error' in box:
            raise RuntimeError('%s failed in the client: %s\n%s' % (what, outcome, box['error']))
        value = box.get('value')
        safe = json_safe(value)
        uicore = self.current_uicore()
        modal = attempt(lambda: uicore.registry.GetModalWindow())
        return {
            'finished': bool(box.get('done')),
            'result': safe if jsonable(safe) else clip(value),
            'modal': window_info(modal) if modal is not None else None,
        }

    def desktop(self):
        uicore = self.current_uicore()
        desktop = getattr(uicore, 'desktop', None)
        if desktop is None:
            raise ValueError('uicore.desktop is not ready')
        return uicore, desktop

    # The one displayed node args name: path (exact, as ui prints it), or cls,
    # name and text (contains, case-insensitive), with index to pick among several.
    def locate(self, args):
        uicore, desktop = self.desktop()
        path = args.get('path')
        filters = dict((key, lower(args.get(key))) for key in ('cls', 'name', 'text'))
        if not path and not any(filters.values()):
            raise ValueError('name the node: path (from ui), or cls, name or text')
        found = []
        for node, here, chain in walk_nodes(desktop, bool(args.get('hidden'))):
            if path:
                if here != path:
                    continue
            else:
                info = {'cls': type(node).__name__, 'name': attempt(lambda: node.name), 'text': node_text(node)}
                if any(wanted and wanted not in (lower(info[key]) or '') for key, wanted in filters.items()):
                    continue
            found.append((node, here, chain))
        # A button and its own label both match its text; the outermost stands for both.
        matched = set(id(node) for node, _here, _chain in found)
        found = [row for row in found if not any(id(above) in matched for above in row[2])]
        index = args.get('index')
        if index is not None:
            index = bounded(index, -1, 0, 100000)
            if not 0 <= index < len(found):
                raise ValueError('index %s, but %d node(s) match' % (args.get('index'), len(found)))
            return found[index]
        if len(found) == 1:
            return found[0]
        if not found:
            raise ValueError('no displayed node matches %s; ui --hidden also lists hidden ones' % (
                json.dumps(dict((k, v) for k, v in dict(filters, path=path).items() if v)),))
        listed = '\n'.join('  [%d] %s' % (n, here) for n, (_node, here, _chain) in enumerate(found[:12]))
        raise ValueError('%d nodes match; pass index or path:\n%s%s' % (len(found), listed, '\n  ...' if len(found) > 12 else ''))

    def described(self, node, here):
        info = node_info(node)
        info['path'] = here
        return info

    # The node, and the nearest node from it up that takes a click.
    def op_find(self, args):
        node, here, chain = self.locate(args)
        clicked, clicked_path = clickable(node, here, chain, 'OnClick')
        return {'node': self.described(node, here),
                'target': self.described(clicked, clicked_path) if clicked is not None else None}

    # args: the node (as locate), double. Calls the click handler of the node or
    # its nearest ancestor that has one: Button.press() for a button, which
    # checks it is enabled, else OnClick (OnDblClick with double).
    def op_click(self, args):
        node, here, chain = self.locate(args)
        handler = 'OnDblClick' if args.get('double') else 'OnClick'
        target, target_path = clickable(node, here, chain, handler)
        if target is None:
            raise ValueError('neither %s nor a node above it has %s' % (here, handler))
        if attempt(lambda: target.IsEnabled()) is False or getattr(target, 'enabled', True) is False:
            raise ValueError('%s is disabled' % target_path)
        press = getattr(target, 'press', None)
        if handler == 'OnClick' and callable(press):
            value = self.settle(press, args, 'click %s' % target_path)
        else:
            value = self.settle(lambda: call_handler(target, handler), args, 'click %s' % target_path)
        value['clicked'] = self.described(target, target_path)
        return value

    # The node into names (as locate), focused first; else the focused one.
    def focused(self, into):
        uicore = self.current_uicore()
        registry = getattr(uicore, 'registry', None)
        if into:
            node, _here, _chain = self.locate(into)
            registry.SetFocus(node)
        focus = attempt(lambda: registry.GetFocus()) if registry is not None else None
        if focus is None:
            raise ValueError('nothing has focus (the client drops its focus while its window is in the background): '
                             'name the edit')
        return uicore, focus

    def focus_state(self, focus):
        info = node_info(focus)
        info['value'] = clip(attempt(lambda: focus.GetText()))
        return info

    # args: text, set, enter, into (the edit, as locate; else the focused one).
    # Each character goes to uicore.uilib._OnChar as the window's would; set
    # calls the edit's SetValue.
    def op_type(self, args):
        text = args.get('text')
        text = as_text(text) if isinstance(text, (bytes, UNICODE)) else ''
        into = args.get('into')
        uicore, focus = self.focused(into if isinstance(into, dict) else None)
        if args.get('set'):
            if not callable(getattr(focus, 'SetValue', None)):
                raise ValueError('the focused %s has no SetValue; type without set' % type(focus).__name__)
            focus.SetValue(text)
        else:
            for char in text:
                uicore.uilib._OnChar(ord(char), 0, False)
        if args.get('enter'):
            self.press(uicore, VK_RETURN)
        return {'focus': self.focus_state(focus), 'typed': len(text)}

    def press(self, uicore, vk):
        uicore.uilib._OnKeyDown(vk, 0)
        char = char_for(vk)
        if char is not None:
            uicore.uilib._OnChar(char, 0, False)
        uicore.uilib._OnKeyUp(vk, 0)

    # args: vk (a virtual-key code), into (as op type; else the focused node,
    # if any). A key down, its character, a key up, as the window hands them
    # over; the client's key bindings see it too. Ctrl, shift and alt can't be
    # held: the client reads them from the real keyboard.
    def op_key(self, args):
        vk = bounded(args.get('vk'), 0, 0, 255)
        if not vk:
            raise ValueError('vk: a virtual-key code')
        into = args.get('into')
        if isinstance(into, dict) and into:
            uicore, focus = self.focused(into)
        else:
            uicore = self.current_uicore()
            focus = attempt(lambda: uicore.registry.GetFocus())
        self.press(uicore, vk)
        return {'vk': vk, 'focus': self.focus_state(focus) if focus is not None else None}

    # args: name, args, list, filter, limit. Without a name (or with list), the
    # commands uicore.cmd knows. With one, runs it as a key binding would,
    # through ExecuteCommand and its enabled and blocked checks; a public
    # uicore.cmd method that isn't a bound command is called as it is.
    def op_cmd(self, args):
        uicore = self.current_uicore()
        handler = getattr(uicore, 'cmd', None)
        if handler is None:
            raise ValueError('uicore.cmd is not set yet: the client sets it at startup')
        name = str(args.get('name') or '')
        commands = attempt(lambda: list(handler.commandMap.GetAllCommands()), [])
        if not name or args.get('list'):
            wanted = lower(args.get('filter') or name)
            rows = []
            for mapping in commands:
                row = {
                    'name': attempt(lambda: str(mapping.name)),
                    'label': clip(attempt(lambda: mapping.GetDescription())),
                    'shortcut': clip(attempt(lambda: mapping.GetShortcutAsString())) or None,
                    'category': scalar(getattr(mapping, 'category', None)),
                    'enabled': attempt(lambda: bool(handler.IsCommandEnabled(mapping))),
                }
                if wanted and wanted not in (lower(row['name']) or '') and wanted not in (lower(row['label']) or ''):
                    continue
                rows.append(row)
            rows.sort(key=lambda row: row['name'] or '')
            limit = bounded(args.get('limit'), 500, 1, 5000)
            return {'count': len(rows), 'truncated': len(rows) > limit, 'commands': rows[:limit]}
        call_args = args.get('args') or []
        if not isinstance(call_args, list):
            call_args = [call_args]
        mapping = attempt(lambda: handler.commandMap.GetCommandByName(name))
        if mapping is not None:
            if not handler.IsCommandEnabled(mapping):
                raise ValueError('%s is disabled or blocked in the client right now' % name)
            value = self.settle(lambda: handler.ExecuteCommand(mapping, *call_args), args, 'cmd %s' % name)
        else:
            method = getattr(handler, name, None) if name[:1].isupper() else None
            if not callable(method):
                near = [str(m.name) for m in commands if lower(name) in (lower(attempt(lambda: m.name)) or '')][:12]
                raise ValueError('uicore.cmd has no command %s%s' % (name, '; did you mean ' + ', '.join(near) if near else
                                                                     '; cmd with no name lists them'))
            value = self.settle(lambda: method(*call_args), args, 'cmd %s' % name)
        value.update({'name': name, 'bound': mapping is not None})
        return value

    def park(self):
        return self.sm.GetService('michelle').GetBallpark()

    def module_buttons(self):
        uicore = self.current_uicore()
        shipui = attempt(lambda: uicore.layer.shipui)
        if shipui is None or not attempt(lambda: shipui.isopen):
            raise ValueError('the ship HUD is not open: modules are driven in space')
        return attempt(lambda: dict(shipui.slotsContainer.modulesByID), {})

    def module_row(self, button):
        info = attempt(lambda: button.moduleinfo)
        flag = attempt(lambda: int(button.locationFlag))
        effect = attempt(lambda: button.def_effect)
        typeID = attempt(lambda: info.typeID)
        return {
            'itemID': scalar(attempt(lambda: info.itemID)),
            'typeID': scalar(typeID),
            'name': type_name(typeID) if typeID else None,
            'slot': slot_name(flag) if flag is not None else None,
            'flag': flag,
            'online': attempt(lambda: bool(button.online)),
            'activatable': effect is not None,
            'active': attempt(lambda: bool(effect.isActive)) if effect is not None else False,
        }

    def module_button(self, args):
        buttons = self.module_buttons()
        wanted = args.get('module')
        flag = slot_flag(wanted)
        for button in buttons.values():
            if flag is not None and attempt(lambda: int(button.locationFlag)) == flag:
                return button
            if flag is None and str(attempt(lambda: button.moduleinfo.itemID)) == str(wanted):
                return button
        raise ValueError('no module %s on the HUD; act modules lists them (an itemID, or a slot such as high1)' % (wanted,))

    def nearest_dockable(self):
        park = self.park()
        if park is None:
            raise ValueError('not in space')
        ego = attempt(lambda: park.GetBall(park.ego))
        best = None
        for ball, slim in park.GetBallsAndItems():
            if attempt(lambda: slim.categoryID) not in DOCKABLE_CATEGORIES:
                continue
            gap = attempt(lambda: ((ball.x - ego.x) ** 2 + (ball.y - ego.y) ** 2 + (ball.z - ego.z) ** 2) ** 0.5)
            if gap is not None and (best is None or gap < best[0]):
                best = (gap, ball.id)
        if best is None:
            raise ValueError('no station or structure in the ballpark; pass target')
        return best[1]

    def character_selection(self):
        _uicore, desktop = self.desktop()
        for node, _here, _chain in walk_nodes(desktop, True):
            if type(node).__name__ == 'CharacterSelection':
                return node
        raise ValueError('the client is not at character selection')

    # Where the client is: docked or in space, the system, and its own ship's
    # ball; changeMs is how long until the client allows a session change.
    def where(self):
        session = getattr(builtins, 'session', None)
        park = attempt(self.park)
        ego = attempt(lambda: park.GetBall(park.ego)) if park is not None else None
        state = {
            'charID': scalar(getattr(session, 'charid', None)),
            'docked': scalar(getattr(session, 'stationid', None) or getattr(session, 'structureid', None)),
            'solarSystemID': scalar(getattr(session, 'solarsystemid2', None)),
            'inSpace': ego is not None and bool(getattr(session, 'solarsystemid', None)),
            'changeMs': self.session_wait_ms(),
        }
        # Docked, the ballpark left behind still holds the ship's last ball.
        if ego is not None and not state['docked']:
            speed = attempt(lambda: (ego.vx ** 2 + ego.vy ** 2 + ego.vz ** 2) ** 0.5)
            mode = mode_name(attempt(lambda: ego.mode))
            state['ego'] = {
                'itemID': attempt(lambda: park.ego),
                'mode': mode,
                'speed': round(speed, 1) if speed is not None else None,
                # followId keeps whatever it last held; it means something only while following.
                'followID': attempt(lambda: ego.followId) or None if mode in ('FOLLOW', 'ORBIT') else None,
            }
        return state

    # How long until the client allows a session change: mid-change, or before
    # session.nextSessionChange, it refuses one (PerformSessionChange).
    def session_wait_ms(self):
        session = getattr(builtins, 'session', None)
        if attempt(lambda: session.mutating):
            return DONE_POLL_MS
        allowed = attempt(lambda: session.nextSessionChange)
        now = attempt(lambda: blue.os.GetSimTime())
        if not isinstance(allowed, INTS) or not isinstance(now, INTS) or allowed <= now:
            return 0
        return int((allowed - now) // BLUE_PER_MS) + 1

    def hold_for_session(self, budget):
        held = 0
        while held < budget:
            left = self.session_wait_ms()
            if not left:
                break
            step = min(left + SESSION_MARGIN_MS, budget - held)
            blue.pyos.synchro.SleepWallclock(step)
            held += step
        return held

    # A check(elapsed ms) for when the action is done: True once it is, text
    # once it can't be (why), None while it may still be.
    def done_check(self, action, target, before, args):
        session = getattr(builtins, 'session', None)
        seen = {}

        def settled():
            return not attempt(lambda: session.mutating)

        def ego():
            return self.where().get('ego') or {}

        def follows(mode):
            return lambda _ms: True if ego().get('mode') == mode and str(ego().get('followID')) == str(target) else None

        def target_sets():
            service = self.sm.GetService('target')
            return (set(str(t) for t in attempt(lambda: service.GetTargets().keys(), [])),
                    set(str(t) for t in attempt(lambda: service.GetTargeting(), [])))

        if action == 'undock':
            return lambda _ms: True if self.where()['inSpace'] and settled() else None
        if action == 'dock':
            return lambda _ms: True if self.where()['docked'] and settled() else None
        if action == 'jump':
            def jumped(_ms):
                now = self.where()
                moved = now['solarSystemID'] != before['solarSystemID'] or now['docked'] != before['docked']
                return True if moved and (now['inSpace'] or now['docked']) and settled() else None
            return jumped
        if action == 'warpTo':
            def warped(ms):
                ship = ego()
                if ship.get('mode') == MODE_NAMES[WARP_MODE]:
                    seen['warp'] = True
                    return None
                if seen.get('warp'):
                    return True
                if ms >= WARP_START_MS and ship.get('mode') == 'STOP' and (ship.get('speed') or 0) < 1:
                    return 'the ship never entered warp'
                return None
            return warped
        if action in ('approach', 'keepAtRange'):
            return follows('FOLLOW')
        if action == 'orbit':
            return follows('ORBIT')
        if action == 'stop':
            return lambda _ms: True if ego().get('mode') == 'STOP' else None
        if action == 'lock':
            def locked(_ms):
                targets, locking = target_sets()
                if str(target) in targets:
                    return True
                return None if str(target) in locking else 'the client dropped the lock: the server refused it, or it was out of range'
            return locked
        if action == 'unlock':
            return lambda _ms: True if str(target) not in target_sets()[0] else None
        if action in ('activate', 'deactivate'):
            button = self.module_button(args)
            wanted = action == 'activate'
            return lambda _ms: True if attempt(lambda: bool(button.def_effect.isActive)) == wanted else None
        if action == 'logoff':
            return lambda _ms: True if attempt(self.character_selection) is not None else None
        if action == 'select':
            def entered(_ms):
                now = self.where()
                return True if str(now['charID']) == str(target) and (now['inSpace'] or now['docked']) and settled() else None
            return entered
        return None

    def wait_done(self, check, budget):
        started = time.time()
        waited = 0
        while True:
            outcome = attempt(lambda: check(waited))
            ms = int((time.time() - started) * 1000)
            if outcome is True:
                return {'reached': True, 'ms': ms}
            if isinstance(outcome, TEXT):
                return {'reached': False, 'ms': ms, 'why': outcome}
            if waited >= budget:
                return {'reached': False, 'ms': ms, 'why': 'not done after %d s' % (waited // 1000)}
            step = min(DONE_POLL_MS, budget - waited)
            blue.pyos.synchro.SleepWallclock(step)
            waited += step

    # args: action, target (itemID), range (m), module (itemID or slot), wait (ms).
    # A player's action through the client's own services, as CCP's code calls
    # them. Waits until it is done (DONE_MS, or wait) and answers where the
    # client is then and the events it logged meanwhile; wait 0 answers once it
    # has started. A dialog it opens is answered at once (modal).
    def op_act(self, args):
        action = str(args.get('action') or '')
        target = args.get('target')
        target = int(target) if isinstance(target, INTS) or (isinstance(target, TEXT) and target.isdigit()) else None
        span = args.get('range')
        span = float(span) if isinstance(span, (int, float)) and not isinstance(span, bool) and span >= 0 else None
        session = getattr(builtins, 'session', None)

        def need_target():
            if target is None:
                raise ValueError('%s needs target, an itemID (ballpark lists them)' % action)
            return target

        def moves():
            from eve.client.script.ui.services.menuSvcExtras import movementFunctions
            return movementFunctions

        if action == 'modules':
            rows = sorted((self.module_row(button) for button in self.module_buttons().values()),
                          key=lambda row: (row['flag'] is None, -(row['flag'] or 0)))
            targets = attempt(lambda: sorted(self.sm.GetService('target').GetTargets().keys()), [])
            return {'modules': rows, 'targets': [scalar(t) for t in targets]}
        if action == 'undock':
            if not (getattr(session, 'stationid', None) or getattr(session, 'structureid', None)):
                raise ValueError('not docked')
            start = lambda: self.sm.GetService('undocking').ExitDockableLocation()
        elif action == 'dock':
            docked = getattr(session, 'stationid', None) or getattr(session, 'structureid', None)
            if docked:
                raise ValueError('already docked at %s' % (docked,))
            dock_at = target if target is not None else self.nearest_dockable()
            start = lambda: self.sm.GetService('menu').Dock(dock_at)
            target = dock_at
        elif action == 'jump':
            need_target()
            start = lambda: moves().DockOrJumpOrActivateGate(target)
        elif action == 'warpTo':
            need_target()
            start = lambda: moves().WarpToItem(target, warpRange=span)
        elif action == 'approach':
            need_target()
            start = lambda: moves().Approach(target)
        elif action == 'orbit':
            need_target()
            start = lambda: moves().Orbit(target, 5000.0 if span is None else span)
        elif action == 'keepAtRange':
            need_target()
            start = lambda: moves().KeepAtRange(target, 10000.0 if span is None else span)
        elif action == 'stop':
            uicore = self.current_uicore()
            start = lambda: uicore.cmd.ExecuteCommand(uicore.cmd.commandMap.GetCommandByName('CmdStopShip'))
        elif action == 'lock':
            need_target()
            start = lambda: self.sm.GetService('target').TryLockTarget(target)
        elif action == 'unlock':
            need_target()
            start = lambda: self.sm.GetService('target').UnlockTarget(target)
        elif action in ('activate', 'deactivate'):
            button = self.module_button(args)
            if action == 'deactivate':
                start = button.DeactivateModule
            elif target is not None:
                start = lambda: button.ActivateEffect(button.def_effect, targetID=target)
            else:
                start = button.ActivateModule
        elif action == 'logoff':
            start = lambda: self.sm.GetService('gameui').LogOffCharacter()
        elif action == 'select':
            screen = self.character_selection()
            need_target()
            start = lambda: screen.ConfirmWithCharID(target)
        else:
            raise ValueError('act takes undock, dock, jump, warpTo, approach, orbit, keepAtRange, stop, lock, unlock, '
                             'activate, deactivate, modules, logoff or select; got %r' % (action,))
        what = 'act %s%s' % (action, '' if target is None else ' %s' % target)
        if action in ('activate', 'deactivate'):
            what += ' module %s' % (args.get('module'),)
        budget = bounded(args.get('wait'), DONE_MS.get(action, QUICK_DONE_MS), 0, 600000)
        if not budget:
            value = self.settle(start, args, what, limit=0)
        else:
            started = time.time()
            held = self.hold_for_session(budget) if action in SESSION_ACTIONS else 0
            before = self.where()
            check = self.done_check(action, target, before, args)
            seq = self.events.seq
            value = self.settle(start, args, what, limit=min(SETTLE_MS, budget - held), record=False)
            spent = int((time.time() - started) * 1000)
            # Still running with a dialog up: the action waits on its answer, so done can't come yet.
            if not value['finished'] and value['modal'] is not None:
                outcome = 'waiting on a dialog'
            else:
                value['done'] = self.wait_done(check, max(0, budget - held - spent))
                value['done']['heldMs'] = held
                outcome = ('done in %.1f s' % (value['done']['ms'] / 1000.0) if value['done']['reached']
                           else value['done']['why'])
            self.events.record('action', {'op': clip(what, 120), 'args': clip(outcome)})
            value['events'] = [event for event in self.events.since(seq, 50) if event['kind'] in ('exception', 'notify')]
            value['state'] = self.where()
        value.update({'action': action, 'target': target, 'session': session_snapshot(session)})
        if action in ('lock', 'unlock', 'activate'):
            # TryLockTarget shows a refusal to the player and returns; these say where the lock stands.
            service = self.sm.GetService('target')
            value['targets'] = [scalar(t) for t in attempt(lambda: sorted(service.GetTargets().keys()), [])]
            value['locking'] = [scalar(t) for t in attempt(lambda: sorted(service.GetTargeting()), [])]
        return value


def install(sm, token):
    return Agent(sm, token).start()
