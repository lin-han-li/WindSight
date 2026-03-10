(() => {
  const elNodeList = document.getElementById("nodeList");
  const elNodeSelect = document.getElementById("nodeSelect");
  const elHistoryLimit = document.getElementById("historyLimit");
  const elHistoryStart = document.getElementById("historyStart");
  const elHistoryEnd = document.getElementById("historyEnd");
  const elBtnReload = document.getElementById("btnReload");
  const elBtnSelectAll = document.getElementById("btnSelectAll");
  const elBtnSelectNone = document.getElementById("btnSelectNone");
  const elBtnClearRange = document.getElementById("btnClearRange");
  const elTurbineGrid = document.getElementById("turbineCheckboxGrid");
  const elSelectedCount = document.getElementById("selectedCount");
  const elLastDataTime = document.getElementById("lastDataTime");
  const elMainChart = document.getElementById("mainChart");

  if (!elNodeSelect || !elTurbineGrid || !elMainChart) {
    return;
  }

  const isMonitorPage = !!elNodeList;
  const socket = typeof io === "function" ? io() : null;
  const chart = echarts.init(elMainChart);
  const pollIntervalMs = 3000;
  const defaultLimit = 600;
  const maxLimit = 20000;
  const metrics = [
    { key: "voltage", label: "电压", unit: "V", color: "#2563eb" },
    { key: "current", label: "电流", unit: "A", color: "#0891b2" },
    { key: "speed", label: "转速", unit: "rpm", color: "#ca8a04" },
    { key: "temperature", label: "温度", unit: "C", color: "#dc2626" },
  ];

  const state = {
    nodes: [],
    nodeMap: new Map(),
    selectedNodeId: "",
    selectedTurbines: new Set(),
    uploads: [],
    uploadIds: new Set(),
    activeMetric: window.localStorage.getItem("windsight:metric") || "voltage",
    pollTimer: null,
  };

  function fetchJson(url) {
    return fetch(url, { method: "GET" }).then(async (resp) => {
      const ct = (resp.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("application/json")) {
        throw new Error("Expected JSON response");
      }
      const data = await resp.json();
      if (!resp.ok) {
        throw new Error(data.error || data.message || `HTTP ${resp.status}`);
      }
      return data;
    });
  }

  function setMetric(metricKey) {
    state.activeMetric = metricKey;
    window.localStorage.setItem("windsight:metric", metricKey);
    document.querySelectorAll("[data-metric-card]").forEach((card) => {
      card.classList.toggle("metric-card-active", card.dataset.metricCard === metricKey);
    });
    renderChart();
  }

  function formatMetricValue(value) {
    if (value === undefined || value === null || Number.isNaN(Number(value))) {
      return "--";
    }
    return Number(value).toFixed(2);
  }

  function updateMetricCards() {
    const latestRow = state.uploads[state.uploads.length - 1] || null;
    const firstSelectedCode =
      Array.from(state.selectedTurbines)[0] ||
      (latestRow ? Object.keys(latestRow.turbines || {})[0] : null);

    metrics.forEach((metric) => {
      const elValue = document.getElementById(`cardValue-${metric.key}`);
      const elHint = document.getElementById(`cardHint-${metric.key}`);
      let value = null;
      if (latestRow && firstSelectedCode && latestRow.turbines && latestRow.turbines[firstSelectedCode]) {
        value = latestRow.turbines[firstSelectedCode][metric.key];
      }
      if (elValue) {
        elValue.textContent = formatMetricValue(value);
      }
      if (elHint) {
        elHint.textContent = firstSelectedCode ? `风机 ${firstSelectedCode}` : "暂无数据";
      }
    });
  }

  function updateSelectedCount() {
    if (elSelectedCount) {
      elSelectedCount.textContent = String(state.selectedTurbines.size);
    }
  }

  function normalizeTurbineCodes(codes) {
    return Array.from(new Set((codes || []).map((code) => String(code)))).sort();
  }

  function availableTurbineCodes() {
    const nodeMeta = state.nodeMap.get(state.selectedNodeId);
    if (nodeMeta && Array.isArray(nodeMeta.turbines) && nodeMeta.turbines.length > 0) {
      return normalizeTurbineCodes(nodeMeta.turbines);
    }
    const latestRow = state.uploads[state.uploads.length - 1];
    if (!latestRow || !latestRow.turbines) {
      return [];
    }
    return normalizeTurbineCodes(Object.keys(latestRow.turbines));
  }

  function ensureTurbineSelection(codes) {
    const codeSet = new Set(codes);
    state.selectedTurbines = new Set(Array.from(state.selectedTurbines).filter((code) => codeSet.has(code)));
    if (state.selectedTurbines.size === 0 && codes.length > 0) {
      state.selectedTurbines.add(codes[0]);
    }
  }

  function renderTurbineGrid() {
    const codes = availableTurbineCodes();
    ensureTurbineSelection(codes);
    if (codes.length === 0) {
      elTurbineGrid.innerHTML = '<div class="text-muted small">选择节点后显示风机列表</div>';
      updateSelectedCount();
      return;
    }

    elTurbineGrid.innerHTML = codes
      .map(
        (code) => `
          <div class="col-6 col-md-4 col-xl-3">
            <label class="form-check w-100 border rounded-3 px-3 py-2 turbine-check">
              <input class="form-check-input me-2" type="checkbox" value="${code}" ${
          state.selectedTurbines.has(code) ? "checked" : ""
        }>
              <span class="form-check-label">风机 ${code}</span>
            </label>
          </div>
        `
      )
      .join("");

    elTurbineGrid.querySelectorAll("input[type='checkbox']").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) {
          state.selectedTurbines.add(input.value);
        } else {
          state.selectedTurbines.delete(input.value);
        }
        if (state.selectedTurbines.size === 0) {
          input.checked = true;
          state.selectedTurbines.add(input.value);
        }
        updateSelectedCount();
        renderChart();
      });
    });
    updateSelectedCount();
  }

  function renderNodeSelect() {
    if (state.nodes.length === 0) {
      elNodeSelect.innerHTML = '<option value="">暂无节点</option>';
      return;
    }

    const options = ['<option value="">请选择节点...</option>'];
    state.nodes.forEach((node) => {
      const lastUpload = node.last_upload ? ` | ${node.last_upload}` : "";
      const suffix = `${node.turbine_count || 0} 台${lastUpload}`;
      options.push(`<option value="${node.node_id}">${node.node_id} | ${suffix}</option>`);
    });
    elNodeSelect.innerHTML = options.join("");
    if (state.selectedNodeId) {
      elNodeSelect.value = state.selectedNodeId;
    }
  }

  function renderNodeList() {
    if (!elNodeList) {
      return;
    }

    if (state.nodes.length === 0) {
      elNodeList.innerHTML = '<div class="text-center text-muted py-4">暂无节点</div>';
      return;
    }

    elNodeList.innerHTML = state.nodes
      .map((node) => {
        const active = node.node_id === state.selectedNodeId ? "active" : "";
        const badgeClass = node.online ? "text-bg-success" : "text-bg-secondary";
        return `
          <button class="list-group-item list-group-item-action ${active}" data-node-id="${node.node_id}">
            <div class="d-flex justify-content-between align-items-start">
              <div class="text-start">
                <div class="fw-bold">${node.node_id}</div>
                <div class="small text-muted">${node.turbine_count || 0} 台风机</div>
                <div class="small text-muted">${node.last_upload || "暂无上报"}</div>
              </div>
              <span class="badge ${badgeClass}">${node.online ? "在线" : "离线"}</span>
            </div>
          </button>
        `;
      })
      .join("");

    elNodeList.querySelectorAll("[data-node-id]").forEach((button) => {
      button.addEventListener("click", () => {
        setSelectedNode(button.dataset.nodeId || "");
      });
    });
  }

  function updateNodeMetaFromRow(row) {
    if (!row || !row.node_id) {
      return;
    }

    const turbines = normalizeTurbineCodes(Object.keys(row.turbines || {}));
    const current = state.nodeMap.get(row.node_id) || {};
    const updated = {
      ...current,
      node_id: row.node_id,
      turbine_count: row.sub || turbines.length,
      turbines,
      last_upload: row.timestamp || current.last_upload || null,
    };
    state.nodeMap.set(row.node_id, updated);
    state.nodes = state.nodes.map((node) => (node.node_id === row.node_id ? { ...node, ...updated } : node));
  }

  function xAxisLabels() {
    return state.uploads.map((row) => row.timestamp || "");
  }

  function seriesForMetric(metricKey) {
    return Array.from(state.selectedTurbines)
      .sort()
      .map((code, index) => ({
        name: `风机 ${code}`,
        type: "line",
        showSymbol: false,
        smooth: false,
        emphasis: { focus: "series" },
        lineStyle: { width: 2 },
        data: state.uploads.map((row) => {
          const turbine = row.turbines ? row.turbines[code] : null;
          return turbine ? turbine[metricKey] : null;
        }),
      }));
  }

  function renderChart() {
    updateMetricCards();
    renderTurbineGrid();

    const activeMetric = metrics.find((metric) => metric.key === state.activeMetric) || metrics[0];
    const times = xAxisLabels();
    const series = seriesForMetric(activeMetric.key);
    const latestRow = state.uploads[state.uploads.length - 1] || null;
    if (elLastDataTime) {
      elLastDataTime.textContent = latestRow ? latestRow.timestamp || "--" : "--";
    }

    chart.setOption(
      {
        animation: false,
        color: ["#2563eb", "#0891b2", "#ca8a04", "#dc2626", "#7c3aed", "#059669", "#ea580c", "#475569"],
        grid: { left: 60, right: 24, top: 60, bottom: 90 },
        legend: { top: 12 },
        tooltip: { trigger: "axis" },
        toolbox: {
          right: 12,
          feature: {
            dataZoom: { yAxisIndex: "none" },
            restore: {},
            saveAsImage: {},
          },
        },
        xAxis: {
          type: "category",
          data: times,
          boundaryGap: false,
          axisLabel: { hideOverlap: true },
        },
        yAxis: {
          type: "value",
          name: `${activeMetric.label} (${activeMetric.unit})`,
          scale: true,
        },
        dataZoom: [
          { type: "inside", xAxisIndex: 0, filterMode: "none" },
          { type: "slider", xAxisIndex: 0, bottom: 24, filterMode: "none" },
          { type: "inside", yAxisIndex: 0, filterMode: "none" },
        ],
        series,
        graphic:
          series.length === 0
            ? [
                {
                  type: "text",
                  left: "center",
                  top: "middle",
                  style: {
                    text: state.selectedNodeId ? "暂无可绘制数据" : "请选择节点",
                    fill: "#64748b",
                    fontSize: 16,
                  },
                },
              ]
            : [],
      },
      true
    );
  }

  function currentLimit() {
    const parsed = parseInt((elHistoryLimit && elHistoryLimit.value) || `${defaultLimit}`, 10);
    if (!Number.isFinite(parsed)) {
      return defaultLimit;
    }
    return Math.max(1, Math.min(maxLimit, parsed));
  }

  function queryUrl() {
    const params = new URLSearchParams();
    params.set("node_id", state.selectedNodeId);
    params.set("limit", String(currentLimit()));
    if (elHistoryStart && elHistoryStart.value) {
      params.set("start", elHistoryStart.value);
    }
    if (elHistoryEnd && elHistoryEnd.value) {
      params.set("end", elHistoryEnd.value);
    }
    return `/api/data?${params.toString()}`;
  }

  async function loadHistory() {
    if (!state.selectedNodeId) {
      state.uploads = [];
      state.uploadIds = new Set();
      renderChart();
      return;
    }

    const result = await fetchJson(queryUrl());
    const rows = Array.isArray(result.data) ? result.data : [];
    state.uploads = rows;
    state.uploadIds = new Set(rows.map((row) => row.upload_id));
    if (rows.length > 0) {
      updateNodeMetaFromRow(rows[rows.length - 1]);
    }
    renderChart();
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    if (!isMonitorPage || !state.selectedNodeId) {
      return;
    }
    state.pollTimer = window.setInterval(() => {
      loadHistory().catch((error) => console.error("[dashboard] poll failed", error));
    }, pollIntervalMs);
  }

  function trySubscribe(nodeId) {
    if (socket && nodeId) {
      socket.emit("subscribe_node", { node_id: nodeId });
    }
  }

  function tryUnsubscribe(nodeId) {
    if (socket && nodeId) {
      socket.emit("unsubscribe_node", { node_id: nodeId });
    }
  }

  function setSelectedNode(nodeId) {
    const nextId = String(nodeId || "").trim();
    if (nextId === state.selectedNodeId) {
      return;
    }

    if (state.selectedNodeId) {
      tryUnsubscribe(state.selectedNodeId);
    }

    state.selectedNodeId = nextId;
    state.uploads = [];
    state.uploadIds = new Set();
    state.selectedTurbines = new Set();
    window.localStorage.setItem("selectedNodeId", nextId);
    renderNodeSelect();
    renderNodeList();
    renderChart();

    if (nextId) {
      trySubscribe(nextId);
      loadHistory().catch((error) => console.error("[dashboard] load failed", error));
    }
    startPolling();
  }

  function appendRealtimeRow(row) {
    if (!row || row.node_id !== state.selectedNodeId || state.uploadIds.has(row.upload_id)) {
      return;
    }
    updateNodeMetaFromRow(row);
    state.uploads.push(row);
    state.uploadIds.add(row.upload_id);
    const limit = currentLimit();
    if (state.uploads.length > limit) {
      state.uploads = state.uploads.slice(-limit);
      state.uploadIds = new Set(state.uploads.map((item) => item.upload_id));
    }
    renderChart();
  }

  async function loadNodes() {
    const result = await fetchJson("/api/nodes");
    state.nodes = Array.isArray(result.nodes) ? result.nodes : [];
    state.nodeMap = new Map(state.nodes.map((node) => [node.node_id, node]));
    renderNodeSelect();
    renderNodeList();

    if (!state.selectedNodeId) {
      const fromQuery = new URLSearchParams(window.location.search).get("select");
      const fromStorage = window.localStorage.getItem("selectedNodeId");
      const candidate = fromQuery || fromStorage || (state.nodes[0] && state.nodes[0].node_id) || "";
      if (candidate && state.nodeMap.has(candidate)) {
        setSelectedNode(candidate);
      }
    } else {
      renderChart();
    }
  }

  function setAllTurbines(selected) {
    const codes = availableTurbineCodes();
    state.selectedTurbines = selected ? new Set(codes) : new Set(codes.slice(0, 1));
    renderChart();
  }

  function formatDateTimeLocal(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
      date.getMinutes()
    )}`;
  }

  function applyQuickRange(minutes) {
    if (!elHistoryStart || !elHistoryEnd) {
      return;
    }
    const now = new Date();
    const start = new Date(now.getTime() - Number(minutes) * 60 * 1000);
    elHistoryStart.value = formatDateTimeLocal(start);
    elHistoryEnd.value = formatDateTimeLocal(now);
    loadHistory().catch((error) => console.error("[dashboard] quick range failed", error));
  }

  function bindEvents() {
    elNodeSelect.addEventListener("change", () => setSelectedNode(elNodeSelect.value));
    if (elBtnReload) {
      elBtnReload.addEventListener("click", () => {
        loadHistory().catch((error) => console.error("[dashboard] reload failed", error));
      });
    }
    if (elBtnSelectAll) {
      elBtnSelectAll.addEventListener("click", () => setAllTurbines(true));
    }
    if (elBtnSelectNone) {
      elBtnSelectNone.addEventListener("click", () => setAllTurbines(false));
    }
    if (elBtnClearRange) {
      elBtnClearRange.addEventListener("click", () => {
        if (elHistoryStart) elHistoryStart.value = "";
        if (elHistoryEnd) elHistoryEnd.value = "";
        loadHistory().catch((error) => console.error("[dashboard] clear range failed", error));
      });
    }
    if (elHistoryStart) {
      elHistoryStart.addEventListener("change", () => {
        loadHistory().catch((error) => console.error("[dashboard] start change failed", error));
      });
    }
    if (elHistoryEnd) {
      elHistoryEnd.addEventListener("change", () => {
        loadHistory().catch((error) => console.error("[dashboard] end change failed", error));
      });
    }
    if (elHistoryLimit) {
      elHistoryLimit.addEventListener("change", () => {
        elHistoryLimit.value = String(currentLimit());
        loadHistory().catch((error) => console.error("[dashboard] limit change failed", error));
      });
    }
    document.querySelectorAll("[data-range-min]").forEach((button) => {
      button.addEventListener("click", () => applyQuickRange(button.dataset.rangeMin));
    });
    document.querySelectorAll("[data-metric-card]").forEach((card) => {
      card.addEventListener("click", () => setMetric(card.dataset.metricCard));
    });
    window.addEventListener("resize", () => chart.resize());
  }

  function bindSocket() {
    if (!socket) {
      return;
    }
    socket.on("connect", () => {
      if (state.selectedNodeId) {
        trySubscribe(state.selectedNodeId);
      }
    });
    const handler = (message) => {
      if (!isMonitorPage) {
        return;
      }
      appendRealtimeRow(message && message.data);
    };
    socket.on("monitor_update", handler);
    socket.on("node_data_update", handler);
  }

  bindEvents();
  bindSocket();
  setMetric(state.activeMetric);
  loadNodes().catch((error) => console.error("[dashboard] init failed", error));
})();
