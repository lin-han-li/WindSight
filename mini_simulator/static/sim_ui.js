(() => {
  const root = document.body;
  const defaults = {
    nodeId: root.dataset.defaultNodeId || "WIN_001",
    host: root.dataset.defaultTargetHost || "127.0.0.1",
    port: root.dataset.defaultTargetPort || "8080",
    path: root.dataset.defaultTargetPath || "/api/upload",
  };

  const STORAGE_TARGET = "mini_sim_target_v2";
  const STORAGE_HISTORY = "mini_sim_history_v2";
  const MAX_HISTORY = 8;

  const els = {
    scheme: document.getElementById("scheme"),
    host: document.getElementById("host"),
    port: document.getElementById("port"),
    path: document.getElementById("path"),
    authMode: document.getElementById("authMode"),
    nodeKey: document.getElementById("nodeKey"),
    credentialId: document.getElementById("credentialId"),
    credentialSecret: document.getElementById("credentialSecret"),
    preview: document.getElementById("targetUrlPreview"),
    nodeId: document.getElementById("nodeId"),
    subCount: document.getElementById("subCount"),
    payload: document.getElementById("payloadJson"),
    jsonState: document.getElementById("jsonState"),
    payloadSummary: document.getElementById("payloadSummary"),
    status: document.getElementById("uiStatus"),
    responseMeta: document.getElementById("responseMeta"),
    responseBody: document.getElementById("responseBody"),
    responseJson: document.getElementById("responseJson"),
    historyList: document.getElementById("historyList"),
    btnSaveTarget: document.getElementById("btnSaveTarget"),
    btnFillNodeOnly: document.getElementById("btnFillNodeOnly"),
    btnFill32: document.getElementById("btnFill32"),
    btnFormatJson: document.getElementById("btnFormatJson"),
    btnMinifyJson: document.getElementById("btnMinifyJson"),
    btnCopyJson: document.getElementById("btnCopyJson"),
    btnSend: document.getElementById("btnSend"),
    btnResend: document.getElementById("btnResend"),
    btnClearLog: document.getElementById("btnClearLog"),
  };

  let recentHistory = [];
  let lastRequest = null;

  function syncAuthModeUi() {
    const mode = els.authMode?.value === "legacy" ? "legacy" : "hmac";
    document.querySelectorAll(".auth-hmac").forEach((el) => {
      el.hidden = mode !== "hmac";
    });
    document.querySelectorAll(".auth-legacy").forEach((el) => {
      el.hidden = mode !== "legacy";
    });
  }

  function setPill(el, text, level = "idle") {
    if (!el) return;
    el.textContent = text;
    el.dataset.level = level;
  }

  function normalizePath(path) {
    const value = String(path || "/api/upload").trim() || "/api/upload";
    return value.startsWith("/") ? value : `/${value}`;
  }

  function safePort(raw) {
    const parsed = parseInt(String(raw || ""), 10);
    if (!Number.isFinite(parsed)) return 8080;
    return Math.max(1, Math.min(65535, parsed));
  }

  function safeSubCount() {
    const parsed = parseInt(String(els.subCount.value || "4"), 10);
    const value = Math.max(1, Math.min(200, Number.isFinite(parsed) ? parsed : 4));
    els.subCount.value = String(value);
    return value;
  }

  function buildUrlPreview() {
    const scheme = els.scheme.value === "https" ? "https" : "http";
    const host = els.host.value.trim();
    const port = safePort(els.port.value);
    const path = normalizePath(els.path.value);
    els.path.value = path;
    els.port.value = String(port);
    const url = host ? `${scheme}://${host}:${port}${path}` : "-";
    els.preview.textContent = url;
    return url;
  }

  function parsePayload() {
    const raw = els.payload.value;
    if (!raw.trim()) {
      return { ok: false, error: "JSON 不能为空" };
    }
    try {
      const value = JSON.parse(raw);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, error: "顶层必须是 JSON 对象" };
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: `JSON 解析失败：${error.message}` };
    }
  }

  function summarizePayload(payload) {
    const nodeId = String(payload.node_id || "").trim() || "-";
    const sub = parseInt(String(payload.sub || "0"), 10) || 0;
    const turbineKeys = Object.keys(payload)
      .filter((key) => /^\d{3}$/.test(key))
      .sort((left, right) => Number(left) - Number(right));
    if (!sub) return `node_id=${nodeId}，缺少有效 sub`;
    if (turbineKeys.length !== sub) return `node_id=${nodeId}，sub=${sub}，实际通道 ${turbineKeys.length}`;
    return `node_id=${nodeId}，sub=${sub}，风机键 ${turbineKeys.length}/${sub}`;
  }

  function validatePayloadUi() {
    const parsed = parsePayload();
    if (!parsed.ok) {
      setPill(els.jsonState, "JSON 错误", "err");
      els.payloadSummary.textContent = parsed.error;
      return parsed;
    }
    const payload = parsed.value;
    const nodeId = String(payload.node_id || "").trim();
    const sub = parseInt(String(payload.sub || "0"), 10);
    if (!nodeId) {
      setPill(els.jsonState, "缺 node_id", "warn");
    } else if (!Number.isFinite(sub) || sub < 1 || sub > 200) {
      setPill(els.jsonState, "sub 越界", "warn");
    } else if (Object.keys(payload).some((key) => key !== "node_id" && key !== "sub" && !/^\d{3}$/.test(key))) {
      setPill(els.jsonState, "通道键错误", "warn");
    } else if (
      Object.keys(payload)
        .filter((key) => /^\d{3}$/.test(key))
        .some((key) => Number(key) < 1 || Number(key) > 200)
    ) {
      setPill(els.jsonState, "通道越界", "warn");
    } else if (Object.keys(payload).filter((key) => /^\d{3}$/.test(key)).length !== sub) {
      setPill(els.jsonState, "sub 不匹配", "warn");
    } else {
      setPill(els.jsonState, "JSON 可发送", "ok");
    }
    els.payloadSummary.textContent = summarizePayload(payload);
    return parsed;
  }

  function buildSamplePayload(nodeId, subCount) {
    const payload = {
      node_id: nodeId,
      sub: String(subCount),
    };
    for (let i = 1; i <= subCount; i += 1) {
      const code = String(i).padStart(3, "0");
      payload[code] = [
        Number((3.48 + i * 0.018).toFixed(3)),
        Number((1.92 + i * 0.015).toFixed(3)),
        Number((1.72 + i * 0.022).toFixed(3)),
        Number((1.54 + i * 0.012).toFixed(3)),
      ];
    }
    return payload;
  }

  function fillHeaderOnly() {
    const nodeId = els.nodeId.value.trim() || defaults.nodeId;
    els.payload.value = JSON.stringify({ node_id: nodeId, sub: String(safeSubCount()) }, null, 2);
    validatePayloadUi();
  }

  function fillSample() {
    const nodeId = els.nodeId.value.trim() || defaults.nodeId;
    els.payload.value = JSON.stringify(buildSamplePayload(nodeId, safeSubCount()), null, 2);
    validatePayloadUi();
  }

  function formatJson(spaces) {
    const parsed = parsePayload();
    if (!parsed.ok) {
      validatePayloadUi();
      return false;
    }
    els.payload.value = JSON.stringify(parsed.value, null, spaces);
    validatePayloadUi();
    return true;
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const range = document.createRange();
    const selection = window.getSelection();
    const holder = document.createElement("textarea");
    holder.value = text;
    holder.style.position = "fixed";
    holder.style.opacity = "0";
    document.body.appendChild(holder);
    holder.select();
    document.execCommand("copy");
    document.body.removeChild(holder);
    selection?.removeAllRanges();
    range.detach?.();
  }

  function saveTarget() {
    const data = {
      scheme: els.scheme.value,
      host: els.host.value.trim(),
      port: String(safePort(els.port.value)),
      path: normalizePath(els.path.value),
      authMode: els.authMode?.value || "hmac",
      nodeKey: els.nodeKey.value.trim(),
      credentialId: els.credentialId?.value.trim() || "",
      credentialSecret: els.credentialSecret?.value.trim() || "",
      nodeId: els.nodeId.value.trim(),
      subCount: String(safeSubCount()),
    };
    window.localStorage.setItem(STORAGE_TARGET, JSON.stringify(data));
    setPill(els.status, "配置已保存", "ok");
  }

  function loadJson(key, fallback) {
    try {
      const value = JSON.parse(window.localStorage.getItem(key) || "null");
      return value ?? fallback;
    } catch {
      return fallback;
    }
  }

  function restoreTarget(data) {
    if (!data) return;
    els.scheme.value = data.scheme === "https" ? "https" : "http";
    els.host.value = data.host || defaults.host;
    els.port.value = data.port || defaults.port;
    els.path.value = data.path || defaults.path;
    if (els.authMode) els.authMode.value = data.authMode === "legacy" ? "legacy" : "hmac";
    els.nodeKey.value = data.nodeKey || "";
    if (els.credentialId) els.credentialId.value = data.credentialId || "";
    if (els.credentialSecret) els.credentialSecret.value = data.credentialSecret || "";
    els.nodeId.value = data.nodeId || defaults.nodeId;
    els.subCount.value = data.subCount || "4";
    buildUrlPreview();
    syncAuthModeUi();
  }

  function renderHistory() {
    if (!recentHistory.length) {
      els.historyList.innerHTML = '<div class="history-empty">暂无发送记录</div>';
      return;
    }
    els.historyList.innerHTML = "";
    recentHistory.forEach((item, index) => {
      const button = document.createElement("button");
      button.className = "history-item";
      button.type = "button";
      button.innerHTML = `
        <strong><span>${item.ok ? "OK" : "FAIL"} ${item.statusCode || "-"}</span><span>${item.elapsedMs || 0}ms</span></strong>
        <small>${item.time} · ${item.targetUrl}</small>
        <small>${item.summary || ""}</small>
      `;
      button.addEventListener("click", () => {
        restoreTarget(item.target);
        els.payload.value = item.payloadJson || "";
        validatePayloadUi();
        setPill(els.status, `已恢复记录 ${index + 1}`, "ok");
      });
      els.historyList.appendChild(button);
    });
  }

  function pushHistory(entry) {
    recentHistory = [entry, ...recentHistory].slice(0, MAX_HISTORY);
    window.localStorage.setItem(STORAGE_HISTORY, JSON.stringify(recentHistory));
    renderHistory();
  }

  function explainFailure(data, status) {
    const code = data?.status_code || status;
    const text = String(data?.response_text || data?.error || "");
    if (code === 401 || code === 403) {
      return "权限失败：请确认节点已在 WindSight 注册，并填写正确的签名凭证或旧版 X-WindSight-Node-Key。";
    }
    if (code === 400) {
      return "请求被拒绝：请检查 node_id、sub、001..200 风机键和四指标数组。";
    }
    if (data?.error) {
      return `连接失败：${data.error}`;
    }
    return text || "发送失败，请检查目标地址和 payload。";
  }

  function currentTargetSnapshot() {
    return {
      scheme: els.scheme.value,
      host: els.host.value.trim(),
      port: String(safePort(els.port.value)),
      path: normalizePath(els.path.value),
      authMode: els.authMode?.value || "hmac",
      nodeKey: els.nodeKey.value.trim(),
      credentialId: els.credentialId?.value.trim() || "",
      credentialSecret: els.credentialSecret?.value.trim() || "",
      nodeId: els.nodeId.value.trim(),
      subCount: String(safeSubCount()),
    };
  }

  function buildSendBody() {
    return {
      scheme: els.scheme.value,
      host: els.host.value.trim(),
      port: safePort(els.port.value),
      path: normalizePath(els.path.value),
      auth_mode: els.authMode?.value || "hmac",
      node_key: els.nodeKey.value.trim(),
      credential_id: els.credentialId?.value.trim() || "",
      credential_secret: els.credentialSecret?.value.trim() || "",
      payload_json: els.payload.value,
    };
  }

  async function sendRequest(body, targetSnapshot) {
    const targetUrl = buildUrlPreview();
    const parsed = validatePayloadUi();
    if (!els.host.value.trim()) {
      setPill(els.status, "目标地址缺失", "warn");
      return;
    }
    if (!parsed.ok) {
      setPill(els.status, "JSON 不可发送", "err");
      return;
    }

    setPill(els.status, "发送中...", "warn");
    els.btnSend.disabled = true;
    els.btnResend.disabled = true;
    const startedAt = new Date();
    try {
      const resp = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await resp.json().catch(() => ({}));
      const ok = resp.ok && !!data.ok;
      const statusCode = data.status_code || resp.status;
      const elapsedMs = data.elapsed_ms || 0;
      const summary = summarizePayload(parsed.value);

      setPill(els.status, ok ? "发送成功" : "发送失败", ok ? "ok" : "err");
      els.responseMeta.textContent = `${statusCode || "-"} · ${elapsedMs}ms · ${data.target_url || targetUrl}`;
      els.responseBody.textContent = ok ? (data.response_text || "响应为空") : explainFailure(data, resp.status);
      els.responseJson.textContent = data.response_json
        ? JSON.stringify(data.response_json, null, 2)
        : "无";

      lastRequest = { body, target: targetSnapshot };
      els.btnResend.disabled = false;
      pushHistory({
        ok,
        statusCode,
        elapsedMs,
        time: startedAt.toLocaleTimeString(),
        targetUrl: data.target_url || targetUrl,
        target: targetSnapshot,
        payloadJson: body.payload_json,
        summary,
      });
    } catch (error) {
      setPill(els.status, "发送异常", "err");
      els.responseMeta.textContent = `${targetUrl}`;
      els.responseBody.textContent = `连接失败：${String(error)}`;
      els.responseJson.textContent = "无";
    } finally {
      els.btnSend.disabled = false;
      els.btnResend.disabled = !lastRequest;
    }
  }

  function sendNow() {
    sendRequest(buildSendBody(), currentTargetSnapshot());
  }

  function resendLast() {
    if (!lastRequest) return;
    restoreTarget(lastRequest.target);
    els.payload.value = lastRequest.body.payload_json;
    sendRequest(lastRequest.body, lastRequest.target);
  }

  function initDefaults() {
    const saved = loadJson(STORAGE_TARGET, null);
    recentHistory = loadJson(STORAGE_HISTORY, []);
    restoreTarget(saved || {
      scheme: "http",
      host: defaults.host,
      port: defaults.port,
      path: defaults.path,
      authMode: "hmac",
      nodeKey: "",
      credentialId: "",
      credentialSecret: "",
      nodeId: defaults.nodeId,
      subCount: "4",
    });
    fillSample();
    renderHistory();
  }

  [els.scheme, els.host, els.port, els.path].forEach((el) => {
    el.addEventListener("input", buildUrlPreview);
    el.addEventListener("change", buildUrlPreview);
  });
  els.authMode?.addEventListener("change", syncAuthModeUi);
  [els.payload].forEach((el) => {
    el.addEventListener("input", validatePayloadUi);
  });

  els.btnSaveTarget.addEventListener("click", saveTarget);
  els.btnFillNodeOnly.addEventListener("click", fillHeaderOnly);
  els.btnFill32.addEventListener("click", fillSample);
  els.btnFormatJson.addEventListener("click", () => {
    if (formatJson(2)) setPill(els.status, "JSON 已格式化", "ok");
  });
  els.btnMinifyJson.addEventListener("click", () => {
    if (formatJson(0)) setPill(els.status, "JSON 已压缩", "ok");
  });
  els.btnCopyJson.addEventListener("click", () => {
    copyText(els.payload.value)
      .then(() => setPill(els.status, "JSON 已复制", "ok"))
      .catch(() => setPill(els.status, "复制失败", "err"));
  });
  els.btnSend.addEventListener("click", sendNow);
  els.btnResend.addEventListener("click", resendLast);
  els.btnClearLog.addEventListener("click", () => {
    els.responseMeta.textContent = "等待操作";
    els.responseBody.textContent = "等待操作...";
    els.responseJson.textContent = "无";
    recentHistory = [];
    window.localStorage.removeItem(STORAGE_HISTORY);
    renderHistory();
    setPill(els.status, "记录已清空", "ok");
  });
  els.subCount.addEventListener("change", fillSample);
  els.nodeId.addEventListener("change", fillSample);

  initDefaults();
  setPill(els.status, "就绪", "ok");
})();
