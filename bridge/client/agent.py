# Gridcheck client agent. Runs inside the EVE client (Python 2.7); bootstrap.py
# fetches it from the bridge (bridge/client.js) once the login completes.
#
# The bridge sends each command as an OnGridcheckClient notification carrying
# {"id", "op", "args"}. Each runs on its own tasklet and answers with
# gridcheckClient.Reply(token, {"id", "ok", "value" | "error"}). A command that
# loops without yielding stalls the client, as any client code would.
import json
import os
import traceback

import blue
import uthread

try:
    import __builtin__ as builtins
except ImportError:
    import builtins

VERSION = 1
REPR_LIMIT = 20000
SESSION_KEYS = ('userid', 'charid', 'corpid', 'allianceid', 'solarsystemid2', 'solarsystemid',
                'stationid', 'structureid', 'shipid', 'locationid', 'role')

try:
    SCALARS = (int, long, float, basestring, bool)
except NameError:
    SCALARS = (int, float, str, bool)


def scalar(value):
    if value is None or isinstance(value, SCALARS):
        return value
    return repr(value)


def jsonable(value):
    try:
        json.dumps(value)
        return True
    except Exception:
        return False


def session_snapshot(session):
    return dict((key, scalar(getattr(session, key, None))) for key in SESSION_KEYS)


def client_build():
    try:
        import boot
        return scalar(getattr(boot, 'build', None))
    except Exception:
        return None


class Agent(object):
    __notifyevents__ = ['OnGridcheckClient']

    def __init__(self, sm, token):
        self.sm = sm
        self.token = token
        self.active = True
        self.namespace = {'__builtins__': builtins, '__name__': 'gridcheck_eval'}

    def start(self):
        self.sm.RegisterForNotifyEvent(self, 'OnGridcheckClient')
        return self

    def dispose(self):
        self.active = False
        try:
            self.sm.UnregisterForNotifyEvent(self, 'OnGridcheckClient')
        except Exception:
            pass

    def OnGridcheckClient(self, payload=None, *args):
        if self.active:
            uthread.new(self.run, payload)

    def run(self, payload):
        command_id = None
        try:
            command = json.loads(payload)
            command_id = command.get('id')
            handler = getattr(self, 'op_' + str(command.get('op')), None)
            if handler is None:
                raise ValueError('unknown op: %s' % command.get('op'))
            reply = {'ok': True, 'value': handler(command.get('args') or {})}
        except Exception:
            reply = {'ok': False, 'error': traceback.format_exc()}
        reply['id'] = command_id
        try:
            self.sm.RemoteSvc('gridcheckClient').Reply(self.token, json.dumps(reply, default=repr))
        except Exception as error:
            print('GRIDCHECK_CLIENT:REPLY_FAILED %r' % (error,))

    def op_ping(self, args):
        return {
            'agent': VERSION,
            'build': client_build(),
            'pid': os.getpid(),
            'wallclock': scalar(blue.os.GetWallclockTime()),
            'session': session_snapshot(getattr(builtins, 'session', None)),
        }

    # args: {"code": "..."}. An expression answers its value; statements answer
    # whatever they leave in `result`. Names persist between calls; sm, session,
    # uicore and agent are always current.
    def op_eval(self, args):
        code = str(args.get('code') or '')
        namespace = self.namespace
        namespace['sm'] = self.sm
        namespace['session'] = getattr(builtins, 'session', None)
        namespace['uicore'] = getattr(builtins, 'uicore', None) or self.uicore()
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
        return {
            'repr': text[:REPR_LIMIT],
            'truncated': len(text) > REPR_LIMIT,
            'json': value if jsonable(value) else None,
        }

    def uicore(self):
        try:
            from carbonui.uicore import uicore
            return uicore
        except Exception:
            return None


def install(sm, token):
    return Agent(sm, token).start()
