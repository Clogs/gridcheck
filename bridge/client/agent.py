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
#          HasEventHandler(name), OnClick, OnDblClick, destroyed, GetMenu, menuObject_weakref
#                                        carbonui/primitives/base.py (state is read from pickState: UI_DISABLED is
#                                        pickState off, and a label's own OnClick, carbonui/control/label.py, is why
#                                        a click on a label's text found the label)
#   Button.text (its label string), Button.label, Button.disabled     carbonui/control/button.py
#   ScrollContainer clipCont, IsVerticalScrollBarVisible(), IsHorizontalScrollBarVisible(),
#          GetPositionVerticalPixels(), ScrollToVerticalPixels(px), GetPositionHorizontalPixels(),
#          ScrollToHorizontalPixels(px)  carbonui/control/scrollContainer.py (it moves mainCont inside a clipping
#          clipCont and leaves scrolled-out nodes displayed)
#   opacity                              carbonui/primitives/container.py, sprite.py
#   panel IsFullscreen()                 eve/client/script/ui/shared/mapView/dockPanel.py
#   scene, camera                        eve/client/script/ui/control/scenecontainer.py
#   Button.press() (checks enabled)      carbonui/control/button.py
#   window windowID, IsMinimized()       carbonui/control/window.py
#   edits SetValue(text), GetText()      carbonui/control/singlelineedits/baseSingleLineEdit.py, edit.py
#   uicore.uilib _OnChar(key, flags, isDead), _OnKeyDown(key, flags), _OnKeyUp(key, flags)
#                                        carbonui/uilib.py: where the window's key events land
#   uicore.uilib cursorPos, x, y, leftbtn, rightbtn, midbtn, UpdateMouseOver() (picks at x, y),
#          GetMouseOver(), GetMouseCapture(), _OnMouseMove(left, top), _OnMouseDown(button, left, top),
#          _OnMouseUp(button, left, top), _OnMouseWheel(delta)   carbonui/uilib.py; buttons uiconst MOUSELEFT 0, RIGHT 1, MIDDLE 2
#   uicore.ScaleDpi(value)               carbonui/uicore.py
#   uicore.cmd (EveCommandService): IsCommandEnabled(cm), ExecuteCommand(cm, *args), CmdStopShip
#                                        eve/client/script/ui/eveCommands.py
#   commandMap GetAllCommands(), GetCommandByName(name); a mapping's name, category,
#          GetDescription(), GetShortcutAsString()   carbonui/services/command.py
#   movementFunctions Approach(id), Orbit(id, followRange), KeepAtRange(id, followRange),
#          WarpToItem(id, warpRange=), DockOrJumpOrActivateGate(id)
#                                        eve/client/script/ui/services/menuSvcExtras/movementFunctions.py
#   undocking ExitDockableLocation()     eve/client/script/ui/shared/dockedUI/undockingSvc.py
#   menu Dock(itemID), CelestialMenu(itemID) (raw menu tuples for a space item)
#                                        eve/client/script/ui/services/menusvc.py
#   ShowMenu(object, auxObject=None)     carbonui/control/contextMenu/contextMenu.py: what a right click calls
#                                        (uilib._OnRightMouseUp); it sets object.menuObject_weakref to the ContextMenu
#   ContextMenu.menuData                 carbonui/control/contextMenu/contextMenu.py
#   CreateMenuDataFromRawTuples(raw)     carbonui/control/contextMenu/menuDataFactory.py
#   CloseContextMenus()                  carbonui/control/contextMenu/menuUtil.py
#   MenuData GetEntries() (None is a separator)    carbonui/control/contextMenu/menuData.py
#   menu entry data GetText(), IsEnabled(), GetDisabledHint(), HasFunction(), ExecuteFunction(), HasSubMenuData(),
#          GetSubMenuData() (a MenuData; a dynamic one is built on the call)
#                                        carbonui/control/contextMenu/menuEntryData.py; MenuEntryView.OnMouseUp runs
#                                        ExecuteFunction on a tasklet, then closes the menus
#   message dialogs: dialog_handler._handle_player_fsd_dialog(dialog_key, params, ...), the one function every keyed
#          message goes through (a server UserError through logmodule's uiMessageFunc, CustomNotify and the rest
#          through prompt_player_fsd_dialog)    player_messaging/client/dialog_handler.py
#   QuickMessage.show_message(text, flash_existing)  classmethod; the fading notice (notify, hint and event
#          messages end there, as do consider and drone errors)    carbonui/control/message.py
#   Logger.SayMessage(text, msgType, ...)    uilog's mining and bounty notices   eve/client/script/ui/shared/uilog.py
#   cfg.GetMessage(key, dict, onNotFound=)   carbon/common/script/sys/cfg.py (a builtin in the client)
#   stackless.getcurrent()               native
#   eveexceptions.UserError msg, dict    eveexceptions/__init__.py
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
#   blue.pyos.synchro.Yield()            native: wakes once a frame (LU's docs/CLIENT-UI-DELIVERY.md client classes)
#   window caption (a property)          carbonui/control/window.py
#   trinity.device.GetRenderContext().GetDefaultBackBuffer() (width, height, format, isReadable, Resolve),
#          Tr2RenderTarget, Tr2HostBitmap (format, ChangeFormat, Save), PIXEL_FORMAT
#                                        native (trinity), as carbonui/services/command.py PrintScreen uses them
import ast
import collections
import inspect
import json
import math
import os
import re
import sys
import time
import traceback
import types

import blue
import uthread

try:
    import __builtin__ as builtins
except ImportError:
    import builtins

VERSION = 11
# The build the client names above were checked against. Ops that use them
# refuse on another build unless the command passes anyBuild; these don't.
CHECKED_BUILD = 3396210
BUILD_FREE_OPS = ('ping', 'eval', 'events', 'flush', 'rpc', 'inspect')
# Ops whose errors are their caller's alone: a poll loop of them would bury the timeline.
CALLER_ERROR_OPS = ('eval', 'rpc')
MESSAGE_LIMIT = 500
REPR_LIMIT = 20000
# How long a drive op waits for what it started before answering; past it the
# action carries on (a dialog it opened may be waiting for an answer).
SETTLE_MS = 3000
POINTER_ACTIONS = ('move', 'click', 'drag', 'wheel')
MAX_POINTER_POINTS = 120
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
DRAIN_MS = 10000
DRAIN_POLL_MS = 50
MAX_SEND_FAILURES = 5
UI_MAX_VISITED = 50000
SESSION_KEYS = ('userid', 'charid', 'corpid', 'allianceid', 'solarsystemid2', 'solarsystemid',
                'stationid', 'structureid', 'shipid', 'locationid', 'role')
# destiny's ball modes, as bridge/destiny.js names them.
MODE_NAMES = ('GOTO', 'FOLLOW', 'STOP', 'WARP', 'ORBIT', 'MISSILE', 'MUSHROOM', 'BOID', 'TROLL',
              'MINIBALL', 'FIELD', 'RIGID', 'FORMATION')
DEFAULT_NOTIFY = ('OnSessionChanged',)
# The names eval always defines; vars can't replace them.
EVAL_NAMES = ('sm', 'session', 'uicore', 'agent', 'blue', 'uthread', 'result')
# Frames a fresh screenshot waits for: one drawn after the call, and the swap chain past it.
FRESH_FRAMES = 3
INSPECT_LIMIT = 10
# Python 2.7's old-style classes are types.ClassType.
CLASS_TYPES = (type,) + ((types.ClassType,) if hasattr(types, 'ClassType') else ())
# carbonui.uiconst UI_NORMAL, UI_DISABLED, UI_HIDDEN, UI_PICKCHILDREN.
STATE_NAMES = {0: 'normal', 1: 'disabled', 2: 'hidden', 3: 'pickChildren'}
UI_DISABLED = 1
# How deep node_text looks into a button for its label.
BUTTON_LABEL_DEPTH = 3
TAG_PATTERN = re.compile(r'<[^>]*>')
ENTITY_PATTERN = re.compile(r'&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z]+);')
ENTITIES = {'amp': u'&', 'lt': u'<', 'gt': u'>', 'quot': u'"', 'apos': u"'", 'nbsp': u' '}
SEGMENT_INDEX = re.compile(r'\[\d+\]$')
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
        # scheduled: a flush tasklet waits out FLUSH_MS. sending: one is in Events; only one at a time, so no batch goes twice.
        self.scheduled = False
        self.sending = False
        self.failures = 0
        self.listeners = {}
        self.logmodule = None
        self.original = None
        # (owner, name, what the owner held, what this put there), for stop.
        self.patches = []
        self.messages_hooked = False
        # Tasklets inside a keyed message (dialog_handler): the fading notice it ends in is already recorded.
        self.keyed = {}

    def start(self, notify):
        self.hook_exceptions()
        self.hook_messages()
        self.select(notify)

    def stop(self):
        if self.logmodule is not None and getattr(self.logmodule._LogException, 'gridcheck_original', None) is self.original:
            self.logmodule._LogException = self.original
        self.logmodule = None
        self.unhook_messages()
        self.select(())

    # Replaces owner.name with wrap(what it held), which takes the same arguments (a method's
    # first is self, a classmethod's or staticmethod's is not). A wrapper an earlier agent left
    # is looked through, not wrapped again.
    def patch(self, owner, name, wrap):
        saved = owner.__dict__[name]
        current = getattr(owner, name)
        stale = getattr(current, 'gridcheck_original', None)
        if stale is not None:
            saved = current.gridcheck_saved
            current = stale
        wrapper = wrap(current)
        wrapper.gridcheck_original = current
        wrapper.gridcheck_saved = saved
        installed = staticmethod(wrapper) if isinstance(saved, (classmethod, staticmethod)) else wrapper
        setattr(owner, name, installed)
        self.patches.append((owner, name, saved, installed))

    # Every message the player is shown, as a 'message' event { key, text, type }: the keyed ones
    # (a server UserError, CustomNotify, ...) at dialog_handler, the fading notice at
    # QuickMessage.show_message (also called by itself, with no key), the mining and bounty notices
    # at Logger.SayMessage. Per-hit combat text (Logger.Say) is left out: it fires on every shot.
    def hook_messages(self):
        events = self

        def keyed_dialog(original):
            def _handle_player_fsd_dialog(dialog_key, params=None, *args, **kwargs):
                me = id(stackless.getcurrent())
                events.keyed[me] = events.keyed.get(me, 0) + 1
                try:
                    attempt(lambda: events.dialog(dialog_key, params))
                    return original(dialog_key, params, *args, **kwargs)
                finally:
                    events.keyed[me] -= 1
                    if events.keyed[me] <= 0:
                        events.keyed.pop(me, None)
            return _handle_player_fsd_dialog

        def quick(original):
            def show_message(text, flash_existing=True):
                if id(stackless.getcurrent()) not in events.keyed:
                    attempt(lambda: events.message(None, text))
                return original(text, flash_existing)
            return show_message

        def say(original):
            def SayMessage(logger, text, msgType, *args, **kwargs):
                attempt(lambda: events.message(None, text, msgType))
                return original(logger, text, msgType, *args, **kwargs)
            return SayMessage

        try:
            import stackless
            from player_messaging.client import dialog_handler
            from carbonui.control.message import QuickMessage
            from eve.client.script.ui.shared import uilog
            self.patch(dialog_handler, '_handle_player_fsd_dialog', keyed_dialog)
            self.patch(QuickMessage, 'show_message', quick)
            self.patch(uilog.Logger, 'SayMessage', say)
            self.messages_hooked = True
        except Exception as error:
            self.unhook_messages()
            print('GRIDCHECK_CLIENT:MESSAGES_NOT_RECORDED %r' % (error,))

    def unhook_messages(self):
        for owner, name, saved, installed in reversed(self.patches):
            if owner.__dict__.get(name) is installed:
                setattr(owner, name, saved)
        self.patches = []
        self.messages_hooked = False
        self.keyed = {}

    def message(self, key, text, kind=None):
        text = plain_text(text)
        if not text:
            return
        fields = {'key': clip(key) or None, 'text': clip(text, MESSAGE_LIMIT)}
        if kind is not None:
            fields['type'] = scalar(kind)
        self.record('message', fields)

    def dialog(self, key, params):
        cfg = getattr(builtins, 'cfg', None)
        if cfg is None or not isinstance(key, TEXT):
            return
        # GetMessage rewrites the dict it is given.
        data = cfg.GetMessage(key, dict(params) if isinstance(params, dict) else params, onNotFound='pass')
        if data is not None:
            self.message(key, data.text, data.type)

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
        # A send in progress picks this event up before it ends.
        if not self.scheduled and not self.sending and self.failures < MAX_SEND_FAILURES and self.agent.active:
            self.scheduled = True
            uthread.new(self.flush)

    def flush(self):
        try:
            blue.pyos.synchro.SleepWallclock(FLUSH_MS)
        finally:
            self.scheduled = False
        if not self.sending:
            self.send()

    # Sends everything pending, in batches; answers how many went.
    def send(self):
        sent = 0
        self.sending = True
        try:
            while self.pending and self.agent.active:
                batch = self.pending[:EVENT_BATCH]
                payload = dumps({'events': batch, 'dropped': self.dropped})
                self.agent.remote().Events(self.agent.token, payload)
                del self.pending[:len(batch)]
                sent += len(batch)
                self.dropped = 0
                self.failures = 0
        except Exception as error:
            self.failures += 1
            print('GRIDCHECK_CLIENT:EVENTS_FAILED %r' % (error,))
        finally:
            self.sending = False
        return sent

    # What is pending, sent now rather than with the next batch: before the
    # client is ended, or a run stops listening.
    def drain(self):
        waited = 0
        while self.sending and waited < DRAIN_MS:
            blue.pyos.synchro.SleepWallclock(DRAIN_POLL_MS)
            waited += DRAIN_POLL_MS
        if self.sending:
            raise RuntimeError('a send of events was still running after %d ms' % DRAIN_MS)
        return self.send()

    def since(self, seq, limit):
        rows = [event for event in self.ring if event['seq'] > seq]
        return rows[-limit:] if limit else rows


def strip_tags(text):
    return TAG_PATTERN.sub('', text)


def unescape(text):
    def one(match):
        body = match.group(1)
        if body.startswith('#'):
            code = attempt(lambda: int(body[2:], 16) if body[1:2] in ('x', 'X') else int(body[1:]))
            return attempt(lambda: unichr(code), None) or attempt(lambda: chr(code), match.group(0)) if code is not None else match.group(0)
        return ENTITIES.get(body.lower(), match.group(0))
    return ENTITY_PATTERN.sub(one, text)


# What a text search compares: markup and entities gone, any run of whitespace (a no-break space
# too) one space, lower case. "75%" finds "<color=0xff00ff00>75</color>&nbsp;%" as "75 %".
def search_text(value):
    if not isinstance(value, (bytes, UNICODE)):
        return ''
    text = re.sub(r'<br\s*/?>', ' ', as_text(value), flags=re.I)
    return u' '.join(unescape(strip_tags(text)).replace(u'\xa0', u' ').split()).lower()


# What a player reads: markup gone, line breaks as spaces.
def plain_text(text):
    if not isinstance(text, TEXT):
        return ''
    return ' '.join(strip_tags(re.sub(r'<br\s*/?>', ' ', as_text(text), flags=re.I)).split())


# An error whose message a Python 2 traceback can print: unicode with non-ASCII characters can't be.
def refuse(text):
    if bytes is str and isinstance(text, UNICODE):
        text = text.encode('utf-8')
    return ValueError(text)


def menu_text(entry):
    return plain_text(attempt(entry.GetText, ''))


def disabled_hint(entry):
    hint = plain_text(attempt(entry.GetDisabledHint))
    return ' (%s)' % hint if hint else ''


def own_text(node):
    for attr in ('text', 'caption'):
        value = attempt(lambda: getattr(node, attr, None))
        if isinstance(value, TEXT) and value:
            return value
    return None


def node_children(node):
    children = attempt(lambda: getattr(node, 'children', None))
    if children is None:
        return []
    return attempt(lambda: list(children), [])


def button_like(node):
    return attempt(lambda: any('Button' in cls.__name__ for cls in type(node).__mro__), False)


# The first label under a node, looking BUTTON_LABEL_DEPTH levels down through displayed children.
def descendant_text(node):
    level = [node]
    for _depth in range(BUTTON_LABEL_DEPTH):
        below = []
        for parent in level:
            for kid in node_children(parent):
                if not attempt(lambda: kid.display, False):
                    continue
                value = own_text(kid)
                if value:
                    return value
                below.append(kid)
        level = below[:50]
    return None


# A node's own text or caption. A button without one answers its label (a Button's text is its
# label string; another button class keeps it in a label node), so a search for what the player
# reads finds the button.
def full_text(node):
    value = own_text(node)
    if value is None and button_like(node):
        label = attempt(lambda: getattr(node, 'label', None))
        value = label if isinstance(label, TEXT) and label else descendant_text(node)
    return value or None


def node_text(node):
    value = full_text(node)
    return clip(value) if value else None


# The whole text, not the clipped one a listing shows. The markup counts as part of the text, and
# does not: "<b>Issue" matches as written, and "75 %" matches "75%" (spaces aside).
def text_matches(wanted, text):
    if not wanted:
        return True
    if not text:
        return False
    if lower(wanted) in (lower(text) or ''):
        return True
    want, have = search_text(wanted), search_text(text)
    return bool(want) and (want in have or want.replace(u' ', u'') in have.replace(u' ', u''))


# Siblings that share a label get a [n] suffix (n from 0, counting hidden siblings), so a path names one node.
def sibling_segments(kids):
    labels = [node_label(kid) for kid in kids]
    counts = collections.Counter(labels)
    seen = {}
    segments = []
    for label in labels:
        if counts[label] > 1:
            number = seen.get(label, 0)
            seen[label] = number + 1
            segments.append('%s[%d]' % (label, number))
        else:
            segments.append(label)
    return segments


# A path as ui prints it, or one whose segments leave out the [n] they could have: that matches
# every sibling with the label, so it names one node only where there is one.
def path_matches(wanted, here):
    if wanted == here:
        return True
    left = wanted.split('/')
    right = here.split('/')
    if len(left) != len(right):
        return False
    for want, have in zip(left, right):
        if want != have and want != SEGMENT_INDEX.sub('', have):
            return False
    return True


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


def finite(value):
    return (isinstance(value, INTS + (float,)) and not isinstance(value, bool)
            and not math.isnan(value) and not math.isinf(value))


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


def walk_nodes(root, hidden, here=None, chain=()):
    """Every node under root, depth first, as (node, path, ancestors); the paths
    are the ones op ui prints. Hidden subtrees are skipped unless hidden. A root
    below the desktop takes its own path and ancestors (Agent.path_of)."""
    stack = [(root, here or '/' + node_label(root), tuple(chain))]
    visited = 0
    while stack and visited < UI_MAX_VISITED:
        node, here, chain = stack.pop()
        visited += 1
        yield node, here, chain
        kids = node_children(node)
        segments = sibling_segments(kids)
        for kid, segment in reversed(list(zip(kids, segments))):
            if hidden or attempt(lambda: kid.display, False):
                stack.append((kid, '%s/%s' % (here, segment), chain + (node,)))


def has_handler(node, name):
    found = attempt(lambda: node.HasEventHandler(name))
    if found is None:
        found = callable(getattr(node, name, None))
    return bool(found)


def takes_mouse(node):
    """False for a node a click passes through to what is behind it (UI_DISABLED, such as a label)."""
    return attempt(lambda: node.state) != UI_DISABLED


def clickable(node, here, chain, name):
    """The node, or its nearest ancestor, that handles name and takes mouse input, with its path
    and the paths of the nodes it passed over because a click goes through them. A real target that
    is disabled (a Button) is still returned: the caller says so."""
    parts = here.split('/')
    passed = []
    for depth, candidate in enumerate(reversed(chain + (node,))):
        if not has_handler(candidate, name):
            continue
        path = '/'.join(parts[:len(parts) - depth])
        if takes_mouse(candidate):
            return candidate, path, passed
        passed.append(path)
    return None, None, passed


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


# "Name(self, a, b=1, *args, **kwargs)" for a class's function, staticmethod or classmethod.
def signature(name, item):
    function = getattr(item, '__func__', item)
    reader = getattr(inspect, 'getfullargspec', None) or inspect.getargspec
    spec = attempt(lambda: reader(function))
    if spec is None:
        return name
    args = list(spec.args)
    defaults = list(spec.defaults or ())
    plain = len(args) - len(defaults)
    parts = args[:plain] + ['%s=%s' % (arg, clip(attempt(lambda: repr(value), '?'), 40)) for arg, value in zip(args[plain:], defaults)]
    if spec.varargs:
        parts.append('*' + spec.varargs)
    keywords = getattr(spec, 'keywords', None) or getattr(spec, 'varkw', None)
    if keywords:
        parts.append('**' + keywords)
    return '%s(%s)' % (name, ', '.join(parts))


def type_name(typeID):
    try:
        import evetypes
        return clip(evetypes.GetName(typeID))
    except Exception:
        return None


class EnforceAssertions(ast.NodeTransformer):
    """The client runs Python optimized, which compiles assert away. Eval code
    gets each assert rewritten as `if not test: raise AssertionError(msg)`."""

    def visit_Assert(self, node):
        call = ast.Call(func=ast.Name(id='AssertionError', ctx=ast.Load()),
                        args=[node.msg] if node.msg is not None else [], keywords=[])
        if sys.version_info[0] < 3:
            call.starargs = None
            call.kwargs = None
            raised = ast.Raise(type=call, inst=None, tback=None)
        else:
            raised = ast.Raise(exc=call, cause=None)
        check = ast.If(test=ast.UnaryOp(op=ast.Not(), operand=node.test), body=[raised], orelse=[])
        return ast.copy_location(check, node)


class Agent(object):
    __notifyevents__ = ['OnGridcheckClient']
    # One pointer command at a time: each moves uilib's cursor and puts it back.
    pointer_busy = False

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
            # An eval's own mistakes (and a refused rpc) are its caller's alone; a poll loop of them would bury the timeline.
            if op not in CALLER_ERROR_OPS:
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
        desktop = getattr(self.current_uicore(), 'desktop', None)
        value.update({
            'wallclock': scalar(blue.os.GetWallclockTime()),
            'ui': [whole(attempt(lambda: desktop.width)), whole(attempt(lambda: desktop.height))] if desktop is not None else None,
            'session': session_snapshot(getattr(builtins, 'session', None)),
            'where': attempt(self.where),
            'events': {'seq': self.events.seq, 'notify': sorted(self.events.listeners),
                       'exceptions': self.events.logmodule is not None, 'messages': self.events.messages_hooked},
        })
        return value

    # args: {"code": "..."}. An expression answers its value; statements that
    # end in an expression answer that, as a REPL does; other statements answer
    # whatever they leave in `result`. Names persist between calls; sm, session,
    # uicore, agent, blue and uthread are always current. truth adds bool(value) as
    # `truth`, in Python's own sense (an empty list is false); soft answers an error
    # the code raises as { error, truth: false } rather than failing (a syntax error
    # still fails: no later try can pass), for a caller that polls.
    def op_eval(self, args):
        code = args.get('code') or ''
        if not isinstance(code, TEXT):
            raise ValueError('eval code must be text')
        given = args.get('vars')
        if given is not None:
            if not isinstance(given, dict):
                raise ValueError('vars: an object of names and the values to give them')
            for key in given:
                if not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', key) or key in EVAL_NAMES:
                    raise refuse('vars: %s is not a name eval can be given (a Python identifier, not %s)' % (key, ', '.join(EVAL_NAMES)))
            self.namespace.update((str(key), value) for key, value in given.items())
        try:
            value = self.eval_value(code)
        except SyntaxError:
            raise
        except Exception:
            if not (args.get('truth') and args.get('soft')):
                raise
            return {'repr': None, 'truncated': False, 'json': None, 'truth': False,
                    'error': traceback.format_exc().strip().splitlines()[-1]}
        text = repr(value)
        safe = json_safe(value)
        reply = {
            'repr': text[:REPR_LIMIT],
            'truncated': len(text) > REPR_LIMIT,
            'json': safe if jsonable(safe) else None,
        }
        if args.get('truth'):
            reply['truth'] = bool(value)
        return reply

    def eval_value(self, code):
        # Compiled as unicode, so u"..." literals keep their characters on 2.7;
        # its UTF-8 bytes would be read as Latin-1.
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
            if sys.flags.optimize:
                tree = ast.fix_missing_locations(EnforceAssertions().visit(tree))
            last =tree.body[-1] if tree.body and isinstance(tree.body[-1], ast.Expr) else None
            if last is not None:
                tree.body = tree.body[:-1]
            eval(compile(tree, '<gridcheck-eval>', 'exec'), namespace)
            if last is not None:
                value = eval(compile(ast.fix_missing_locations(ast.Expression(last.value)), '<gridcheck-eval>', 'eval'), namespace)
            else:
                value = namespace.get('result')
        return value

    # args: {"service", "method", "payload" | "args"}. sm.RemoteSvc(service).method(...)
    # as the client's character. payload is passed as the one JSON-encoded string the
    # Living Universe commands take, and a reply that is a JSON string is decoded; args
    # are passed as they are. A server UserError fails with its message. Answers like eval.
    def op_rpc(self, args):
        names = []
        for key in ('service', 'method'):
            value = args.get(key)
            if not isinstance(value, TEXT) or not re.match(r'^[A-Za-z][A-Za-z0-9_]*$', value):
                raise ValueError('%s: a name of letters, digits and _' % key)
            names.append(str(value))
        service, method = names
        payload = args.get('payload')
        call_args = args.get('args')
        if payload is not None and call_args is not None:
            raise ValueError('pass payload or args, not both')
        if call_args is not None and not isinstance(call_args, list):
            raise ValueError('args: a list')
        if payload is not None:
            call_args = [json.dumps(payload)]
        remote = self.sm.RemoteSvc(service)
        function = getattr(remote, method, None)
        if not callable(function):
            raise ValueError('the %s service has no method %s' % (service, method))
        try:
            reply = function(*(call_args or []))
        except Exception as error:
            raise refuse(self.refusal(service, method, error))
        if payload is not None and isinstance(reply, TEXT):
            try:
                reply = json.loads(reply)
            except ValueError:
                pass
        text = repr(reply)
        safe = json_safe(reply)
        return {'repr': text[:REPR_LIMIT], 'truncated': len(text) > REPR_LIMIT, 'json': safe if jsonable(safe) else None}

    # A UserError as the player would read it, else the exception's own line.
    def refusal(self, service, method, error):
        key = getattr(error, 'msg', None)
        if not (isinstance(key, TEXT) and type(error).__name__.endswith('UserError')):
            return '%s.%s raised %s' % (service, method, traceback.format_exception_only(type(error), error)[-1].strip())
        cfg = getattr(builtins, 'cfg', None)
        data = attempt(lambda: cfg.GetMessage(key, dict(getattr(error, 'dict', None) or {}), onNotFound='pass'))
        text = plain_text(getattr(data, 'text', None))
        return '%s.%s was refused (UserError %s)%s' % (service, method, key, ': ' + text if text else '')

    # args: {"limit"}. Every node under the desktop, hidden ones too, flat, with
    # what check-ui asserts: shown and enabled counting its ancestors, opacity,
    # full screen, a scene. A scene is structure: it doesn't prove a frame was drawn.
    def op_ui_state(self, args):
        started = time.time()
        uicore, desktop = self.desktop()
        limit = bounded(args.get('limit'), 10000, 1, 20000)
        registry = getattr(uicore, 'registry', None)
        focus = attempt(lambda: registry.GetFocus())
        modal = attempt(lambda: registry.GetModalWindow())
        nodes = []
        by_id = {}
        truncated = False
        for node, here, chain in walk_nodes(desktop, True):
            if len(nodes) >= limit:
                truncated = True
                break
            info = node_info(node)
            info['uid'] = str(id(node))
            info['path'] = here
            info['parentUID'] = str(id(chain[-1])) if chain else None
            line = chain + (node,)
            info['effectiveDisplay'] = all(
                attempt(lambda n=n: bool(n.display), False) and attempt(lambda n=n: n.state) != 2
                and not attempt(lambda n=n: n.destroyed, False) for n in line)
            # A pickChildren ancestor needn't take input itself; only a disabled one blocks its children.
            info['effectiveEnabled'] = (info['effectiveDisplay'] and info['enabled'] is not False
                                        and all(attempt(lambda n=n: n.state) != 1 for n in line))
            info['opacity'] = attempt(lambda: float(node.opacity))
            info['fullscreen'] = attempt(lambda: bool(node.IsFullscreen()))
            scene = attempt(lambda: node.scene)
            info['scenePresent'] = attempt(lambda: node.scene is not None)
            info['sceneUID'] = str(id(scene)) if scene is not None else None
            info['cameraPresent'] = attempt(lambda: node.camera is not None)
            nodes.append(info)
            by_id[id(node)] = info

        def outside(node):
            if node is None:
                return None
            info = dict(by_id.get(id(node)) or node_info(node))
            info['uid'] = str(id(node))
            return info
        return {
            'schema': 1,
            'nodes': nodes,
            'truncated': truncated,
            'desktop': node_info(desktop),
            'focus': outside(focus),
            'modal': outside(modal),
            'windows': [window_info(window) for window in attempt(lambda: registry.GetWindows(), []) or []],
            'session': session_snapshot(getattr(builtins, 'session', None)),
            'agentVersion': VERSION,
            'checkedBuild': CHECKED_BUILD,
            'sampleMs': max(0, int((time.time() - started) * 1000)),
        }

    # args: {"depth", "cls", "name", "text", "hidden", "limit", "window"}. Without a filter,
    # the tree from uicore.desktop (or the window) to depth (default 3). With one, every node at
    # any depth whose class, name or text contains it (case-insensitive), each
    # with its path. Hidden subtrees are skipped unless hidden is true.
    def op_ui(self, args):
        uicore, desktop = self.desktop()
        root, root_path = desktop, '/' + node_label(desktop)
        if args.get('window'):
            root = self.window_scope(args.get('window'))
            root_path = self.path_of(root)[0]
        filters = dict((key, lower(args.get(key))) for key in ('cls', 'name', 'text'))
        finding = any(filters.values())
        depth = bounded(args.get('depth'), 40 if finding else 3, 0, 60)
        limit = bounded(args.get('limit'), 200 if finding else 2000, 1, 20000)
        hidden = bool(args.get('hidden'))
        counts = {'visited': 0, 'listed': 0, 'truncated': False}
        matches = []

        def matched(node, info):
            for key in ('cls', 'name'):
                wanted = filters[key]
                if wanted and wanted not in (lower(info.get(key)) or ''):
                    return False
            return text_matches(filters['text'], full_text(node))

        def walk(node, level, here):
            counts['visited'] += 1
            info = node_info(node)
            kids = node_children(node)
            info['children'] = len(kids)
            if finding and matched(node, info):
                info['path'] = here
                matches.append(info)
                if len(matches) >= limit:
                    counts['truncated'] = True
            elif not finding:
                counts['listed'] += 1
            if level >= depth or counts['truncated']:
                return info
            shown = []
            for kid, segment in zip(kids, sibling_segments(kids)):
                if counts['truncated'] or counts['visited'] >= UI_MAX_VISITED:
                    counts['truncated'] = True
                    break
                if not hidden and not attempt(lambda: kid.display, False):
                    continue
                if not finding and counts['listed'] >= limit:
                    counts['truncated'] = True
                    break
                child = walk(kid, level + 1, '%s/%s' % (here, segment))
                if not finding:
                    shown.append(child)
            if not finding:
                info['kids'] = shown
            return info

        tree = walk(root, 0, root_path)
        registry = getattr(uicore, 'registry', None)
        windows = attempt(registry.GetWindows, []) if registry is not None else []
        value = {
            'windows': [window_info(window) for window in windows or [] if root is desktop or window is root],
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
        # Pointer coordinates are UI units (the desktop's size), not back buffer pixels.
        desktop = getattr(self.current_uicore(), 'desktop', None)
        return {'file': target, 'width': back.width, 'height': back.height, 'ms': int((time.time() - started) * 1000),
                'uiWidth': whole(attempt(lambda: desktop.width)), 'uiHeight': whole(attempt(lambda: desktop.height))}

    # args: {"fresh", "window", "path", "hidden"}. Before a screenshot: fresh waits until the
    # client has drawn FRESH_FRAMES frames after this call, so the picture shows what the calls
    # before it changed; window or path answers that node's rect in UI units, cut to the desktop,
    # for the picture to be cropped to.
    def op_area(self, args):
        _uicore, desktop = self.desktop()
        if args.get('fresh'):
            for _frame in range(FRESH_FRAMES):
                blue.pyos.synchro.Yield()
        width, height = whole(attempt(lambda: desktop.width)), whole(attempt(lambda: desktop.height))
        value = {'ui': [width, height], 'rect': None}
        if args.get('window') or args.get('path'):
            if args.get('window') and args.get('path'):
                raise refuse('crop to a window or a path, not both')
            if args.get('window'):
                node = self.window_scope(args.get('window'))
                where = node_label(node)
            else:
                node, where, _chain = self.locate({'path': args.get('path'), 'hidden': args.get('hidden')})
            rect = attempt(lambda: node.GetAbsolute())
            if not rect or not attempt(lambda: node.display, False):
                raise refuse('%s is not displayed, so it has no area to crop to' % where)
            left, top = max(0, whole(rect[0])), max(0, whole(rect[1]))
            right, bottom = min(width or 0, whole(rect[0] + rect[2])), min(height or 0, whole(rect[1] + rect[3]))
            if right <= left or bottom <= top:
                raise refuse('%s lies outside the desktop (%s)' % (where, [whole(v) for v in rect]))
            value['rect'] = [left, top, right - left, bottom - top]
        return value

    # args: {"cls": a class name, "module": part of a module's name, "inherited": bool}. The
    # classes of that name in the client's loaded modules (sys.modules), exact name first, else
    # case-insensitive: where each is defined and importable from, its base classes, its default_*
    # attributes (carbonui's construction defaults) with their values, and its own methods with
    # their arguments; inherited lists the inherited ones by class too. A module the client hasn't
    # loaded yet isn't searched.
    def op_inspect(self, args):
        wanted = args.get('cls')
        if not isinstance(wanted, TEXT) or not re.match(r'^[A-Za-z_][A-Za-z0-9_]*$', wanted):
            raise refuse('cls: a class name, e.g. Slider')
        wanted = str(wanted)
        within = lower(args.get('module'))
        exact = collections.OrderedDict()
        loose = collections.OrderedDict()
        scanned = 0
        for name, mod in list(sys.modules.items()):
            if mod is None or (within and within not in name.lower()):
                continue
            space = attempt(lambda: vars(mod))
            if not isinstance(space, dict):
                continue
            scanned += 1
            if scanned % 500 == 0:
                blue.pyos.synchro.SleepWallclock(1)
            found = space.get(wanted)
            if isinstance(found, CLASS_TYPES):
                exact.setdefault(id(found), [found, []])[1].append(name)
            elif not exact:
                for key, value in list(space.items()):
                    if isinstance(value, CLASS_TYPES) and isinstance(key, str) and key.lower() == wanted.lower():
                        loose.setdefault(id(value), [value, []])[1].append(name)
        rows = list((exact or loose).values())
        return {'cls': wanted, 'scanned': scanned, 'count': len(rows),
                'matches': [self.class_info(klass, modules, bool(args.get('inherited'))) for klass, modules in rows[:INSPECT_LIMIT]]}

    def class_info(self, klass, modules, inherited):
        mro = attempt(lambda: list(inspect.getmro(klass)), [klass])

        def owner(name):
            for base in mro:
                if name in attempt(lambda: vars(base), {}):
                    return base
            return None

        def label(base):
            return '%s.%s' % (getattr(base, '__module__', '?'), base.__name__)

        defaults = []
        for name in sorted(attempt(lambda: dir(klass), [])):
            if name.startswith('default_'):
                base = owner(name)
                defaults.append({'name': name, 'value': clip(attempt(lambda: repr(getattr(klass, name)), '?'), 160),
                                 'from': base.__name__ if base is not None else None})
        own = attempt(lambda: vars(klass), {})
        methods = []
        properties = []
        for name in sorted(own):
            item = own[name]
            if isinstance(item, property):
                properties.append(name)
            elif callable(item) or isinstance(item, (classmethod, staticmethod)):
                if not name.startswith('__') or name == '__init__':
                    methods.append(signature(name, item))
        others = collections.OrderedDict()
        for base in mro[1:]:
            names = sorted(name for name, item in attempt(lambda: vars(base), {}).items()
                           if (callable(item) or isinstance(item, (classmethod, staticmethod))) and not name.startswith('__')
                           and name not in own and owner(name) is base)
            if names:
                others[label(base)] = names if inherited else len(names)
        defining = getattr(klass, '__module__', None)
        return {'name': klass.__name__, 'module': defining, 'importable': sorted(set(modules))[:12],
                'bases': [label(base) for base in mro[1:]], 'defaults': defaults, 'methods': methods,
                'properties': properties, 'inherited': others}

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

    # Sends the events still pending to the bridge before it answers.
    def op_flush(self, args):
        sent = self.events.drain()
        return {'sent': sent, 'pending': len(self.events.pending), 'seq': self.events.seq}

    # ---- driving the client ----

    # Runs start() on its own tasklet and waits up to args.wait ms (default
    # SETTLE_MS) for it. What it started may open a dialog and wait for an
    # answer; then finished is false and modal names the dialog.
    def settle(self, start, args, what, limit=None, record=True):
        box = {}
        seq = self.events.seq

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
        # What the player was told meanwhile (a refusal fades from the screen within seconds).
        messages = [{'key': event.get('key'), 'text': event.get('text')}
                    for event in self.events.since(seq, 20) if event['kind'] == 'message']
        return {
            'finished': bool(box.get('done')),
            'result': safe if jsonable(safe) else clip(value),
            'modal': window_info(modal) if modal is not None else None,
            'messages': messages,
        }

    def desktop(self):
        uicore = self.current_uicore()
        desktop = getattr(uicore, 'desktop', None)
        if desktop is None:
            raise ValueError('uicore.desktop is not ready')
        return uicore, desktop

    # The open window wanted names: its windowID, name, class or caption, exact first, else
    # contains (case-insensitive). None or several is an error listing the open windows.
    def window_scope(self, wanted):
        uicore = self.current_uicore()
        registry = getattr(uicore, 'registry', None)
        windows = [window for window in (attempt(lambda: registry.GetWindows(), []) or [])
                   if not attempt(lambda: window.destroyed, False)]
        key = lower(as_text(wanted) if isinstance(wanted, (bytes, UNICODE)) else str(wanted))
        if not key:
            raise refuse('window: a window\'s ID, name, class or caption')

        def labels(window):
            values = [attempt(lambda: getattr(window, 'windowID', None)), attempt(lambda: window.name), type(window).__name__,
                      full_text(window)]
            return [lower(value if isinstance(value, (bytes, UNICODE)) else str(value)) for value in values if value is not None]
        rows = [(window, labels(window)) for window in windows]
        found = [window for window, names in rows if key in names] or [window for window, names in rows if any(key in name for name in names)]
        if len(found) == 1:
            return found[0]
        listed = ', '.join('%s (%s)' % (attempt(lambda: window.windowID) or node_label(window), type(window).__name__)
                           for window in (found or windows)[:20])
        raise refuse('%s window "%s"; %s' % ('no' if not found else '%d windows match' % len(found), wanted,
                                             'the open windows are: %s' % (listed or '(none)') if not found else listed))

    # A node's path and ancestors, as walk_nodes from the desktop gives them.
    def path_of(self, target):
        _uicore, desktop = self.desktop()
        for node, here, chain in walk_nodes(desktop, True):
            if node is target:
                return here, chain
        raise ValueError('%s is not under the desktop' % node_label(target))

    # The one displayed node args name: path (as ui prints it; a segment without
    # its [n] matches each sibling with that label), cls, name and text (contains,
    # case-insensitive), all of them together, with index to pick among what is left.
    # window keeps to one window's nodes. With text, path, cls and name may name the
    # node a click on the text goes to instead (the label's own button). handler (a
    # click's OnClick or OnDblClick) prefers the matches that take that click, and of
    # matches a click sends to the same node, keeps one.
    def locate(self, args, handler=None):
        uicore, desktop = self.desktop()
        path = args.get('path')
        filters = dict((key, lower(args.get(key))) for key in ('cls', 'name', 'text'))
        if not path and not any(filters.values()):
            raise ValueError('name the node: path (from ui), or cls, name or text')
        root, here, chain = desktop, None, ()
        if args.get('window'):
            root = self.window_scope(args.get('window'))
            here, chain = self.path_of(root)

        def selects(node, where):
            if path and not path_matches(path, where):
                return False
            for key in ('cls', 'name'):
                have = type(node).__name__ if key == 'cls' else attempt(lambda: node.name)
                if filters[key] and filters[key] not in (lower(have) or ''):
                    return False
            return True

        found = []
        for node, where, above in walk_nodes(root, bool(args.get('hidden')), here, chain):
            if not text_matches(filters['text'], full_text(node) if filters['text'] else None):
                continue
            if not selects(node, where):
                if not filters['text']:
                    continue
                target, target_path, _passed = clickable(node, where, above, 'OnClick')
                if target is None or not selects(target, target_path):
                    continue
            found.append((node, where, above))
        # A button and its own label both match its text; the outermost stands for both.
        matched = set(id(node) for node, _here, _chain in found)
        found = [row for row in found if not any(id(up) in matched for up in row[2])]
        if handler is not None:
            takers = []
            targets = set()
            for row in found:
                target = clickable(row[0], row[1], row[2], handler)[0]
                if target is not None and id(target) not in targets:
                    targets.add(id(target))
                    takers.append(row)
            found = takers or found
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
                json.dumps(dict((k, v) for k, v in dict(filters, path=path, window=args.get('window')).items() if v)),))
        listed = '\n'.join('  [%d] %s' % (n, here) for n, (_node, here, _chain) in enumerate(found[:12]))
        raise ValueError('%d nodes match; pass index or path:\n%s%s' % (len(found), listed, '\n  ...' if len(found) > 12 else ''))

    def described(self, node, here):
        info = node_info(node)
        info['path'] = here
        return info

    # args: {"action": move|click|drag|wheel, "points": [[x, y], ...], "button",
    # "durationMs", "delta"}. A pointer path in UI units through uilib's own
    # mouse handlers: each point is picked as a frame picks the real cursor,
    # then moved to; click and drag press at the first point and release at
    # the last. The OS cursor doesn't move, and the next frame's own pick can
    # replace this one, so hover that has to last needs the real mouse.
    def op_pointer(self, args):
        uicore = self.current_uicore()
        uilib = uicore.uilib
        action = args.get('action', 'move')
        if action not in POINTER_ACTIONS:
            raise ValueError('pointer action: move, click, drag or wheel')
        points = args.get('points')
        if not isinstance(points, list) or not 1 <= len(points) <= MAX_POINTER_POINTS:
            raise ValueError('pointer points: 1 to %d [x, y] pairs' % MAX_POINTER_POINTS)
        path = []
        for point in points:
            if not isinstance(point, (list, tuple)) or len(point) != 2 or not all(finite(value) for value in point):
                raise ValueError('a pointer point is [x, y], two numbers')
            x, y = point
            if not (0 <= x < uicore.desktop.width and 0 <= y < uicore.desktop.height):
                raise ValueError('pointer point [%s, %s] is outside the desktop (%s x %s)' % (x, y, uicore.desktop.width, uicore.desktop.height))
            path.append((x, y))
        button = args.get('button', 0)
        if isinstance(button, bool) or button not in (0, 1, 2):
            raise ValueError('pointer button: 0 left, 1 right, 2 middle')
        duration = args.get('durationMs', 0)
        if not finite(duration) or not 0 <= duration <= 3000:
            raise ValueError('pointer durationMs: 0 to 3000')
        delta = args.get('delta', 0)
        if action == 'wheel' and (not finite(delta) or delta == 0 or abs(delta) > 12000):
            raise ValueError('wheel delta: not 0, -12000 to 12000')
        if action == 'drag' and len(path) < 2:
            raise ValueError('a drag needs two points or more')
        if uilib.leftbtn or uilib.rightbtn or uilib.midbtn or uilib.GetMouseCapture() is not None:
            raise ValueError('a mouse button is down or something holds the mouse; pointer waits for it to be let go')
        if self.pointer_busy:
            raise ValueError('another pointer command is under way')
        before = (uilib.cursorPos, uilib.x, uilib.y)
        self.pointer_busy = True
        pressed = False
        picked = None
        try:
            for index, (x, y) in enumerate(path):
                raw = (int(uicore.ScaleDpi(x)), int(uicore.ScaleDpi(y)))
                uilib.cursorPos = raw
                # UpdateMouseOver picks at uilib.x, y; _OnMouseMove then moves there from the last point.
                uilib.x, uilib.y = x, y
                uilib.UpdateMouseOver()
                uilib.x, uilib.y = before[1:] if index == 0 else path[index - 1]
                uilib._OnMouseMove(*raw)
                if index == 0 and action in ('click', 'drag'):
                    pressed = True
                    uilib._OnMouseDown(button, *raw)
                picked = uilib.GetMouseOver()
                if duration and index + 1 < len(path):
                    blue.pyos.synchro.SleepWallclock(int(duration / (len(path) - 1)))
            if action == 'wheel':
                uilib._OnMouseWheel(int(delta))
            target = node_info(picked) if picked is not None else None
            attempt(lambda: self.events.record('action', {'op': 'pointer %s' % action,
                                                          'args': clip((target or {}).get('name') or (target or {}).get('cls'))}))
            return {'action': action, 'points': len(path), 'target': target}
        finally:
            try:
                if pressed:
                    uilib._OnMouseUp(button, *uilib.cursorPos)
            finally:
                uilib.cursorPos, uilib.x, uilib.y = before
                attempt(uilib.UpdateMouseOver)
                self.pointer_busy = False

    # The scroll containers a node sits in, innermost first.
    def scroll_containers(self, chain):
        return [above for above in reversed(chain)
                if callable(getattr(above, 'ScrollToVerticalPixels', None)) and getattr(above, 'clipCont', None) is not None]

    # How far, in UI units, a scroll container has to move for the node to be seen: (across, down).
    # A node that fits is brought just inside the edge it is past; a taller one is left once any
    # of it shows.
    def scroll_offsets(self, node, container):
        left, top, width, height = attempt(lambda: node.GetAbsolute()) or (0, 0, 0, 0)
        c_left, c_top, c_width, c_height = attempt(lambda: container.clipCont.GetAbsolute()) or (0, 0, 0, 0)
        if not (width or height) or not (c_width and c_height):
            return 0, 0

        def distance(start, size, c_start, c_size):
            end, c_end = start + size, c_start + c_size
            if size <= c_size:
                return start - c_start if start < c_start else end - c_end if end > c_end else 0
            return start - c_start if end <= c_start or start >= c_end else 0

        across = distance(left, width, c_left, c_width) if attempt(container.IsHorizontalScrollBarVisible) else 0
        down = distance(top, height, c_top, c_height) if attempt(container.IsVerticalScrollBarVisible) else 0
        return across, down

    # Whether the node is outside what its scroll containers show.
    def scrolled_out(self, node, chain):
        return any(any(self.scroll_offsets(node, container)) for container in self.scroll_containers(chain))

    # Scrolls each container the node sits in, with the client's own call, until the node shows in
    # it. Answers whether anything moved; raises if the node still isn't in view.
    def scroll_into_view(self, node, chain, path):
        moved = False
        for container in self.scroll_containers(chain):
            across, down = self.scroll_offsets(node, container)
            if down:
                container.ScrollToVerticalPixels(container.GetPositionVerticalPixels() + down)
            if across:
                container.ScrollToHorizontalPixels(container.GetPositionHorizontalPixels() + across)
            if across or down:
                moved = True
                if any(self.scroll_offsets(node, container)):
                    raise ValueError('%s is outside the visible part of its scroll container and scrolling did not bring it in' % path)
        return moved

    # The node, and the nearest node from it up that takes a click; whether a scroll container
    # holds the node out of view (click scrolls it in first).
    def op_find(self, args):
        node, here, chain = self.locate(args, 'OnClick')
        clicked, clicked_path, passed = clickable(node, here, chain, 'OnClick')
        found = self.described(node, here)
        found['scrolledOut'] = self.scrolled_out(node, chain)
        return {'node': found,
                'target': self.described(clicked, clicked_path) if clicked is not None else None,
                'passedOver': passed}

    # args: the node (as locate), double. Scrolls the node into view, then calls the click handler
    # of the node or its nearest ancestor that has one and takes mouse input (a label doesn't:
    # the click goes through it): Button.press() for a button, which checks it is enabled, else
    # OnClick (OnDblClick with double).
    def op_click(self, args):
        handler = 'OnDblClick' if args.get('double') else 'OnClick'
        node, here, chain = self.locate(args, handler)
        target, target_path, passed = clickable(node, here, chain, handler)
        if target is None:
            raise refuse('neither %s nor a node above it has %s%s' % (
                here, handler, ' that takes mouse input (passed over, as a click goes through them: %s)' % ', '.join(passed) if passed else ''))
        if attempt(lambda: target.IsEnabled()) is False or getattr(target, 'enabled', True) is False:
            raise ValueError('%s is disabled' % target_path)
        scrolled = self.scroll_into_view(node, chain, here)
        press = getattr(target, 'press', None)
        if handler == 'OnClick' and callable(press):
            value = self.settle(press, args, 'click %s' % target_path)
        else:
            value = self.settle(lambda: call_handler(target, handler), args, 'click %s' % target_path)
        value['clicked'] = self.described(target, target_path)
        value['scrolled'] = scrolled
        return value

    # args: the node (as locate) or itemID, entries: [label, ...], wait. Opens the context menu
    # as a right click does (ShowMenu on the node, or on the nearest node above it with a GetMenu;
    # or, for a space item, the menu service's CelestialMenu), then takes each entry by its label
    # (exact, else contains, case-insensitive), going down a submenu for each but the last, and
    # runs the last as a click on it would. A label that isn't there lists the ones that are.
    def op_menu(self, args):
        wanted = args.get('entries')
        if not isinstance(wanted, list) or not wanted or not all(isinstance(each, TEXT) and each.strip() for each in wanted):
            raise refuse('entries: the labels to pick, outermost first, e.g. ["Expel Member", "Confirm Expel Member"]')
        from carbonui.control.contextMenu.menuUtil import CloseContextMenus
        if args.get('itemID') is not None:
            item = args.get('itemID')
            if isinstance(item, bool) or not (isinstance(item, INTS) or (isinstance(item, TEXT) and item.isdigit())):
                raise refuse('itemID: a number')
            source = 'item %s' % (item,)
            data = self.item_menu(int(item))
        else:
            node, here, chain = self.locate(args)
            holder = None
            parts = here.split('/')
            for depth, above in enumerate(reversed(chain + (node,))):
                if getattr(above, 'GetMenu', None):
                    holder, source = above, '/'.join(parts[:len(parts) - depth])
                    break
            if holder is None:
                raise refuse('neither %s nor a node above it has a context menu (GetMenu)' % here)
            CloseContextMenus()
            data = self.node_menu(holder)
        try:
            picked = []
            run = None
            for index, label in enumerate(wanted):
                last = index == len(wanted) - 1
                entry = self.pick_entry(data, label, picked)
                picked.append(menu_text(entry))
                if not last:
                    if not entry.HasSubMenuData():
                        raise refuse('%s has no submenu; it runs something, so it is the last entry' % ' > '.join(picked))
                    if not entry.IsEnabled():
                        raise refuse('%s is disabled%s' % (' > '.join(picked), disabled_hint(entry)))
                    data = entry.GetSubMenuData()
                    if not data or not data.GetEntries():
                        raise refuse('%s opened no submenu' % ' > '.join(picked))
                    continue
                if not entry.IsEnabled():
                    raise refuse('%s is disabled%s' % (' > '.join(picked), disabled_hint(entry)))
                if not entry.HasFunction():
                    raise refuse('%s %s' % (' > '.join(picked), 'opens a submenu: name an entry in it' if entry.HasSubMenuData()
                                                else 'does nothing when clicked (a caption or a label)'))
                run = entry.ExecuteFunction
            value = self.settle(run, args, 'menu %s > %s' % (source, ' > '.join(picked)))
        finally:
            attempt(CloseContextMenus)
        value['picked'] = picked
        value['menu'] = source
        return value

    def item_menu(self, item):
        from carbonui.control.contextMenu.menuDataFactory import CreateMenuDataFromRawTuples
        raw = self.sm.GetService('menu').CelestialMenu(item)
        data = CreateMenuDataFromRawTuples(raw)
        if not data or not data.GetEntries():
            raise refuse('item %s has no menu in the client (is it in the ballpark? client_ballpark lists them)' % item)
        return data

    def node_menu(self, holder):
        from carbonui.control.contextMenu.contextMenu import ShowMenu
        ShowMenu(holder)
        view = attempt(lambda: holder.menuObject_weakref())
        if view is None or attempt(lambda: view.destroyed, True) or getattr(view, 'menuData', None) is None:
            raise refuse('the menu did not open: it has no entries, or the client blocks menus right now')
        return view.menuData

    # The entry of data that label names; the labels there are in the error for none or several.
    def pick_entry(self, data, label, picked):
        entries = [entry for entry in data.GetEntries() if entry is not None]
        wanted = lower(plain_text(label))
        if not wanted:
            raise refuse('entry %r has no text to look for' % (label,))
        rows = [(entry, lower(menu_text(entry)) or '') for entry in entries]
        found = [entry for entry, text in rows if text == wanted] or [entry for entry, text in rows if wanted in text]
        if len(found) == 1:
            return found[0]
        listed = ', '.join('"%s"%s%s' % (menu_text(entry), ' >' if entry.HasSubMenuData() else '',
                                         '' if entry.IsEnabled() else ' (off)') for entry in entries)
        where = ' in %s' % ' > '.join(picked) if picked else ''
        raise refuse('%s entry "%s"%s; the entries are: %s' % ('no' if not found else '%d entries match' % len(found),
                                                                  label, where, listed or '(none)'))

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
