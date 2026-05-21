(() => {
  const elStatOnline = document.getElementById("stat-online");
  const elStatTotal = document.getElementById("stat-total");
  const elStat24h = document.getElementById("stat-24h");
  const elStatLatest = document.getElementById("stat-latest");
  const elStatRecords = document.getElementById("stat-records");
  const elStatDb = document.getElementById("stat-db");
  const elStatTimeout = document.getElementById("stat-timeout");
  const elOnlyOnlineSwitch = document.getElementById("onlyOnlineSwitch");
  const elBtnRefreshNodes = document.getElementById("btnRefreshNodes");
  const elNodeStatusGrid = document.getElementById("nodeStatusGrid");
  const elNodeStatusEmpty = document.getElementById("nodeStatusEmpty");

  if (!elStatOnline || !elNodeStatusGrid) {
    return;
  }

  const nodeMapConfig = window.WindSightNodeMapConfig || { defaults: {}, nodes: {} };

  async function fetchJson(url) {
    const response = await fetch(url, { method: "GET" });
    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("application/json")) {
      throw new Error("Expected JSON response");
    }
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error || result.message || `HTTP ${response.status}`);
    }
    return result;
  }

  function setText(element, value, fallback = "--") {
    if (!element) {
      return;
    }
    element.textContent = value === undefined || value === null || value === "" ? fallback : String(value);
  }

  function getNodeStatus(node) {
    if (node && (node.fault || node.status === "fault" || node.health === "fault")) {
      return "fault";
    }
    return node && node.online ? "online" : "offline";
  }

  function getNodeMeta(node) {
    const nodeId = node?.node_id || "";
    const defaults = nodeMapConfig.defaults || {};
    const preset = (nodeMapConfig.nodes || {})[nodeId] || {};
    const registeredName = String(node?.display_name || "").trim();
    const geoConfigured = !!(node?.geo_configured || node?.geo);
    return {
      displayName: registeredName || preset.displayName || nodeId,
      zoneLabel: geoConfigured ? "已定位区域" : (defaults.zoneLabel || "未标定区域"),
      description: preset.description || defaults.description || "风场节点",
    };
  }

  function statusLabel(status) {
    if (status === "fault") return "故障";
    if (status === "online") return "在线";
    return "离线";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatUploadTime(value) {
    if (!value) {
      return "--";
    }
    const raw = String(value);
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
      return raw;
    }
    const pad = (number) => String(number).padStart(2, "0");
    return [
      `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`,
      `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`,
    ].join(" ");
  }

  function renderNodeRow(node) {
    const nodeId = node.node_id || "";
    const meta = getNodeMeta(node);
    const status = getNodeStatus(node);
    const statusText = statusLabel(status);
    const turbineCount = Number.isFinite(Number(node.turbine_count)) ? Number(node.turbine_count) : 0;
    const lastUpload = formatUploadTime(node.last_upload);
    const ownerText = node.owner_username ? ` · ${node.owner_username}` : "";
    const idLine = meta.displayName && meta.displayName !== nodeId ? `<small>${escapeHtml(nodeId)}</small>` : "";

    return `
      <button class="node-status-row status-${status}" type="button" data-node-id="${escapeHtml(nodeId)}">
        <span class="node-status-main">
          <strong>${escapeHtml(meta.displayName)}</strong>
          ${idLine}
        </span>
        <span class="node-status-zone">${escapeHtml(meta.zoneLabel)}${escapeHtml(ownerText)}</span>
        <span class="node-status-pill ${status}">
          <span class="state-dot ${status === "online" ? "is-online" : status === "fault" ? "is-fault" : ""}"></span>
          ${statusText}
        </span>
        <span class="node-status-number">${turbineCount}<small> 台</small></span>
        <span class="node-status-time">${escapeHtml(lastUpload)}</span>
        <span class="node-status-action">进入实时监测</span>
      </button>
    `;
  }

  function renderNodes(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    const onlyOnline = !!(elOnlyOnlineSwitch && elOnlyOnlineSwitch.checked);
    const visibleNodes = onlyOnline ? list.filter((node) => !!node.online) : list;

    if (visibleNodes.length === 0) {
      elNodeStatusGrid.innerHTML = "";
      elNodeStatusEmpty.textContent = onlyOnline ? "暂无在线节点" : "暂无可展示节点";
      elNodeStatusEmpty.classList.remove("d-none");
      return;
    }

    elNodeStatusEmpty.classList.add("d-none");
    elNodeStatusGrid.innerHTML = `
      <div class="node-status-table-head" aria-hidden="true">
        <span>节点</span>
        <span>区域 / 归属</span>
        <span>状态</span>
        <span>风机</span>
        <span>最近上报</span>
        <span>操作</span>
      </div>
      ${visibleNodes.map(renderNodeRow).join("")}
    `;

    elNodeStatusGrid.querySelectorAll("[data-node-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const nodeId = button.dataset.nodeId || "";
        if (!nodeId) {
          return;
        }
        window.localStorage.setItem("selectedNodeId", nodeId);
        window.location.href = "/monitor";
      });
    });
  }

  async function loadStats() {
    const stats = await fetchJson("/api/dashboard/stats");
    setText(elStatOnline, stats.online_nodes ?? 0);
    setText(elStatTotal, stats.total_nodes ?? 0);
    setText(elStat24h, stats.records_24h ?? 0);
    setText(elStatLatest, stats.latest_upload ? formatUploadTime(stats.latest_upload) : "--");
    setText(elStatRecords, stats.total_records ?? 0);
    setText(elStatDb, typeof stats.database_size_mb === "number" ? stats.database_size_mb.toFixed(2) : "0.00");
    setText(elStatTimeout, stats.node_timeout_sec ?? "--");
  }

  async function loadNodes() {
    const result = await fetchJson("/api/nodes");
    renderNodes(result.nodes || []);
  }

  async function refresh() {
    try {
      await Promise.all([loadStats(), loadNodes()]);
    } catch (error) {
      console.error("[system_overview] refresh failed", error);
    }
  }

  if (elOnlyOnlineSwitch) {
    elOnlyOnlineSwitch.addEventListener("change", refresh);
  }
  if (elBtnRefreshNodes) {
    elBtnRefreshNodes.addEventListener("click", refresh);
  }

  refresh();
  window.setInterval(refresh, 3000);
})();
