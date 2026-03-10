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

if (elStatOnline && elNodeStatusGrid) {
  const fetchJson = async (url) => {
    const resp = await fetch(url, { method: "GET" });
    const ct = (resp.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/json")) {
      throw new Error("Expected JSON response");
    }
    return resp.json();
  };

  const setText = (el, value, fallback = "--") => {
    if (!el) return;
    el.textContent = value === undefined || value === null || value === "" ? fallback : String(value);
  };

  const renderNodes = (nodes) => {
    const onlyOnline = !!(elOnlyOnlineSwitch && elOnlyOnlineSwitch.checked);
    const list = Array.isArray(nodes) ? nodes : [];
    const visible = onlyOnline ? list.filter((node) => !!node.online) : list;

    if (visible.length === 0) {
      elNodeStatusGrid.innerHTML = "";
      elNodeStatusEmpty.classList.remove("d-none");
      return;
    }

    elNodeStatusEmpty.classList.add("d-none");
    elNodeStatusGrid.innerHTML = visible
      .map((node) => {
        const badgeClass = node.online ? "text-bg-success" : "text-bg-secondary";
        return `
          <div class="col">
            <button class="card h-100 text-start border-0 shadow-sm w-100" data-node-id="${node.node_id}">
              <div class="card-body">
                <div class="d-flex justify-content-between align-items-start mb-2">
                  <div>
                    <div class="fw-bold">${node.node_id}</div>
                    <div class="small text-muted">${node.turbine_count || 0} 台风机</div>
                    <div class="small text-muted">${node.last_upload || "暂无上报"}</div>
                  </div>
                  <span class="badge ${badgeClass}">${node.online ? "在线" : "离线"}</span>
                </div>
                <div class="small text-muted">点击进入实时监测</div>
              </div>
            </button>
          </div>
        `;
      })
      .join("");

    elNodeStatusGrid.querySelectorAll("[data-node-id]").forEach((card) => {
      card.addEventListener("click", () => {
        const nodeId = card.dataset.nodeId || "";
        if (!nodeId) return;
        window.localStorage.setItem("selectedNodeId", nodeId);
        window.location.href = "/monitor";
      });
    });
  };

  const loadStats = async () => {
    const stats = await fetchJson("/api/dashboard/stats");
    setText(elStatOnline, stats.online_nodes ?? 0);
    setText(elStatTotal, stats.total_nodes ?? 0);
    setText(elStat24h, stats.records_24h ?? 0);
    setText(elStatLatest, stats.latest_upload || "--");
    setText(elStatRecords, stats.total_records ?? 0);
    setText(elStatDb, typeof stats.database_size_mb === "number" ? stats.database_size_mb.toFixed(2) : "0.00");
    setText(elStatTimeout, stats.node_timeout_sec ?? "--");
  };

  const loadNodes = async () => {
    const result = await fetchJson("/api/nodes");
    renderNodes(result.nodes || []);
  };

  const refresh = async () => {
    try {
      await Promise.all([loadStats(), loadNodes()]);
    } catch (error) {
      console.error("[system_overview] refresh failed", error);
    }
  };

  if (elOnlyOnlineSwitch) {
    elOnlyOnlineSwitch.addEventListener("change", refresh);
  }
  if (elBtnRefreshNodes) {
    elBtnRefreshNodes.addEventListener("click", refresh);
  }

  refresh();
  window.setInterval(refresh, 3000);
}
