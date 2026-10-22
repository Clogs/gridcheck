"use strict";

// bridge/client/agent.py's ops for finding, clicking, menus, messages, eval truth
// and rpc, run by Python 3 against a stub client. The stub is what the agent's
// header says it reads; whether the real client does the same is checked live.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PYTHON = ["python3", "python"].find((name) => spawnSync(name, ["-c", "import sys; assert sys.version_info >= (3,)"]).status === 0);
const AGENT = fs.readFileSync(path.join(__dirname, "..", "bridge", "client", "agent.py"), "utf8");

const HARNESS = String.raw`
import builtins, json, sys, types

def module(name, **attrs):
    mod = types.ModuleType(name)
    mod.__dict__.update(attrs)
    parts = name.split('.')
    sys.modules[name] = mod
    child = mod
    for n in range(len(parts) - 1, 0, -1):
        package_name = '.'.join(parts[:n])
        package = sys.modules.get(package_name)
        if package is None:
            package = types.ModuleType(package_name)
            package.__path__ = []
            sys.modules[package_name] = package
        setattr(package, parts[n], child)
        child = package
    return mod

clock = [0]
def sleep_wallclock(ms):
    clock[0] += ms
frames = []
module('blue', pyos=types.SimpleNamespace(synchro=types.SimpleNamespace(SleepWallclock=sleep_wallclock, Yield=lambda: frames.append(1))),
       os=types.SimpleNamespace(GetWallclockTime=lambda: 1, GetSimTime=lambda: clock[0] * 10000))
module('uthread', new=lambda fn, *args: fn(*args))
module('eveprefs', boot=types.SimpleNamespace(build=3396210))
logmodule = module('logmodule', _LogException=lambda *a, **k: None)

class Tasklet(object):
    pass
current = [Tasklet()]
module('stackless', getcurrent=lambda: current[0])

# What the client shows the player.
shown = []
class QuickMessage(object):
    @classmethod
    def show_message(cls, text, flash_existing=True):
        shown.append(['quick', text])
class Logger(object):
    def SayMessage(self, text, msgType, icons=None, icon_color=None):
        shown.append(['say', text, msgType])
module('carbonui.control.message', QuickMessage=QuickMessage)
module('eve.client.script.ui.shared.uilog', Logger=Logger)
MESSAGES = {
    'CustomNotify': types.SimpleNamespace(text='<b>%(notify)s</b>', type='notify'),
    'NoBelt': types.SimpleNamespace(text='That system has no asteroid belt', type='error'),
}
class Cfg(object):
    def GetMessage(self, key, dict=None, onNotFound='return', onDictMissing='error'):
        if key not in MESSAGES:
            return None
        msg = MESSAGES[key]
        return types.SimpleNamespace(text=msg.text % (dict or {}) if '%(' in msg.text else msg.text, type=msg.type)
builtins.cfg = Cfg()
def fsd_dialog(dialog_key, params=None, *args, **kwargs):
    data = builtins.cfg.GetMessage(dialog_key, params)
    if data.type == 'notify':
        QuickMessage.show_message(data.text)
    else:
        shown.append(['dialog', data.text])
dialog_handler = module('player_messaging.client.dialog_handler', _handle_player_fsd_dialog=fsd_dialog)

# Menus.
class Entry(object):
    def __init__(self, text, func=None, sub=None, enabled=True):
        self.text, self.func, self.sub, self.enabled = text, func, sub, enabled
    def GetText(self): return self.text
    def IsEnabled(self): return self.enabled
    def GetDisabledHint(self): return 'not now' if not self.enabled else None
    def HasFunction(self): return self.func is not None
    def ExecuteFunction(self): self.func()
    def HasSubMenuData(self): return self.sub is not None
    def GetSubMenuData(self): return self.sub
class Data(object):
    def __init__(self, *entries): self.entries = list(entries)
    def GetEntries(self): return self.entries
did = []
def confirm():
    did.append('confirmed')
    QuickMessage.show_message('Member expelled')
expel = Entry('Expel Member', sub=Data(Entry('Confirm Expel Member', confirm), Entry('Cancel')))
def build_menu():
    return Data(Entry('Show Info', lambda: did.append('info')), None, expel, Entry('Kick', lambda: did.append('kick')), Entry('Locked', lambda: None, enabled=False),
                Entry('Kick Everyone', lambda: did.append('everyone')))
closed = []
def close_context_menus():
    closed.append(1)
module('carbonui.control.contextMenu.menuUtil', CloseContextMenus=close_context_menus)
def show_menu(holder, aux=None):
    view = types.SimpleNamespace(destroyed=False, menuData=holder.GetMenu())
    holder.menuObject_weakref = lambda: view
module('carbonui.control.contextMenu.contextMenu', ShowMenu=show_menu)
module('carbonui.control.contextMenu.menuDataFactory', CreateMenuDataFromRawTuples=lambda raw: Data(*raw) if raw else None)

# The UI.
class Node(object):
    def __init__(self, name, children=(), text=None, display=True, state=0, rect=(0, 0, 40, 20)):
        self.name, self.children, self.display, self.state, self.rect = name, list(children), display, state, rect
        if text is not None:
            self.text = text
    def GetAbsolute(self):
        return self.rect if self.display else (0, 0, 0, 0)
    def IsEnabled(self):
        return self.state == 0
class Label(Node):
    def OnClick(self, *args):
        did.append(['label click'])
class Button(Node):
    disabled = False
    def __init__(self, name, text, **kw):
        Node.__init__(self, name, text=text, **kw)
    def IsEnabled(self):
        return not self.disabled
    def OnClick(self, *args):
        self.press()
    def press(self):
        did.append(['press', self.text])
        if self.text == 'Draft':
            QuickMessage.show_message('That system has no asteroid belt')
class FancyButton(Node):
    def OnClick(self, *args):
        did.append(['fancy', self.name])
class Tab(Node):
    def OnClick(self, *args):
        did.append(['tab', self.name])
class RightClickable(Node):
    def GetMenu(self):
        return build_menu()

class Scroll(Node):
    def __init__(self, name, items):
        self.offset = 0
        self.clipCont = Node('clipCont', rect=(0, 0, 100, 100))
        Node.__init__(self, name, children=items, rect=(0, 0, 100, 100))
        for item in items:
            item.base = item.rect[1]
            item.scroll = self
            item.GetAbsolute = (lambda i: lambda: (i.rect[0], i.base - i.scroll.offset, i.rect[2], i.rect[3]))(item)
    def IsVerticalScrollBarVisible(self): return True
    def IsHorizontalScrollBarVisible(self): return False
    def GetPositionVerticalPixels(self): return self.offset
    def ScrollToVerticalPixels(self, position):
        self.offset = max(0, min(100, position))
        did.append(['scrolled', self.offset])
far = Button('Button', 'Far button', rect=(0, 160, 40, 20))
near = Button('Button', 'Near button', rect=(0, 10, 40, 20))
scroll = Scroll('scroller', [near, far])
tabs = Node('tabs', [Tab('tabFrame', [Label('EveLabelMedium', text='Roster', state=1)]), Tab('other', [Label('EveLabelMedium', text='Other', state=1)])])
issue = FancyButton('issueBtn', [Node('wrapper', [Label('EveLabelMedium', text='<b>Issue</b> corp', state=1)])])
disabled = Button('Button', 'Disabled one', rect=(0, 300, 40, 20))
disabled.disabled = True
row = RightClickable('memberRow', [Label('name', text='Some Member', state=1)])
sizes = Node('sizes', [Button('Button', 'Draft', display=False), Button('Button', '1d'), Button('Button', 'Hauler'),
                       Button('Button', 'Hauler 2'), Button('Lonely', 'Solo')])
main = Node('Container', [tabs, issue, sizes, scroll, disabled, row])
# Two windows, each with a search box; the console's labels carry markup, and its Members header takes no click.
class Window(Node):
    def __init__(self, name, windowID, caption, children, rect):
        Node.__init__(self, name, children, rect=rect)
        self.windowID, self.caption = windowID, caption
class SingleLineEditText(Node):
    pass
class Clickable(Node):
    def OnClick(self, *args):
        did.append(['clickable', self.name])
console = Window('LuCorpConsole', 'LuCorpConsole', 'Corp Console', [
    SingleLineEditText('amount', rect=(110, 120, 80, 20)),
    Clickable('pct', [Label('EveLabelSmall', text='<color=0xff00ff00>75</color>&nbsp;%', state=1)]),
    Clickable('optionalBox', [Label('EveLabelSmall', text='Optional', state=1)]),
    Node('header', text='Members'),
    Tab('membersTab', [Label('EveLabelMedium', text='Members', state=1)]),
], rect=(100, 100, 1180, 760))
info = Window('InfoPanel', 'infoPanel', 'Info', [SingleLineEditText('search')], rect=(0, 0, 200, 300))
desktop = Node('Desktop', [main, console, info])
desktop.width, desktop.height = 1280, 720
class Registry(object):
    def GetWindows(self): return [console, info]
    def GetModalWindow(self): return None
    def GetFocus(self): return None
registry = Registry()
builtins.uicore = types.SimpleNamespace(desktop=desktop, registry=registry)

class Lu(object):
    def Echo(self, text):
        did.append(['echo', text])
        return json.dumps({'got': json.loads(text)})
    def Plain(self, a, b):
        return [a, b, 3]
    def Refuse(self, text):
        class UserError(Exception):
            msg = 'NoBelt'
            dict = {}
        raise UserError('x')
    def Boom(self):
        raise KeyError('nope')
replies, hellos, batches = [], [], []
class Remote(object):
    def Reply(self, token, text): replies.append(json.loads(text))
    def Hello(self, token, text): hellos.append(json.loads(text))
    def Events(self, token, text): batches.append(json.loads(text))
class CelestialMenus(object):
    def CelestialMenu(self, item):
        return [Entry('Warp to Within 0 m', lambda: did.append(['warp', item]))] if item == 40001 else []
class SM(object):
    listeners = {}
    def RemoteSvc(self, name):
        return Remote() if name == 'gridcheckClient' else Lu()
    def GetService(self, name):
        return CelestialMenus()
    def RegisterForNotifyEvent(self, owner, event): self.listeners.setdefault(event, []).append(owner)
    def UnregisterForNotifyEvent(self, owner, event): self.listeners[event].remove(owner)
builtins.sm = SM()
builtins.session = types.SimpleNamespace(userid=7, charid=9)

namespace = {'__name__': 'agent'}
exec(compile(AGENT_SOURCE, 'agent.py', 'exec'), namespace)
agent = namespace['install'](builtins.sm, 'tok')
ids = [0]
def op(opname, **args):
    ids[0] += 1
    before = len(replies)
    agent.OnGridcheckClient(json.dumps({'id': ids[0], 'op': opname, 'args': args}))
    reply = replies[-1]
    assert reply['id'] == ids[0] and len(replies) == before + 1
    return reply
def err(reply):
    assert not reply['ok'], reply
    return reply['error'].strip()

out = {}
# Unique paths.
ui = op('ui', text='hauler')['value']
out['hauler'] = [m['path'] for m in ui['matches']]
out['solo'] = [m['path'] for m in op('ui', text='solo')['value']['matches']]
out['issue'] = [[m['path'], m['cls'], m['text']] for m in op('ui', text='issue')['value']['matches']]
out['issueByTag'] = [m['path'] for m in op('ui', text='issue corp')['value']['matches']]
out['issueNode'] = op('find', text='issue')['value']['node']['path']
out['hiddenSiblingCounts'] = [m['path'] for m in op('ui', text='draft', hidden=True)['value']['matches']]
out['findIndexed'] = op('find', path='/Desktop/Container/sizes/Button[2]')['value']['node']['text']
out['findBare'] = err(op('find', path='/Desktop/Container/sizes/Button'))
out['findAnd'] = op('find', path='/Desktop/Container/sizes/Button', text='hauler 2')['value']['node']['text']
out['findAndMiss'] = err(op('find', path='/Desktop/Container/sizes/Button[0]', text='hauler'))
out['findUnsuffixedUnique'] = op('find', path='/Desktop/Container/sizes/Lonely')['value']['node']['text']
out['clsName'] = err(op('find', cls='Button', name='Button', text='nothing like it'))
# A click goes through a label.
clicked = op('click', text='Roster')['value']
out['rosterClick'] = [clicked['clicked']['path'], clicked['clicked']['cls']]
out['findRoster'] = op('find', text='Roster')['value']['target']['path']
found = op('click', text='issue')['value']
out['issueClick'] = [found['clicked']['path'], found['clicked']['cls']]
out['disabledClick'] = err(op('click', text='Disabled one'))
out['labelOnly'] = op('find', text='Other')['value']['passedOver']
# Scrolling.
out['findFar'] = op('find', text='Far button')['value']['node']['scrolledOut']
out['findNear'] = op('find', text='Near button')['value']['node']['scrolledOut']
did[:] = []
far_click = op('click', text='Far button')['value']
out['farClick'] = [far_click['scrolled'], scroll.offset, list(did)]
out['nearClick'] = op('click', text='Near button')['value']['scrolled']
# Messages: the click's own reply carries them.
did[:] = []
shown[:] = []
draft = op('click', path='/Desktop/Container/sizes/Button[0]', hidden=True)['value']
out['draftMessages'] = draft['messages']
# Menus.
did[:] = []
menu = op('menu', text='Some Member', entries=['expel', 'confirm'])['value']
out['menu'] = [menu['picked'], menu['menu'], menu['finished'], menu['messages'], list(did), len(closed) > 0]
out['menuExact'] = op('menu', text='Some Member', entries=['Kick'])['value']['picked']
out['menuContains'] = err(op('menu', text='Some Member', entries=['kic']))
out['menuMissing'] = err(op('menu', text='Some Member', entries=['Nope']))
out['menuNoSub'] = err(op('menu', text='Some Member', entries=['Show Info', 'x']))
out['menuDisabled'] = err(op('menu', text='Some Member', entries=['Locked']))
out['menuSubMissing'] = err(op('menu', text='Some Member', entries=['Expel Member', 'Nope']))
out['menuSubmenuLast'] = err(op('menu', text='Some Member', entries=['Expel Member']))
out['menuNoMenu'] = err(op('menu', text='Solo', entries=['x']))
did[:] = []
out['menuItem'] = [op('menu', itemID=40001, entries=['warp to'])['value']['picked'], list(did)]
out['menuItemNone'] = err(op('menu', itemID=5, entries=['x']))
out['menuEntries'] = err(op('menu', text='Some Member', entries=[]))
# Messages recorded by the hooks.
shown[:] = []
fsd = sys.modules['player_messaging.client.dialog_handler']._handle_player_fsd_dialog
fsd('CustomNotify', {'notify': 'Hello there'})
fsd('NoBelt')
QuickMessage.show_message('direct <br>notice', flash_existing=False)
Logger().SayMessage('Mined <b>5</b> units', 'mining')
events = op('events', since=0)['value']
out['messages'] = [[e['key'], e['text'], e.get('type')] for e in events['events'] if e['kind'] == 'message'][-4:]
out['messagesHooked'] = events['events'] is not None and op('ping')['value']['events']['messages']
out['shown'] = shown
# Unhooked when the agent is disposed.
def count(kind):
    return sum(1 for e in agent.events.ring if e['kind'] == kind)
recorded = count('message')
agent.dispose()
shown[:] = []
QuickMessage.show_message('after')
out['afterDispose'] = [shown, count('message') - recorded]
agent.active = True
# eval truth.
agent.events.start(('OnSessionChanged',))
out['truth'] = [op('eval', code=code, truth=True)['value']['truth'] for code in ('[]', '[0]', '0', 'None', "''", "'a'", '{}', '1 == 1')]
soft = op('eval', code='undefined_name', truth=True, soft=True)['value']
out['soft'] = [soft['truth'], soft['error']]
out['hard'] = err(op('eval', code='undefined_name', truth=True))
out['syntax'] = err(op('eval', code='1 +', truth=True, soft=True))
out['noTruth'] = 'truth' in op('eval', code='1')['value']
# rpc.
did[:] = []
errors_before = count('agent-error')
out['rpcPayload'] = [op('rpc', service='luCommand', method='Echo', payload={'a': [1, 'b']})['value']['json'], list(did)]
out['rpcArgs'] = op('rpc', service='luCommand', method='Plain', args=[1, 'two'])['value']['json']
out['rpcRefused'] = err(op('rpc', service='luCommand', method='Refuse', payload={}))
out['rpcBoom'] = err(op('rpc', service='luCommand', method='Boom'))
out['rpcBadName'] = err(op('rpc', service='luCommand', method='__class__'))
out['rpcMissing'] = err(op('rpc', service='luCommand', method='Missing'))
out['rpcBoth'] = err(op('rpc', service='luCommand', method='Plain', payload={}, args=[]))
out['rpcErrorEvents'] = count('agent-error') - errors_before
out['pingUi'] = op('ping')['value']['ui']
# Windows scope the finders.
out['editBoth'] = err(op('find', cls='SingleLineEditText'))
out['editInConsole'] = op('find', cls='SingleLineEditText', window='LuCorpConsole')['value']['node']['path']
out['editByCaption'] = op('find', cls='SingleLineEditText', window='info')['value']['node']['path']
out['windowMissing'] = err(op('find', cls='SingleLineEditText', window='Nope'))
out['uiInWindow'] = [m['path'] for m in op('ui', text='members', window='corp console')['value']['matches']]
out['uiWindowTree'] = op('ui', window='infoPanel', depth=1)['value']['tree']['kids'][0]['name']
# Clicks: markup and entities stripped, class on the target, a header with no handler skipped, a target's path.
did[:] = []
out['pctClick'] = op('click', text='75%')['value']['clicked']['path']
out['optionalClick'] = op('click', text='Optional', cls='Clickable')['value']['clicked']['path']
out['membersClick'] = op('click', text='Members', window='LuCorpConsole')['value']['clicked']['path']
out['membersFind'] = op('find', text='Members', window='LuCorpConsole')['value']['target']['path']
out['membersTargetPath'] = op('click', path='/Desktop/LuCorpConsole/membersTab', text='Members')['value']['clicked']['path']
out['clickDid'] = list(did)
out['membersUi'] = len(op('ui', text='Members', window='LuCorpConsole')['value']['matches'])
# eval vars.
out['vars'] = op('eval', code='page * 2', vars={'page': 21})['value']['json']
out['varsKept'] = op('eval', code='page')['value']['json']
out['varsReserved'] = err(op('eval', code='1', vars={'sm': 1}))
# inspect.
class Container(object):
    default_align = 'toTop'
    default_state = 0
    def SetSize(self, width, height): pass
class Slider(Container):
    default_value = 0.5
    def SetValue(self, value, animate=True): pass
    @property
    def value(self): return 1
    @staticmethod
    def Make(*args, **kwargs): pass
module('carbonui.control.slider', Slider=Slider)
module('carbonui.control.reexport', Slider=Slider)
found = op('inspect', cls='Slider', module='carbonui')['value']
out['inspect'] = found['matches'][0] if found['count'] == 1 else found
out['inspectLoose'] = op('inspect', cls='slider', module='carbonui.control')['value']['count']
out['inspectNone'] = op('inspect', cls='NoSuchClass', module='carbonui')['value']['count']
out['inspectInherited'] = op('inspect', cls='Slider', module='carbonui.control.slider', inherited=True)['value']['matches'][0]['inherited']
# area: fresh frames, and a rect to crop to.
frames[:] = []
area = op('area', fresh=True, window='LuCorpConsole')['value']
out['area'] = [area['rect'], area['ui'], len(frames)]
out['areaPath'] = op('area', path='/Desktop/InfoPanel')['value']['rect']
out['areaBoth'] = err(op('area', path='/Desktop/InfoPanel', window='info'))
print(json.dumps(out))
`;

function run() {
  const script = path.join(os.tmpdir(), `gridcheck-agent-py-${process.pid}.py`);
  fs.writeFileSync(script, `AGENT_SOURCE = ${JSON.stringify(AGENT)}\n${HARNESS}`);
  const result = spawnSync(PYTHON, [script], { encoding: "utf8" });
  fs.rmSync(script, { force: true });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  const lines = result.stdout.trim().split(/\r?\n/);
  return JSON.parse(lines[lines.length - 1]);
}

test("the agent's finding, clicking, menus, messages, eval truth and rpc (Python 3, stub client)", { skip: !PYTHON && "no Python 3" }, () => {
  const out = run();
  const sizes = "/Desktop/Container/sizes";
  // Paths: siblings that share a label get [n]; a lone one doesn't.
  assert.deepEqual(out.hauler, [`${sizes}/Button[2]`, `${sizes}/Button[3]`]);
  assert.deepEqual(out.solo, [`${sizes}/Lonely`]);
  assert.deepEqual(out.hiddenSiblingCounts, [`${sizes}/Button[0]`], "a hidden sibling counts, so a path doesn't move when it shows");
  assert.equal(out.findIndexed, "Hauler");
  assert.match(out.findBare, /3 nodes match; pass index or path/);
  assert.equal(out.findAnd, "Hauler 2", "path and text together");
  assert.match(out.findAndMiss, /no displayed node matches/);
  assert.equal(out.findUnsuffixedUnique, "Solo", "a segment without [n] still matches where it is unambiguous");
  assert.match(out.clsName, /no displayed node matches/);
  // A button is found by its label, a button without text of its own included.
  assert.deepEqual(out.issue[0], ["/Desktop/Container/issueBtn", "FancyButton", "<b>Issue</b> corp"]);
  assert.equal(out.issue.length, 2, "ui lists the button and the label inside it");
  assert.equal(out.issueNode, "/Desktop/Container/issueBtn", "find takes the outermost match");
  assert.deepEqual(out.issueByTag[0], "/Desktop/Container/issueBtn", "the markup is not part of what is searched");
  // Clicks go through a label.
  assert.deepEqual(out.rosterClick, ["/Desktop/Container/tabs/tabFrame", "Tab"]);
  assert.equal(out.findRoster, "/Desktop/Container/tabs/tabFrame", "find and click agree");
  assert.deepEqual(out.issueClick, ["/Desktop/Container/issueBtn", "FancyButton"]);
  assert.match(out.disabledClick, /ValueError: \/Desktop\/Container\/Button is disabled$/, "the error names the disabled button, not a label");
  assert.deepEqual(out.labelOnly, ["/Desktop/Container/tabs/other/EveLabelMedium"], "find lists the label a click passes through");
  // Scrolling.
  assert.deepEqual([out.findFar, out.findNear], [true, false]);
  assert.deepEqual(out.farClick, [true, 80, [["scrolled", 80], ["press", "Far button"]]], "scrolled in, then pressed");
  assert.equal(out.nearClick, true, "the far button scrolled the near one out, so it scrolls back");
  assert.deepEqual(out.draftMessages, [{ key: null, text: "That system has no asteroid belt" }], "a click's reply carries what the player was told");
  // Menus.
  assert.deepEqual(out.menu, [["Expel Member", "Confirm Expel Member"], "/Desktop/Container/memberRow", true,
    [{ key: null, text: "Member expelled" }], ["confirmed"], true]);
  assert.deepEqual(out.menuExact, ["Kick"], "an exact label wins over one that contains it (Kick Everyone)");
  assert.match(out.menuContains, /2 entries match entry "kic"/);
  assert.match(out.menuMissing, /no entry "Nope"; the entries are: "Show Info", "Expel Member" >, "Kick", "Locked" \(off\), "Kick Everyone"/);
  assert.match(out.menuNoSub, /Show Info has no submenu/);
  assert.match(out.menuDisabled, /Locked is disabled \(not now\)/);
  assert.match(out.menuSubMissing, /no entry "Nope" in Expel Member; the entries are: "Confirm Expel Member", "Cancel"/);
  assert.match(out.menuSubmenuLast, /opens a submenu: name an entry in it/);
  assert.match(out.menuNoMenu, /has a context menu/);
  assert.deepEqual(out.menuItem, [["Warp to Within 0 m"], [["warp", 40001]]]);
  assert.match(out.menuItemNone, /item 5 has no menu/);
  assert.match(out.menuEntries, /entries: the labels to pick/);
  // Messages.
  assert.equal(out.messagesHooked, true);
  assert.deepEqual(out.messages, [
    ["CustomNotify", "Hello there", "notify"],
    ["NoBelt", "That system has no asteroid belt", "error"],
    [null, "direct notice", null],
    [null, "Mined 5 units", "mining"],
  ], "a keyed notice is recorded once, with its key; markup is gone");
  assert.deepEqual(out.afterDispose, [[["quick", "after"]], 0], "stop unhooks: the notice still shows, and isn't recorded");
  // eval.
  assert.deepEqual(out.truth, [false, true, false, false, false, true, false, true]);
  assert.deepEqual(out.soft, [false, "NameError: name 'undefined_name' is not defined"]);
  assert.match(out.hard, /NameError/);
  assert.match(out.syntax, /SyntaxError/, "a syntax error still fails when soft");
  assert.equal(out.noTruth, false, "truth only when asked for");
  // rpc.
  assert.deepEqual(out.rpcPayload, [{ got: { a: [1, "b"] } }, [["echo", '{"a": [1, "b"]}']]], "one JSON string in, the reply decoded");
  assert.deepEqual(out.rpcArgs, [1, "two", 3]);
  assert.match(out.rpcRefused, /luCommand\.Refuse was refused \(UserError NoBelt\): That system has no asteroid belt/);
  assert.match(out.rpcBoom, /luCommand\.Boom raised KeyError/);
  assert.match(out.rpcBadName, /method: a name of letters, digits and _/);
  assert.match(out.rpcMissing, /no method Missing|raised AttributeError|has no method/);
  assert.match(out.rpcBoth, /payload or args, not both/);
  assert.equal(out.rpcErrorEvents, 0, "a refused call is its caller's alone");
  assert.deepEqual(out.pingUi, [1280, 720]);
});

test("v11: windows scope the finders; clicks strip markup, match the click target, skip what takes no click; vars, inspect, area (Python 3, stub client)",
  { skip: !PYTHON && "no Python 3" }, () => {
    const out = run();
    const console_ = "/Desktop/LuCorpConsole";
    // Windows.
    assert.match(out.editBoth, /2 nodes match/, "two windows each have a search box");
    assert.equal(out.editInConsole, `${console_}/amount`);
    assert.equal(out.editByCaption, "/Desktop/InfoPanel/search", "a window by its caption, contains");
    assert.match(out.windowMissing, /no window "Nope"; the open windows are: LuCorpConsole \(Window\), infoPanel \(Window\)/);
    assert.deepEqual(out.uiInWindow, [`${console_}/header`, `${console_}/membersTab/EveLabelMedium`]);
    assert.equal(out.uiWindowTree, "search", "a window's tree starts at the window");
    // Clicks.
    assert.equal(out.pctClick, `${console_}/pct`, "\"75%\" finds \"<color>75</color>&nbsp;%\"");
    assert.equal(out.optionalClick, `${console_}/optionalBox`, "the class is the click target's, the text its label's");
    assert.equal(out.membersClick, `${console_}/membersTab`, "the header with no click handler is skipped");
    assert.equal(out.membersFind, `${console_}/membersTab`, "find and click agree");
    assert.equal(out.membersTargetPath, `${console_}/membersTab`, "find's target path with the text");
    assert.deepEqual(out.clickDid, [["clickable", "pct"], ["clickable", "optionalBox"], ["tab", "membersTab"], ["tab", "membersTab"]]);
    assert.equal(out.membersUi, 2, "ui still lists both");
    // eval vars.
    assert.equal(out.vars, 42);
    assert.equal(out.varsKept, 21, "a var stays in the namespace like any name");
    assert.match(out.varsReserved, /vars: sm is not a name eval can be given/);
    // inspect.
    const slider = out.inspect;
    assert.equal(slider.name, "Slider");
    assert.deepEqual(slider.importable, ["carbonui.control.reexport", "carbonui.control.slider"]);
    assert.deepEqual(slider.defaults.map((row) => [row.name, row.value, row.from]),
      [["default_align", "'toTop'", "Container"], ["default_state", "0", "Container"], ["default_value", "0.5", "Slider"]]);
    assert.deepEqual(slider.methods, ["Make(*args, **kwargs)", "SetValue(self, value, animate=True)"]);
    assert.deepEqual(slider.properties, ["value"]);
    assert.equal(Object.values(slider.inherited)[0], 1, "inherited methods are counted by class");
    assert.deepEqual(Object.values(out.inspectInherited)[0], ["SetSize"]);
    assert.equal(out.inspectLoose, 1, "a name in another case still finds it");
    assert.equal(out.inspectNone, 0);
    // area.
    assert.deepEqual(out.area, [[100, 100, 1180, 620], [1280, 720], 3], "cut to the desktop, after three frames");
    assert.deepEqual(out.areaPath, [0, 0, 200, 300]);
    assert.match(out.areaBoth, /a window or a path, not both/);
  });
