// A small controller shared by the sandboxed provider panel and its tests.
// No DOM, process, account credentials or network access is needed here.
(() => {
  function unpack(result) {
    const value = typeof result?.text === "string" ? JSON.parse(result.text)
      : typeof result === "string" ? JSON.parse(result) : result;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid monitor response");
    return value;
  }

  function createController({ call, render, schedule = setTimeout, cancel = clearTimeout, activeMs = 3000, idleMs = 15000 }) {
    let disposed = false, visible = true, starting = false, running = false, generation = 0, timer = null;
    let report = null, error = "", errorAction = "status", notice = "", refreshPromise = null;
    const paint = () => { if (!disposed) render({ report, starting, running, busy: starting || running, error, errorAction, notice }); };
    const stopTimer = () => { if (timer !== null) cancel(timer); timer = null; };
    const plan = () => {
      stopTimer();
      if (!disposed && visible) timer = schedule(() => { timer = null; refresh(); }, running || starting ? activeMs : idleMs);
    };
    async function refresh() {
      if (disposed || !visible) return;
      if (refreshPromise) return refreshPromise;
      const epoch = generation;
      const pending = (async () => {
        try {
          const next = unpack(await call("codex_route_status", {}));
          if (disposed || epoch !== generation) return;
          report = next;
          running = next.running === true;
          error = "";
          if (!running && !starting) notice = "";
          paint();
        } catch (err) {
          if (disposed || epoch !== generation) return;
          error = String(err?.message ?? err); errorAction = "status";
          paint();
        }
      })();
      refreshPromise = pending;
      try { await pending; }
      finally {
        if (refreshPromise === pending) refreshPromise = null;
        plan();
      }
    }
    async function start(scope) {
      if (!["all", "enabled"].includes(scope)) throw new Error("Invalid scan scope");
      if (disposed || starting || running) return { started: false, busy: starting || running };
      const epoch = ++generation;
      starting = true; error = ""; notice = "starting";
      stopTimer(); paint();
      try {
        const result = unpack(await call("codex_route_scan", { scope, dry_run: false }));
        if (disposed || epoch !== generation) return result;
        if (!result.started && !result.busy) throw new Error(result.error || result.note || "The scan did not start");
        running = result.started === true || result.busy === true;
        notice = result.busy ? "busy" : "started";
        return result;
      } catch (err) {
        if (!disposed && epoch === generation) {
          error = String(err?.message ?? err); errorAction = "start"; running = false; notice = "";
        }
        return { started: false, error: String(err?.message ?? err) };
      } finally {
        if (!disposed && epoch === generation) {
          starting = false; paint();
          // A pre-click status read must finish before a fresh read; its
          // generation is stale and cannot undo this click's busy state.
          if (running) {
            if (refreshPromise) await refreshPromise;
            await refresh();
          } else plan();
        }
      }
    }
    return {
      refresh, start,
      setVisible(value) {
        visible = value === true;
        stopTimer();
        if (visible && !disposed) refresh();
      },
      dispose() { disposed = true; ++generation; stopTimer(); },
    };
  }
  globalThis.CodexRouteMonitorPanel = { createController, unpack };
})();
