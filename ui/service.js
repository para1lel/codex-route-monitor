(() => {
  const boot = window.CodexMonitorBoot;
  delete window.CodexMonitorBoot;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let zh = !String(params.get('lang') || 'zh').startsWith('en');
  const text = (cn, en) => zh ? cn : en;
  let current;
  function theme(value = {}) {
    if (value.lang) zh = !String(value.lang).startsWith('en');
    const dark = typeof value.dark === 'boolean' ? value.dark : params.get('dark') === '1';
    document.documentElement.dataset.dark = String(dark);
    document.documentElement.lang = zh ? 'zh' : 'en';
    const tokens = value.tokens || {};
    for (const [key, token] of Object.entries({bg:'bg',fg:'text',muted:'muted',line:'border',control:'surface',accent:'accent'})) {
      if (typeof tokens[token] === 'string') document.documentElement.style.setProperty('--'+key, tokens[token]);
    }
    $('title').textContent = text('路由检测','Route check');
    $('all').textContent = text('测试全部','Test all');
    $('enabled').textContent = text('测试已启用','Test enabled');
    $('refresh').title = text('刷新','Refresh');
    $('refresh').setAttribute('aria-label', $('refresh').title);
    $('note').textContent = text('检测在后台运行，关闭此页不会中断。命中 Luna 的账号将被停用，正常账号启用，失败时保留原状态。','Tests continue in the background. Luna accounts are disabled, normal accounts enabled; failures preserve the current setting.');
    if (current) paint(current);
  }
  // Only presentation events are received from Magpie. Starting a scan never
  // trusts postMessage, a URL parameter, a cookie or a null Origin alone.
  addEventListener('message', e => {
    if (e.source !== parent || e.data?.magpie !== 1) return;
    if (e.data.event === 'theme') theme(e.data.data);
    if (e.data.event === 'visibility') controller.setVisible(e.data.data?.visible === true);
  });
  function paint(state) {
    current = state;
    const report = state.report, run = report?.lastRun;
    const p = report?.progress || run?.progress || {};
    const completedOutcomes = !state.running && run?.status === 'done' ? (run.accounts?.length || 0) : 0;
    const done = Math.max(completedOutcomes, Number(p.completed ?? 0));
    const total = Math.max(done, Number(p.total ?? done));
    $('all').disabled = $('enabled').disabled = state.busy || !report || !!state.error;
    $('all').setAttribute('aria-pressed', String(state.running && (report?.active?.scope || run?.scope) === 'all'));
    $('enabled').setAttribute('aria-pressed', String(state.running && (report?.active?.scope || run?.scope) === 'enabled'));
    document.querySelector('.state').setAttribute('aria-busy',String(state.busy));
    let label = report ? text('未检测','Not tested') : text('正在连接…','Connecting…');
    if (state.starting) label = text('启动中…','Starting…');
    else if (state.running) label = p.phase === 'applying' ? text('应用结果中…','Applying results…') : total ? text(`检测中 ${done}/${total}`,`Testing ${done}/${total}`) : text('准备中…','Preparing…');
    else if (run?.status === 'done') label = total ? text('已完成','Complete') : text('无可测账号','No accounts');
    else if (run?.status === 'interrupted') label = text('已中断','Interrupted');
    else if (run?.status === 'failed') label = text('检测失败','Test failed');
    if (state.notice === 'busy') label = text('检测已在运行','Already running');
    if (state.error && state.errorAction === 'status') label = text('等待连接…','Reconnecting…');
    $('status').textContent = label;
    $('progress').hidden = !state.running || !total;
    $('progress').max = Math.max(1,total); $('progress').value = Math.min(done,total);
    const results = run?.accounts || [];
    const counts = [['ok',text('正常','Normal')],['risk',text('风控','Held back')],['error',text('异常','Errors')]].map(([v,n]) => [results.filter(a=>a.verdict===v).length,n]).filter(([n])=>n).map(([n,t])=>`${t} ${n}`);
    const at = run?.finishedAt || run?.startedAt;
    if (state.running && ['account','probe'].includes(p.phase)) counts.push(text(`挑战 ${p.probesCompleted || 0}/${p.probesTotal || 3}`,`Challenge ${p.probesCompleted || 0}/${p.probesTotal || 3}`));
    else if (at) counts.push(new Date(at).toLocaleString(zh?'zh-CN':'en'));
    $('details').textContent = counts.join(' · ');
    $('error').hidden = !state.error;
    $('error').textContent = state.error ? text('连接或启动失败：','Connection or start failed: ') + state.error : '';
  }
  async function call(name,args) {
    const scan = name === 'codex_route_scan';
    const response = await fetch(new URL(scan?'api/scan':'api/status',location.href), {
      method: scan?'POST':'GET', credentials:'omit', cache:'no-store',
      headers: {'X-Codex-Monitor-Key':boot.apiKey,...(scan?{'Content-Type':'application/json'}:{})},
      ...(scan?{body:JSON.stringify(args)}:{}), signal:AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  const controller = CodexRouteMonitorPanel.createController({call,render:paint,activeMs:3000,idleMs:5000});
  theme();
  $('all').onclick = () => controller.start('all');
  $('enabled').onclick = () => controller.start('enabled');
  $('refresh').onclick = () => controller.refresh();
  document.addEventListener('visibilitychange',()=>controller.setVisible(!document.hidden));
  addEventListener('pagehide',()=>controller.dispose(),{once:true});
  controller.refresh();
})();
