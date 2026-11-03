// Only the official page bridge is used here. In web mode its capability URL
// points at Magpie's computer, never at the remote reader's own loopback.
(async () => {
  try {
    await magpie.ready;
    let base = magpie.service;
    if (!base) {
      const options = await magpie.options.get();
      const value = options.uiPort === undefined ? 3489 : options.uiPort;
      if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) throw new Error("无效的服务端口");
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3425, 3430].includes(port)) throw new Error("无效的服务端口");
      base = `http://127.0.0.1:${port}/`;
    }
    const url = new URL(base);
    // Theme is presentation only, never an authentication credential.
    url.searchParams.set("lang", magpie.theme?.lang || "zh");
    url.searchParams.set("dark", magpie.theme?.dark ? "1" : "0");
    location.replace(url.href);
  } catch (error) {
    document.getElementById("message").textContent = `暂时无法连接：${String(error?.message || error)}。请重开此页。`;
  }
})();
