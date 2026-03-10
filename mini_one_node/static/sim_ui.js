(() => {
  const root = document.body;
  const defaults = {
    nodeId: root.dataset.defaultNodeId || "WIN_001",
    host: root.dataset.defaultTargetHost || "127.0.0.1",
    port: root.dataset.defaultTargetPort || "5000",
    path: root.dataset.defaultTargetPath || "/api/upload",
    subCount: "32",
  };

  const elScheme = document.getElementById("scheme");
  const elHost = document.getElementById("host");
  const elPort = document.getElementById("port");
  const elPath = document.getElementById("path");
  const elPreview = document.getElementById("targetUrlPreview");
  const elNodeId = document.getElementById("nodeId");
  const elSubCount = document.getElementById("subCount");
  const elPayload = document.getElementById("payloadJson");
  const elLog = document.getElementById("resultLog");
  const elStatus = document.getElementById("uiStatus");

  const elBtnSaveTarget = document.getElementById("btnSaveTarget");
  const elBtnFillNodeOnly = document.getElementById("btnFillNodeOnly");
  const elBtnFill32 = document.getElementById("btnFill32");
  const elBtnSend = document.getElementById("btnSend");
  const elBtnClearLog = document.getElementById("btnClearLog");

  function setStatus(text, level) {
    if (!elStatus) return;
    elStatus.textContent = text;
    elStatus.className = "badge";
    if (level === "ok") elStatus.classList.add("text-bg-success");
    else if (level === "err") elStatus.classList.add("text-bg-danger");
    else if (level === "warn") elStatus.classList.add("text-bg-warning");
    else elStatus.classList.add("text-bg-secondary");
  }

  function clampSubCount(value) {
    const parsed = parseInt(String(value || defaults.subCount), 10);
    if (!Number.isFinite(parsed)) return 32;
    return Math.max(1, Math.min(64, parsed));
  }

  function buildUrlPreview() {
    const scheme = (elScheme && elScheme.value) || "http";
    const host = (elHost && elHost.value.trim()) || "";
    const port = (elPort && String(elPort.value).trim()) || "";
    let path = (elPath && elPath.value.trim()) || "/api/upload";
    if (!path.startsWith("/")) path = `/${path}`;
    const url = host ? `${scheme}://${host}:${port || "80"}${path}` : "-";
    if (elPreview) elPreview.textContent = url;
    return url;
  }

  function appendLog(line) {
    if (!elLog) return;
    const current = elLog.textContent || "";
    elLog.textContent = `${line}\n${current === "等待操作..." ? "" : current}`.trimEnd();
  }

  function saveLocal() {
    try {
      const data = {
        scheme: elScheme ? elScheme.value : "http",
        host: elHost ? elHost.value.trim() : "",
        port: elPort ? String(elPort.value).trim() : "",
        path: elPath ? elPath.value.trim() : "",
        nodeId: elNodeId ? elNodeId.value.trim() : "",
        subCount: elSubCount ? String(clampSubCount(elSubCount.value)) : defaults.subCount,
      };
      localStorage.setItem("mini_one_node_sim_target", JSON.stringify(data));
      setStatus("已保存", "ok");
    } catch (error) {
      setStatus("保存失败", "err");
    }
  }

  function loadLocal() {
    try {
      const raw = localStorage.getItem("mini_one_node_sim_target");
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function buildSamplePayload(nodeId, subCount) {
    const count = clampSubCount(subCount);
    const payload = { node_id: nodeId, sub: String(count) };
    for (let index = 1; index <= count; index += 1) {
      const code = String(index).padStart(3, "0");
      const base = index % 4 === 1 ? [3.121, 4.321, 1.202, 1.678] : [1.234, 0.829, 4.906, 4.587];
      payload[code] = base.map((value, offset) => Number((value + index * 0.001 * (offset + 1)).toFixed(3)));
    }
    return payload;
  }

  function initDefaults() {
    const saved = loadLocal();
    if (elScheme) elScheme.value = (saved && saved.scheme) || "http";
    if (elHost) elHost.value = (saved && saved.host) || defaults.host;
    if (elPort) elPort.value = (saved && saved.port) || defaults.port;
    if (elPath) elPath.value = (saved && saved.path) || defaults.path;
    if (elNodeId) elNodeId.value = (saved && saved.nodeId) || defaults.nodeId;
    if (elSubCount) elSubCount.value = (saved && saved.subCount) || defaults.subCount;
    if (elPayload) {
      elPayload.value = JSON.stringify(
        { node_id: (elNodeId && elNodeId.value.trim()) || defaults.nodeId, sub: String(clampSubCount(elSubCount && elSubCount.value)) },
        null,
        2
      );
    }
    buildUrlPreview();
  }

  function fillHeaderOnly() {
    const nodeId = (elNodeId && elNodeId.value.trim()) || defaults.nodeId;
    const sub = String(clampSubCount(elSubCount && elSubCount.value));
    if (elSubCount) elSubCount.value = sub;
    if (elPayload) {
      elPayload.value = JSON.stringify({ node_id: nodeId, sub }, null, 2);
    }
  }

  function fillSamplePayload() {
    const nodeId = (elNodeId && elNodeId.value.trim()) || defaults.nodeId;
    const sub = clampSubCount(elSubCount && elSubCount.value);
    if (elSubCount) elSubCount.value = String(sub);
    if (elPayload) {
      elPayload.value = JSON.stringify(buildSamplePayload(nodeId, sub), null, 2);
    }
  }

  async function sendNow() {
    const url = buildUrlPreview();
    const scheme = (elScheme && elScheme.value) || "http";
    const host = (elHost && elHost.value.trim()) || "";
    const port = (elPort && String(elPort.value).trim()) || "";
    const path = (elPath && elPath.value.trim()) || "";
    const payloadJson = (elPayload && elPayload.value) || "";

    if (!host) {
      setStatus("请填写目标 IP/域名", "warn");
      return;
    }
    if (!payloadJson.trim()) {
      setStatus("请填写 JSON", "warn");
      return;
    }

    setStatus("发送中...", "warn");
    const t0 = Date.now();
    try {
      const response = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheme,
          host,
          port: Number(port || 80),
          path,
          payload_json: payloadJson,
        }),
      });
      const data = await response.json().catch(() => ({}));
      const elapsed = Date.now() - t0;

      if (!response.ok || !data.ok) {
        setStatus("发送失败", "err");
        appendLog(`[${new Date().toLocaleTimeString()}] FAIL  ${url}  (${elapsed}ms)\n${JSON.stringify(data, null, 2)}\n`);
        return;
      }

      setStatus("发送成功", "ok");
      appendLog(
        `[${new Date().toLocaleTimeString()}] OK    ${data.target_url}  ${data.status_code}  (${data.elapsed_ms}ms)\n${(data.response_text || "").trim()}\n`
      );
    } catch (error) {
      setStatus("发送异常", "err");
      appendLog(`[${new Date().toLocaleTimeString()}] ERROR ${url}\n${String(error)}\n`);
    }
  }

  if (elBtnSaveTarget) elBtnSaveTarget.addEventListener("click", saveLocal);
  if (elBtnFillNodeOnly) elBtnFillNodeOnly.addEventListener("click", fillHeaderOnly);
  if (elBtnFill32) elBtnFill32.addEventListener("click", fillSamplePayload);
  if (elBtnSend) elBtnSend.addEventListener("click", sendNow);
  if (elBtnClearLog) {
    elBtnClearLog.addEventListener("click", () => {
      if (elLog) elLog.textContent = "等待操作...";
    });
  }

  [elScheme, elHost, elPort, elPath].forEach((el) => {
    if (!el) return;
    el.addEventListener("input", buildUrlPreview);
    el.addEventListener("change", buildUrlPreview);
  });

  if (elSubCount) {
    elSubCount.addEventListener("change", () => {
      elSubCount.value = String(clampSubCount(elSubCount.value));
    });
  }

  initDefaults();
  setStatus("就绪", "ok");
})();
