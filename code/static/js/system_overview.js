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

  function getNodeMeta(nodeId) {
    const defaults = nodeMapConfig.defaults || {};
    const preset = (nodeMapConfig.nodes || {})[nodeId] || {};
    return {
      displayName: preset.displayName || nodeId,
      zoneLabel: preset.zoneLabel || defaults.zoneLabel || "未标定区域",
      description: preset.description || defaults.description || "风场节点",
    };
  }

  function statusLabel(status) {
    if (status === "fault") return "故障";
    if (status === "online") return "在线";
    return "离线";
  }

  function renderNodes(nodes) {
    const list = Array.isArray(nodes) ? nodes : [];
    const onlyOnline = !!(elOnlyOnlineSwitch && elOnlyOnlineSwitch.checked);
    const visibleNodes = onlyOnline ? list.filter((node) => !!node.online) : list;

    if (visibleNodes.length === 0) {
      elNodeStatusGrid.innerHTML = "";
      elNodeStatusEmpty.classList.remove("d-none");
      return;
    }

    elNodeStatusEmpty.classList.add("d-none");
    elNodeStatusGrid.innerHTML = visibleNodes
      .map((node) => {
        const meta = getNodeMeta(node.node_id);
        const status = getNodeStatus(node);
        return `
          <button class="node-matrix-card status-${status}" type="button" data-node-id="${node.node_id}">
            <div class="node-matrix-head">
              <div>
                <div class="node-matrix-title">${meta.displayName}</div>
                <div class="node-matrix-zone">${meta.zoneLabel} · ${node.node_id}</div>
              </div>
              <span class="node-matrix-badge ${status}">
                <span class="state-dot ${status === "online" ? "is-online" : status === "fault" ? "is-fault" : ""}"></span>
                ${statusLabel(status)}
              </span>
            </div>
            <div class="node-matrix-metrics">
              <div class="node-matrix-metric">
                <span class="node-metric-label">风机数量</span>
                <span class="node-metric-value">${node.turbine_count || 0}</span>
              </div>
              <div class="node-matrix-metric">
                <span class="node-metric-label">最近上报</span>
                <span class="node-metric-value">${node.last_upload || "--"}</span>
              </div>
              <div class="node-matrix-metric">
                <span class="node-metric-label">节点状态</span>
                <span class="node-metric-value">${statusLabel(status)}</span>
              </div>
              <div class="node-matrix-metric">
                <span class="node-metric-label">动作</span>
                <span class="node-metric-value">进入实时监测</span>
              </div>
            </div>
          </button>
        `;
      })
      .join("");

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
    setText(elStatLatest, stats.latest_upload || "--");
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
