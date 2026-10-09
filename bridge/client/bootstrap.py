# Gridcheck client agent bootstrap. bridge/client.js adds it to the expression
# the EVE client runs at login, after a line setting _gc_token; _gc_context is
# the globals of that expression. Python 2.7, the client's interpreter.
#
# Once the login completes it fetches agent.py with gridcheckClient.Attach
# and installs it. Lines starting GRIDCHECK_CLIENT: go to the client's log.
try:
    import blue as _gc_blue
    import uthread as _gc_uthread
    try:
        import __builtin__ as _gc_builtins
    except ImportError:
        import builtins as _gc_builtins

    _gc_key = '_gridcheck_client_agent_v1'

    def _gc_lookup(name):
        value = _gc_context.get(name) if isinstance(_gc_context, dict) else None
        if value is None:
            value = getattr(_gc_builtins, name, None)
        return value

    def _gc_attach():
        failures = 0
        for attempt in range(240):
            _gc_blue.pyos.synchro.SleepWallclock(500)
            sm = _gc_lookup('sm')
            session = _gc_lookup('session')
            if sm is None or session is None or not getattr(session, 'userid', None):
                continue
            try:
                source = sm.RemoteSvc('gridcheckClient').Attach(_gc_token)
            except Exception as error:
                failures += 1
                if failures in (1, 10, 100):
                    print('GRIDCHECK_CLIENT:ATTACH_RETRY %r' % (error,))
                continue
            if not source:
                print('GRIDCHECK_CLIENT:ATTACH_REFUSED')
                return
            if not isinstance(source, str):
                source = source.encode('utf-8')
            namespace = {'__builtins__': _gc_builtins, '__name__': 'gridcheck_client_agent'}
            eval(compile(source, '<gridcheck-client-agent>', 'exec'), namespace)
            previous = getattr(_gc_builtins, _gc_key, None)
            if previous is not None:
                try:
                    previous.dispose()
                except Exception:
                    pass
            setattr(_gc_builtins, _gc_key, namespace['install'](sm, _gc_token))
            print('GRIDCHECK_CLIENT:READY')
            return
        print('GRIDCHECK_CLIENT:GAVE_UP')

    _gc_uthread.new(_gc_attach)
except Exception as _gc_error:
    print('GRIDCHECK_CLIENT:FAILED %r' % (_gc_error,))
