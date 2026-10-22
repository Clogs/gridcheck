"use strict";

// client wait: evaluate a Python expression in the client again and again until
// its value is true in Python's sense, or the time is up. The polling lives
// here, not in the agent, so the agent's tasklet is free between tries.

const MOST_SECONDS = 3600;

// evaluate() -> the agent's eval answer { repr, json, truth, error? }; it may throw (the client
// was busy or gone), which counts as a try that didn't pass, except for an error whose text
// matches fatal.
// -> { ok, tries, elapsedMs, last (the last answer), error (the last error, or null) }
async function waitForClient({ evaluate, seconds = 60, everySeconds = 0.5, now = Date.now, sleep, fatal = /no client agent|client agents are online|has no client agent|SyntaxError/ }) {
  if (!(seconds >= 0 && seconds <= MOST_SECONDS)) throw new Error(`--timeout takes seconds from 0 through ${MOST_SECONDS}`);
  if (!(everySeconds >= 0.05 && everySeconds <= 60)) throw new Error("--every takes seconds from 0.05 through 60");
  const startedAtMs = now();
  const deadlineMs = startedAtMs + seconds * 1000;
  let tries = 0;
  let last = null;
  let error = null;
  for (;;) {
    tries += 1;
    try {
      last = await evaluate();
      error = last && last.error ? last.error : null;
      if (last && last.truth === true) return { ok: true, tries, elapsedMs: now() - startedAtMs, last, error: null };
    } catch (failure) {
      if (fatal.test(failure.message)) throw failure;
      error = failure.message;
    }
    if (now() + everySeconds * 1000 > deadlineMs) break;
    await sleep(everySeconds * 1000);
  }
  return { ok: false, tries, elapsedMs: now() - startedAtMs, last, error };
}

module.exports = { MOST_SECONDS, waitForClient };
