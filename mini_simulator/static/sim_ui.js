(() => {
  const root = document.body;
  const defaults = {
    nodeId: root.dataset.defaultNodeId || "WIN_001",
    host: root.dataset.defaultTargetHost || "127.0.0.1",
    port: root.dataset.defaultTargetPort || "5000",
    path: root.dataset.defaultTargetPath || "/api/upload",
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
    elStatus.textContent = text;
    elStatus.classList.remove("text-bg-secondary", "text-bg-success", "text-bg-danger", "text-bg-warning");
    if (level === "ok") elStatus.classList.add("text-bg-success");
    else if (level === "err") elStatus.classList.add("text-bg-danger");
    else if (level === "warn") elStatus.classList.add("text-bg-warning");
    else elStatus.classList.add("text-bg-secondary");
  }

  function buildUrlPreview() {
    const scheme = elScheme.value || "http";
    const host = elHost.value.trim();
    const port = String(elPort.value || "").trim() || "80";
    let path = elPath.value.trim() || "/api/upload";
    if (!path.startsWith("/")) path = `/${path}`;
    const url = host ? `${scheme}://${host}:${port}${path}` : "-";
    elPreview.textContent = url;
    return url;
  }

  function appendLog(text) {
    const current = elLog.textContent === "等待操作..." ? "" : `${elLog.textContent}\n`;
    elLog.textContent = `${text}\n${current}`.trimEnd();
  }

  function loadLocal() {
    try {
      return JSON.parse(window.localStorage.getItem("mini_sim_target") || "null");
    } catch (error) {
      return null;
    }
  }

  function saveLocal() {
    try {
      window.localStorage.setItem(
        "mini_sim_target",
        JSON.stringify({
          scheme: elScheme.value,
          host: elHost.value.trim(),
          port: String(elPort.value).trim(),
          path: elPath.value.trim(),
          nodeId: elNodeId.value.trim(),
          subCount: String(elSubCount.value).trim(),
        })
      );
      setStatus("已保存", "ok");
    } catch (error) {
      setStatus("保存失败", "err");
    }
  }

  function safeSubCount() {
    const parsed = parseInt(String(elSubCount.value || "4"), 10);
    return Math.max(1, Math.min(64, Number.isFinite(parsed) ? parsed : 4));
  }

  function buildSamplePayload(nodeId, subCount) {
    const payload = {
      node_id: nodeId,
      sub: String(subCount),
    };
    for (let i = 1; i <= subCount; i += 1) {
      const code = String(i).padStart(3, "0");
      payload[code] = [
        Number((690 + i * 0.8).toFixed(3)),
        Number((100 + i * 0.5).toFixed(3)),
        Number((15 + i * 0.2).toFixed(3)),
        Number((32 + i * 0.4).toFixed(3)),
      ];
    }
    return payload;
  }

  function fillHeaderOnly() {
    const nodeId = elNodeId.value.trim() || defaults.nodeId;
    elPayload.value = JSON.stringify({ node_id: nodeId, sub: String(safeSubCount()) }, null, 2);
  }

  function fillSample() {
    const nodeId = elNodeId.value.trim() || defaults.nodeId;
    const payload = buildSamplePayload(nodeId, safeSubCount());
    elPayload.value = JSON.stringify(payload, null, 2);
  }

  async function sendNow() {
    const targetUrl = buildUrlPreview();
    if (!elHost.value.trim()) {
      setStatus("请填写目标地址", "warn");
      return;
    }
    if (!elPayload.value.trim()) {
      setStatus("请填写 JSON", "warn");
      return;
    }

    setStatus("发送中...", "warn");
    try {
      const resp = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scheme: elScheme.value,
          host: elHost.value.trim(),
          port: Number(elPort.value || 80),
          path: elPath.value.trim(),
          payload_json: elPayload.value,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.ok) {
        setStatus("发送失败", "err");
        appendLog(`[${new Date().toLocaleTimeString()}] FAIL ${targetUrl}\n${JSON.stringify(data, null, 2)}`);
        return;
      }
      setStatus("发送成功", "ok");
      appendLog(
        `[${new Date().toLocaleTimeString()}] OK ${data.target_url} ${data.status_code} (${data.elapsed_ms}ms)\n${
          data.response_text || ""
        }`
      );
    } catch (error) {
      setStatus("发送异常", "err");
      appendLog(`[${new Date().toLocaleTimeString()}] ERROR ${targetUrl}\n${String(error)}`);
    }
  }

  function initDefaults() {
    const saved = loadLocal();
    elScheme.value = (saved && saved.scheme) || "http";
    elHost.value = (saved && saved.host) || defaults.host;
    elPort.value = (saved && saved.port) || defaults.port;
    elPath.value = (saved && saved.path) || defaults.path;
    elNodeId.value = (saved && saved.nodeId) || defaults.nodeId;
    elSubCount.value = (saved && saved.subCount) || "4";
    fillSample();
    buildUrlPreview();
  }

  [elScheme, elHost, elPort, elPath].forEach((el) => {
    el.addEventListener("input", buildUrlPreview);
    el.addEventListener("change", buildUrlPreview);
  });
  elBtnSaveTarget.addEventListener("click", saveLocal);
  elBtnFillNodeOnly.addEventListener("click", fillHeaderOnly);
  elBtnFill32.addEventListener("click", fillSample);
  elBtnSend.addEventListener("click", sendNow);
  elBtnClearLog.addEventListener("click", () => {
    elLog.textContent = "等待操作...";
  });
  elSubCount.addEventListener("change", fillSample);

  initDefaults();
  setStatus("就绪", "ok");
})();
