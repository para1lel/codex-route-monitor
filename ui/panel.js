(() => {
  const en = {
    all: "Test all", enabled: "Test enabled", refresh: "Refresh",
    allHint: "Includes disabled accounts. Results update account switches.",
    enabledHint: "Test enabled accounts. Results update account switches.",
    loading: "Loading…", idle: "Not tested", starting: "Starting…", busy: "Already running",
    running: "Testing {done}/{total}", unknownTotal: "Preparing…", applying: "Applying…",
    complete: "Complete", empty: "No accounts", failed: "Failed: {error}", interrupted: "Interrupted",
    probe: "Account {account}/{total} · challenge {done}/{probes}",
    ok: "{n} normal", risk: "{n} held back", undiagnosed: "{n} undiagnosed",
    updated: "Last test: {time}", unsupported: "Update Magpie to use manual tests.",
    dry: "Report only", error: "Status unavailable: {error}", startError: "Could not start: {error}",
  };
  const packs = {
    zh: {
      all: "测试全部", enabled: "测试已启用", refresh: "刷新",
      allHint: "包含已停用账号，按结果自动启停账号。", enabledHint: "仅检测已启用账号，按结果自动启停账号。",
      loading: "读取中…", idle: "未检测", starting: "启动中…", busy: "检测已在运行",
      running: "检测中 {done}/{total}", unknownTotal: "准备中…", applying: "应用结果中…",
      complete: "已完成", empty: "无可测账号", failed: "失败：{error}", interrupted: "已中断",
      probe: "账号 {account}/{total} · 挑战 {done}/{probes}",
      ok: "正常 {n}", risk: "风控 {n}", undiagnosed: "异常 {n}",
      updated: "最近检测：{time}", unsupported: "请更新 Magpie 后使用手动检测。", dry: "仅报告",
      error: "状态读取失败：{error}", startError: "启动失败：{error}",
    },
    "zh-TW": {
      all: "測試全部", enabled: "測試已啟用", refresh: "重新整理",
      allHint: "包含已停用帳號，依結果自動啟停帳號。", enabledHint: "僅檢測已啟用帳號，依結果自動啟停帳號。",
      loading: "讀取中…", idle: "未檢測", starting: "啟動中…", busy: "檢測已在執行",
      running: "檢測中 {done}/{total}", unknownTotal: "準備中…", applying: "套用結果中…",
      complete: "已完成", empty: "無可測帳號", failed: "失敗：{error}", interrupted: "已中斷",
      probe: "帳號 {account}/{total} · 挑戰 {done}/{probes}",
      ok: "正常 {n}", risk: "風控 {n}", undiagnosed: "異常 {n}",
      updated: "最近檢測：{time}", unsupported: "請更新 Magpie 後使用手動檢測。", dry: "僅報告",
      error: "狀態讀取失敗：{error}", startError: "啟動失敗：{error}",
    },
    ja: {
      all: "すべてテスト", enabled: "有効のみテスト", refresh: "更新",
      allHint: "無効なアカウントも含みます。結果でアカウント設定を更新します。", enabledHint: "有効なアカウントをテストし、結果を適用します。",
      loading: "読込中…", idle: "未検査", starting: "開始中…", busy: "実行中",
      running: "テスト中 {done}/{total}", unknownTotal: "準備中…", applying: "適用中…",
      complete: "完了", empty: "対象なし", failed: "失敗：{error}", interrupted: "中断",
      probe: "アカウント {account}/{total} · 課題 {done}/{probes}",
      ok: "正常 {n}", risk: "制限 {n}", undiagnosed: "未診断 {n}",
      updated: "前回：{time}", unsupported: "手動検査には Magpie の更新が必要です。", dry: "レポートのみ",
      error: "状態取得失敗：{error}", startError: "開始失敗：{error}",
    },
    de: {
      all: "Alle testen", enabled: "Aktivierte testen", refresh: "Aktualisieren",
      allHint: "Auch deaktivierte Konten. Ergebnisse ändern Kontoeinstellungen.", enabledHint: "Nur aktivierte Konten. Ergebnisse ändern Kontoeinstellungen.",
      loading: "Laden…", idle: "Nicht getestet", starting: "Startet…", busy: "Läuft bereits",
      running: "Test {done}/{total}", unknownTotal: "Vorbereiten…", applying: "Anwenden…",
      complete: "Fertig", empty: "Keine Konten", failed: "Fehler: {error}", interrupted: "Unterbrochen",
      probe: "Konto {account}/{total} · Aufgabe {done}/{probes}",
      ok: "Normal {n}", risk: "Eingeschränkt {n}", undiagnosed: "Unklar {n}",
      updated: "Letzter Test: {time}", unsupported: "Für manuelle Tests Magpie aktualisieren.", dry: "Nur Bericht",
      error: "Statusfehler: {error}", startError: "Startfehler: {error}",
    },
  };
  const $ = id => document.getElementById(id);
  let lang = "en";
  const t = (key, values = {}) => String((packs[lang] || {})[key] || en[key]).replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ""));
  const number = (value, fallback = 0) => value != null && Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback;
  function labels(theme) {
    lang = packs[theme.lang] ? theme.lang : packs[String(theme.lang).split("-")[0]] ? String(theme.lang).split("-")[0] : "en";
    $("test-all").textContent = t("all");
    $("test-enabled").textContent = t("enabled");
    $("test-all").title = t("allHint");
    $("test-enabled").title = t("enabledHint");
    $("refresh").title = t("refresh");
    $("refresh").setAttribute("aria-label", t("refresh"));
  }
  function paint(state) {
    const report = state.report, run = report?.lastRun;
    const progress = report?.progress || run?.progress || {};
    const legacyDone = !state.running && run?.status === "done" && progress.total == null;
    const done = legacyDone ? run.accounts?.length || 0 : number(progress.completed, run?.accounts?.length || 0);
    const total = number(progress.total, done);
    $("test-all").disabled = $("test-enabled").disabled = state.busy || !report;
    const activeScope = report?.active?.scope || run?.scope;
    $("test-all").setAttribute("aria-pressed", String(report?.running === true && activeScope === "all"));
    $("test-enabled").setAttribute("aria-pressed", String(report?.running === true && activeScope === "enabled"));
    $("monitor").setAttribute("aria-busy", String(state.busy));
    let text = t("loading");
    if (state.error) text = t(state.errorAction === "start" ? "startError" : "error", { error: state.error });
    else if (state.starting) text = t("starting");
    else if (state.running) text = progress.phase === "applying" ? t("applying") : total ? t("running", { done, total }) : t("unknownTotal");
    else if (run?.status === "interrupted") text = t("interrupted");
    else if (run?.status === "failed") text = t("failed", { error: run.error || "—" });
    else if (run?.status === "done") text = t(total ? "complete" : "empty");
    else if (report) text = t("idle");
    if (state.notice === "busy" && !state.error) text = t("busy");
    $("status").textContent = text;
    $("status").dataset.error = String(!!state.error || ["failed", "interrupted"].includes(run?.status));
    $("progress").hidden = !state.running || total === 0;
    $("progress").max = Math.max(1, total);
    $("progress").value = Math.min(done, total);
    $("progress").setAttribute("aria-label", t("running", { done, total }));
    const probing = state.running && ["account", "probe"].includes(progress.phase);
    $("details").hidden = !probing;
    if (probing) $("details").textContent = t("probe", { account: Math.min(done + 1, total), total, done: number(progress.probesCompleted), probes: number(progress.probesTotal, 3) });
    const outcomes = run?.accounts || [];
    const ok = outcomes.filter(a => a.verdict === "ok").length;
    const risk = outcomes.filter(a => a.verdict === "risk").length;
    const errors = outcomes.filter(a => a.verdict === "error").length;
    $("results").hidden = outcomes.length === 0;
    $("results").textContent = [["ok", ok], ["risk", risk], ["undiagnosed", errors]].filter(([, n]) => n > 0).map(([key, n]) => t(key, { n })).join(" · ") + (run?.dryRun ? " · " + t("dry") : "");
    $("results").dataset.tone = errors ? "error" : risk ? "risk" : "normal";
    const at = run?.finishedAt || run?.startedAt;
    $("updated").hidden = !at || state.running;
    if (at) {
      const date = new Date(at);
      $("updated").textContent = Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString(lang, { hour: "2-digit", minute: "2-digit", hour12: false });
      $("updated").dateTime = at;
      $("updated").title = t("updated", { time: Number.isNaN(date.getTime()) ? at : date.toLocaleString(lang) });
      $("updated").setAttribute("aria-label", $("updated").title);
    }
  }
  (async () => {
    try {
      const bridge = globalThis.magpie;
      labels(await bridge.ready);
      if (bridge.context?.provider?.id !== "codex") return;
      if (typeof bridge.tools?.call !== "function") throw new Error(t("unsupported"));
      $("monitor").hidden = false;
      let current;
      const controller = CodexRouteMonitorPanel.createController({ call: (name, args) => bridge.tools.call(name, args), render: state => { current = state; paint(state); } });
      bridge.onTheme(next => { labels(next); if (current) paint(current); });
      $("test-all").onclick = () => controller.start("all");
      $("test-enabled").onclick = () => controller.start("enabled");
      $("refresh").onclick = () => controller.refresh();
      bridge.onVisibility(visible => controller.setVisible(visible));
      addEventListener("pagehide", () => controller.dispose(), { once: true });
      await controller.refresh();
    } catch (error) {
      $("fatal").hidden = false;
      $("fatal").textContent = String(error?.message ?? error);
    }
  })();
})();
