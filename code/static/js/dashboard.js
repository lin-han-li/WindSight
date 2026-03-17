(() => {
  const root = document.getElementById("dashboardPage");
  if (!root) {
    return;
  }

  const pageKind = root.dataset.pageKind || "overview";
  const isMonitorPage = pageKind === "monitor";
  const isOverviewPage = pageKind === "overview";
  const usesDrilldownView = isMonitorPage || isOverviewPage;
  const storageNodeKey = "selectedNodeId";
  const storageTurbineKey = "selectedTurbineCode";
  const pollIntervalMs = 3000;
  const defaultLimit = 600;
  const maxLimit = 20000;
  const chartGroup = `windsight-${pageKind}-metrics`;
  const nodeMapConfig = window.WindSightNodeMapConfig || { defaults: {}, nodes: {} };
  const socket = isMonitorPage && typeof io === "function" ? io() : null;

  const metrics = [
    { key: "voltage", label: "电压", unit: "V", color: "#2f6fed", elementId: "chartVoltage" },
    { key: "current", label: "电流", unit: "A", color: "#19b8d6", elementId: "chartCurrent" },
    { key: "speed", label: "转速", unit: "rpm", color: "#f59e0b", elementId: "chartSpeed" },
    { key: "temperature", label: "温度", unit: "°C", color: "#ef4444", elementId: "chartTemperature" },
  ];

  const state = {
    nodes: [],
    nodeMap: new Map(),
    selectedNodeId: "",
    selectedTurbineCode: window.localStorage.getItem(storageTurbineKey) || "",
    uploads: [],
    uploadIds: new Set(),
    pollTimer: null,
    view: usesDrilldownView ? "map" : "detail",
  };

  const dom = {
    nodeMapSummary: document.getElementById("nodeMapSummary"),
    nodeMapChart: document.getElementById("nodeMapChart"),
    nodeMapFallback: document.getElementById("nodeMapFallback"),
    turbineTree: document.getElementById("turbineTree"),
    detailPlaceholder: document.getElementById("detailPlaceholder"),
    detailCharts: document.getElementById("detailCharts"),
    btnReload: document.getElementById("btnReload"),
    historyLimit: document.getElementById("historyLimit"),
    historyStart: document.getElementById("historyStart"),
    historyEnd: document.getElementById("historyEnd"),
    btnClearRange: document.getElementById("btnClearRange"),
    mapView: document.getElementById("map-view"),
    detailView: document.getElementById("detail-view"),
    btnBackToMap: document.getElementById("btnBackToMap"),
    lastDataTime: document.getElementById("lastDataTime"),
    topbarNodeChip: document.getElementById("topbarNodeChip"),
    topbarStatusChip: document.getElementById("topbarStatusChip"),
  };

  const chartStore = {
    map: dom.nodeMapChart ? echarts.init(dom.nodeMapChart) : null,
    metrics: new Map(),
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value, fallback = "--") {
    const element = typeof id === "string" ? byId(id) : id;
    if (!element) {
      return;
    }
    element.textContent = value === undefined || value === null || value === "" ? fallback : String(value);
  }

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

  function sortNodes(nodes) {
    return [...nodes].sort((a, b) => String(a.node_id || "").localeCompare(String(b.node_id || ""), "zh-Hans-CN"));
  }

  function normalizeTurbines(turbines) {
    return Array.from(new Set((turbines || []).map((item) => String(item).trim()).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b)
    );
  }

  function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatValue(value) {
    const number = safeNumber(value);
    return number === null ? "--" : number.toFixed(2);
  }

  function currentLimit() {
    const raw = parseInt((dom.historyLimit && dom.historyLimit.value) || `${defaultLimit}`, 10);
    if (!Number.isFinite(raw)) {
      return defaultLimit;
    }
    return Math.max(1, Math.min(maxLimit, raw));
  }

  function getRowKey(row) {
    return String(row?.upload_id || `${row?.node_id || ""}-${row?.timestamp || ""}`);
  }

  function getNodeStatus(node) {
    if (node && (node.fault || node.status === "fault" || node.health === "fault")) {
      return "fault";
    }
    return node && node.online ? "online" : "offline";
  }

  function getStatusColor(status) {
    if (status === "fault") return "#ef4444";
    if (status === "online") return "#2f6fed";
    return "#6b7280";
  }

  function getNodeVisualColor(node) {
    if (node.status === "fault") {
      return "#ef4444";
    }
    if (node.status === "online") {
      return node.accentColor || "#2f6fed";
    }
    return "#94a3b8";
  }

  function getStatusLabel(status) {
    if (status === "fault") return "故障";
    if (status === "online") return "在线";
    return "离线";
  }

  function getNodeRecord(nodeId) {
    return state.nodeMap.get(nodeId) || null;
  }

  function resolveNodeMeta(nodeOrId) {
    const node = typeof nodeOrId === "string" ? getNodeRecord(nodeOrId) || { node_id: nodeOrId } : nodeOrId || {};
    const nodeId = node.node_id || "";
    const defaults = nodeMapConfig.defaults || {};
    const preset = (nodeMapConfig.nodes || {})[nodeId] || {};
    const turbines = normalizeTurbines(node.turbines || []);
    return {
      nodeId,
      displayName: preset.displayName || node.node_id || "未命名节点",
      zoneLabel: preset.zoneLabel || defaults.zoneLabel || "未标定区域",
      description: preset.description || defaults.description || "风场边缘采集节点",
      mapX: preset.mapX,
      mapY: preset.mapY,
      accentColor: preset.accentColor || defaults.accentColor || "#2f6fed",
      status: getNodeStatus(node),
      online: !!node.online,
      lastUpload: node.last_upload || "",
      turbineCount: node.turbine_count || turbines.length || 0,
      turbines,
    };
  }

  function persistSelection() {
    window.localStorage.setItem(storageNodeKey, state.selectedNodeId || "");
    window.localStorage.setItem(storageTurbineKey, state.selectedTurbineCode || "");
  }

  function clearUploads() {
    state.uploads = [];
    state.uploadIds = new Set();
  }

  function upsertNode(nodePatch) {
    if (!nodePatch || !nodePatch.node_id) {
      return;
    }
    const current = state.nodeMap.get(nodePatch.node_id) || {};
    const merged = {
      ...current,
      ...nodePatch,
      turbines: normalizeTurbines(nodePatch.turbines || current.turbines || []),
    };
    if (!merged.turbine_count) {
      merged.turbine_count = merged.turbines.length;
    }
    state.nodeMap.set(merged.node_id, merged);
    const exists = state.nodes.some((node) => node.node_id === merged.node_id);
    state.nodes = exists
      ? state.nodes.map((node) => (node.node_id === merged.node_id ? merged : node))
      : [...state.nodes, merged];
    state.nodes = sortNodes(state.nodes);
  }

  function updateNodeFromRow(row) {
    if (!row || !row.node_id) {
      return;
    }
    upsertNode({
      node_id: row.node_id,
      online: true,
      last_upload: row.timestamp || "",
      turbines: Object.keys(row.turbines || {}),
      turbine_count: Object.keys(row.turbines || {}).length,
    });
  }

  function availableTurbines(nodeId = state.selectedNodeId) {
    const node = getNodeRecord(nodeId);
    if (node && normalizeTurbines(node.turbines || []).length > 0) {
      return normalizeTurbines(node.turbines || []);
    }
    for (let index = state.uploads.length - 1; index >= 0; index -= 1) {
      const row = state.uploads[index];
      if (row && row.node_id === nodeId) {
        return normalizeTurbines(Object.keys(row.turbines || {}));
      }
    }
    return [];
  }

  function latestSnapshotForCode(turbineCode = state.selectedTurbineCode) {
    if (!turbineCode) {
      return null;
    }
    for (let index = state.uploads.length - 1; index >= 0; index -= 1) {
      const row = state.uploads[index];
      const turbine = row?.turbines?.[turbineCode];
      if (turbine) {
        return { row, turbine };
      }
    }
    return null;
  }

  function renderMapSummary() {
    if (!dom.nodeMapSummary) {
      return;
    }
    const total = state.nodes.length;
    const online = state.nodes.filter((node) => getNodeStatus(node) === "online").length;
    const fault = state.nodes.filter((node) => getNodeStatus(node) === "fault").length;
    const configured = state.nodes.filter((node) => Number.isFinite(resolveNodeMeta(node).mapX)).length;
    const chips = [
      { label: "总节点", value: total },
      { label: "在线", value: online },
      { label: "故障", value: fault },
      { label: "已布图", value: configured },
    ];
    dom.nodeMapSummary.innerHTML = chips
      .map((chip) => `<span class="map-summary-chip"><strong>${chip.value}</strong><span>${chip.label}</span></span>`)
      .join("");
  }

  function renderFallbackNodes(list) {
    if (!dom.nodeMapFallback) {
      return;
    }
    if (!list.length) {
      dom.nodeMapFallback.innerHTML = '<div class="text-muted small">暂无未配置节点</div>';
      return;
    }
    dom.nodeMapFallback.innerHTML = list
      .map((node) => {
        const selectedClass = node.nodeId === state.selectedNodeId ? "is-selected" : "";
        return `
          <button class="fallback-node ${selectedClass}" type="button" data-node-id="${node.nodeId}">
            <div>
              <div class="fw-bold">${node.displayName}</div>
              <div class="small text-muted">${node.nodeId} · ${node.zoneLabel}</div>
            </div>
            <span class="small">${getStatusLabel(node.status)}</span>
          </button>
        `;
      })
      .join("");

    dom.nodeMapFallback.querySelectorAll("[data-node-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const nodeId = button.dataset.nodeId || "";
        if (usesDrilldownView) {
          jumpToDetail(nodeId);
        } else {
          selectNode(nodeId, { clearTurbine: true, loadAfterSelect: false }).catch((error) =>
            console.error("[dashboard] select node failed", error)
          );
        }
      });
    });
  }

  function renderMapChart() {
    if (!chartStore.map) {
      return;
    }

    const configuredNodes = [];
    const fallbackNodes = [];
    state.nodes.forEach((node) => {
      const meta = resolveNodeMeta(node);
      if (Number.isFinite(meta.mapX) && Number.isFinite(meta.mapY)) {
        configuredNodes.push(meta);
      } else {
        fallbackNodes.push(meta);
      }
    });

    renderFallbackNodes(fallbackNodes);

    chartStore.map.setOption(
      {
        backgroundColor: "transparent",
        animationDuration: 400,
        tooltip: {
          trigger: "item",
          backgroundColor: "rgba(255, 255, 255, 0.98)",
          borderColor: "rgba(47, 111, 237, 0.14)",
          borderWidth: 1,
          textStyle: {
            color: "#24364f",
          },
          extraCssText: "box-shadow: 0 16px 28px rgba(116, 142, 172, 0.18); border-radius: 14px;",
          formatter(params) {
            const data = params.data || {};
            return `
              <div style="min-width:180px;color:#24364f;">
                <div style="font-weight:700;margin-bottom:6px;">${data.displayName || data.nodeId}</div>
                <div>节点编号：${data.nodeId || "--"}</div>
                <div>区域：${data.zoneLabel || "--"}</div>
                <div>状态：${data.statusLabel || "--"}</div>
                <div>发电机：${data.turbineCount || 0} 台</div>
              </div>
            `;
          },
        },
        grid: {
          left: 30,
          right: 30,
          top: 30,
          bottom: 30,
        },
        xAxis: {
          type: "value",
          min: 0,
          max: 100,
          show: false,
        },
        yAxis: {
          type: "value",
          min: 0,
          max: 100,
          inverse: true,
          show: false,
        },
        graphic: configuredNodes.length
          ? []
          : [
              {
                type: "text",
                left: "center",
                top: "middle",
                style: {
                  text: "暂无节点",
                  fill: "#71849b",
                  fontSize: 18,
                },
              },
            ],
        series: [
          {
            type: "effectScatter",
            coordinateSystem: "cartesian2d",
            rippleEffect: {
              scale: 4,
              brushType: "stroke",
            },
            symbolSize(_value, params) {
              return params?.data?.nodeId === state.selectedNodeId ? 28 : 20;
            },
            label: {
              show: true,
              position: "right",
              distance: 14,
              color: "#1f3552",
              fontWeight: 700,
              formatter(params) {
                return params.data?.displayName || params.data?.nodeId || "";
              },
            },
            itemStyle: {
              shadowBlur: 14,
              shadowColor: "rgba(47, 111, 237, 0.16)",
            },
            data: configuredNodes.map((node) => ({
              color: getNodeVisualColor(node),
              value: [node.mapX, node.mapY, node.turbineCount],
              nodeId: node.nodeId,
              displayName: node.displayName,
              zoneLabel: node.zoneLabel,
              turbineCount: node.turbineCount,
              statusLabel: getStatusLabel(node.status),
              itemStyle: {
                color: getNodeVisualColor(node),
                shadowColor: `${getNodeVisualColor(node)}55`,
              },
            })),
          },
        ],
      },
      true
    );

    chartStore.map.off("click");
    chartStore.map.on("click", (params) => {
      const nodeId = params?.data?.nodeId;
      if (!nodeId) {
        return;
      }
      if (usesDrilldownView) {
        jumpToDetail(nodeId);
      } else {
        selectNode(nodeId, { clearTurbine: true, loadAfterSelect: false }).catch((error) =>
          console.error("[dashboard] select node failed", error)
        );
      }
    });
  }

  function renderSelectionSummary() {
    const node = state.selectedNodeId ? resolveNodeMeta(state.selectedNodeId) : null;
    setText("selectedNodeLabel", node ? `${node.displayName} (${node.nodeId})` : "请选择地图节点");
    setText("selectedNodeZone", node ? node.zoneLabel : "--");
    setText("selectedNodeStatus", node ? getStatusLabel(node.status) : "--");
    setText("selectedNodeTime", node?.lastUpload || "--");
    setText("selectedNodeDescription", node ? node.description : "--");
    setText("selectedTurbineLabel", state.selectedTurbineCode ? `发电机 ${state.selectedTurbineCode}` : "请在左侧树中选择");
    setText(dom.topbarNodeChip, node ? node.displayName : "未选择节点");
    if (dom.topbarStatusChip) {
      setText(dom.topbarStatusChip, node ? `节点${getStatusLabel(node.status)}` : "等待接入");
    }
    setText(dom.lastDataTime, latestSnapshotForCode()?.row?.timestamp || state.uploads[state.uploads.length - 1]?.timestamp || "--");
  }

  function renderTurbineTree() {
    if (!dom.turbineTree) {
      return;
    }
    if (!state.selectedNodeId) {
      dom.turbineTree.innerHTML = '<div class="turbine-tree-empty">请先选择地图节点。</div>';
      return;
    }

    const node = resolveNodeMeta(state.selectedNodeId);
    const turbineCodes = availableTurbines();
    if (!turbineCodes.length) {
      dom.turbineTree.innerHTML = '<div class="turbine-tree-empty">当前节点没有可用的发电机清单。</div>';
      return;
    }

    dom.turbineTree.innerHTML = `
      <div class="tree-node-shell">
        <div class="tree-node-head">
          <div>
            <div class="tree-node-title">${node.displayName}</div>
            <div class="tree-node-subtitle">${node.zoneLabel} · ${node.nodeId}</div>
          </div>
          <div class="tree-node-count">${turbineCodes.length}</div>
        </div>
        <div class="tree-turbine-list">
          ${turbineCodes
            .map((code) => {
              const snapshot = latestSnapshotForCode(code);
              const selectedClass = code === state.selectedTurbineCode ? "is-selected" : "";
              const statusClass = snapshot ? "is-online" : node.online ? "is-warning" : "";
              const statusText = snapshot ? "有数据" : node.online ? "待数据" : "离线";
              return `
                <button class="tree-turbine ${selectedClass}" type="button" data-turbine-code="${code}">
                  <div class="tree-turbine-title">
                    <span class="tree-turbine-icon"><i class="bi bi-fan"></i></span>
                    <span class="tree-turbine-copy">
                      <span class="tree-turbine-name">发电机 ${code}</span>
                      <span class="tree-turbine-meta">点击后显示四图联动波形</span>
                    </span>
                  </div>
                  <span class="tree-turbine-status">
                    <span class="state-dot ${statusClass}"></span>
                    ${statusText}
                  </span>
                </button>
              `;
            })
            .join("")}
        </div>
      </div>
    `;

    dom.turbineTree.querySelectorAll("[data-turbine-code]").forEach((button) => {
      button.addEventListener("click", () => {
        selectTurbine(button.dataset.turbineCode || "").catch((error) =>
          console.error("[dashboard] select turbine failed", error)
        );
      });
    });
  }

  function renderMetricCards() {
    const snapshot = latestSnapshotForCode();
    const hint = state.selectedTurbineCode
      ? `${state.selectedNodeId || "--"} · 发电机 ${state.selectedTurbineCode}`
      : "等待选择发电机";
    metrics.forEach((metric) => {
      setText(`cardValue-${metric.key}`, snapshot ? formatValue(snapshot.turbine[metric.key]) : "--");
      setText(`cardHint-${metric.key}`, hint);
    });
  }

  function placeholderCopy(title, text, kicker = isMonitorPage ? "Realtime Drill" : "History Drill") {
    return `
      <div class="detail-placeholder-copy">
        <div class="panel-kicker">${kicker}</div>
        <div class="detail-placeholder-title">${title}</div>
        <div class="detail-placeholder-text">${text}</div>
      </div>
    `;
  }

  function getEmptyState() {
    if (!state.selectedNodeId) {
      return {
        title: "请先选择地图节点",
        text: isMonitorPage
          ? "从全局拓扑地图点击节点后，界面会切换到节点详情视图。"
          : "请先返回节点地图并点击目标节点，再进入树状列表选择发电机。",
      };
    }
    if (!state.selectedTurbineCode) {
      return {
        title: "请在左侧选择具体发电机",
        text: "选中发电机后，右侧才会显示电压、电流、转速、温度四张联动波形。",
      };
    }
    if (!state.uploads.length) {
      return {
        title: isMonitorPage ? "当前节点暂无实时数据" : "该时间范围内暂无历史数据",
        text: isMonitorPage ? "等待新的上传帧进入缓存，或尝试刷新缓存。" : "请调整开始时间、结束时间或回放帧数后重新查询。",
      };
    }
    if (!latestSnapshotForCode()) {
      return {
        title: "当前发电机缺少可绘制数据",
        text: "该发电机在当前帧范围内没有对应测量值，请切换时段或选择其他发电机。",
      };
    }
    return null;
  }

  function ensureMetricCharts() {
    metrics.forEach((metric) => {
      if (chartStore.metrics.has(metric.key)) {
        return;
      }
      const element = byId(metric.elementId);
      if (!element) {
        return;
      }
      const chart = echarts.init(element);
      chart.group = chartGroup;
      chartStore.metrics.set(metric.key, chart);
    });
    echarts.connect(chartGroup);
  }

  function buildMetricOption(metric, index) {
    const axisColor = "#6f8198";
    const times = state.uploads.map((row) => row.timestamp || "");
    const seriesData = state.uploads.map((row) => {
      const turbine = row?.turbines?.[state.selectedTurbineCode];
      const value = turbine ? turbine[metric.key] : null;
      return safeNumber(value);
    });

    return {
      animation: false,
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        backgroundColor: "rgba(255, 255, 255, 0.98)",
        borderColor: "rgba(47, 111, 237, 0.12)",
        borderWidth: 1,
        textStyle: {
          color: "#24364f",
        },
        extraCssText: "box-shadow: 0 14px 24px rgba(116, 142, 172, 0.16); border-radius: 12px;",
      },
      grid: {
        left: 48,
        right: 18,
        top: 36,
        bottom: index === metrics.length - 1 ? 48 : 24,
      },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: times,
        axisLine: {
          lineStyle: { color: "rgba(142, 165, 190, 0.34)" },
        },
        axisLabel: {
          color: axisColor,
          hideOverlap: true,
        },
      },
      yAxis: {
        type: "value",
        scale: true,
        name: metric.unit,
        nameTextStyle: {
          color: axisColor,
        },
        axisLabel: {
          color: axisColor,
        },
        splitLine: {
          lineStyle: { color: "rgba(142, 165, 190, 0.18)" },
        },
      },
      dataZoom: [
        {
          type: "inside",
          filterMode: "none",
        },
        ...(index === metrics.length - 1
          ? [
              {
                type: "slider",
                height: 16,
                bottom: 10,
                filterMode: "none",
                borderColor: "rgba(142, 165, 190, 0.18)",
                fillerColor: "rgba(47, 111, 237, 0.12)",
                backgroundColor: "rgba(233, 239, 246, 0.78)",
              },
            ]
          : []),
      ],
      series: [
        {
          type: "line",
          name: `${metric.label} · ${state.selectedTurbineCode}`,
          showSymbol: false,
          smooth: false,
          connectNulls: false,
          lineStyle: {
            width: 2,
            color: metric.color,
          },
          itemStyle: {
            color: metric.color,
          },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: `${metric.color}55` },
              { offset: 1, color: `${metric.color}05` },
            ]),
          },
          data: seriesData,
        },
      ],
    };
  }

  function clearMetricCharts() {
    chartStore.metrics.forEach((chart) => chart.clear());
  }

  function resizeCharts() {
    chartStore.map?.resize();
    chartStore.metrics.forEach((chart) => chart.resize());
  }

  function renderMetricCharts() {
    const emptyState = getEmptyState();
    if (emptyState) {
      if (dom.detailPlaceholder) {
        dom.detailPlaceholder.hidden = false;
        dom.detailPlaceholder.innerHTML = placeholderCopy(emptyState.title, emptyState.text);
      }
      if (dom.detailCharts) {
        dom.detailCharts.classList.add("is-hidden");
      }
      clearMetricCharts();
      return;
    }

    if (dom.detailPlaceholder) {
      dom.detailPlaceholder.hidden = true;
    }
    if (dom.detailCharts) {
      dom.detailCharts.classList.remove("is-hidden");
    }

    ensureMetricCharts();
    requestAnimationFrame(() => {
      metrics.forEach((metric, index) => {
        const chart = chartStore.metrics.get(metric.key);
        if (!chart) {
          return;
        }
        chart.resize();
        chart.setOption(buildMetricOption(metric, index), true);
      });
    });
  }

  function setView(mode) {
    if (!usesDrilldownView) {
      return;
    }
    state.view = mode;
    const detailMode = mode === "detail";
    if (dom.mapView) {
      dom.mapView.classList.toggle("is-active", !detailMode);
      dom.mapView.setAttribute("aria-hidden", String(detailMode));
    }
    if (dom.detailView) {
      dom.detailView.classList.toggle("is-active", detailMode);
      dom.detailView.setAttribute("aria-hidden", String(!detailMode));
    }
    if (dom.btnBackToMap) {
      dom.btnBackToMap.classList.toggle("is-hidden", !detailMode);
    }
    requestAnimationFrame(() => {
      if (detailMode) {
        chartStore.metrics.forEach((chart) => chart.resize());
      } else {
        chartStore.map?.resize();
      }
    });
  }

  function renderAll() {
    renderMapSummary();
    renderMapChart();
    renderSelectionSummary();
    renderTurbineTree();
    renderMetricCards();
    renderMetricCharts();
  }

  function buildHistoryUrl() {
    const params = new URLSearchParams();
    params.set("node_id", state.selectedNodeId);
    params.set("limit", String(currentLimit()));
    if (dom.historyStart?.value) {
      params.set("start", dom.historyStart.value);
    }
    if (dom.historyEnd?.value) {
      params.set("end", dom.historyEnd.value);
    }
    return `/api/data?${params.toString()}`;
  }

  async function loadHistory() {
    if (!state.selectedNodeId) {
      clearUploads();
      renderAll();
      return;
    }
    if (!isMonitorPage && !state.selectedTurbineCode) {
      clearUploads();
      renderAll();
      return;
    }
    const result = await fetchJson(buildHistoryUrl());
    const rows = Array.isArray(result.data) ? result.data : [];
    state.uploads = rows;
    state.uploadIds = new Set(rows.map((row) => getRowKey(row)));
    if (rows.length) {
      updateNodeFromRow(rows[rows.length - 1]);
    }
    renderAll();
  }

  function stopPolling() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    if (!isMonitorPage || !state.selectedNodeId) {
      return;
    }
    state.pollTimer = window.setInterval(() => {
      loadHistory().catch((error) => console.error("[dashboard] polling failed", error));
    }, pollIntervalMs);
  }

  function subscribeToNode(nodeId) {
    if (socket && nodeId) {
      socket.emit("subscribe_node", { node_id: nodeId });
    }
  }

  function unsubscribeFromNode(nodeId) {
    if (socket && nodeId) {
      socket.emit("unsubscribe_node", { node_id: nodeId });
    }
  }

  async function selectNode(nodeId, options = {}) {
    const nextId = String(nodeId || "").trim();
    const clearTurbine = options.clearTurbine !== false;
    const loadAfterSelect = !!options.loadAfterSelect;

    if (!nextId) {
      if (state.selectedNodeId) {
        unsubscribeFromNode(state.selectedNodeId);
      }
      state.selectedNodeId = "";
      state.selectedTurbineCode = "";
      clearUploads();
      persistSelection();
      stopPolling();
      renderAll();
      if (usesDrilldownView) {
        setView("map");
      }
      return;
    }

    if (state.selectedNodeId && state.selectedNodeId !== nextId) {
      unsubscribeFromNode(state.selectedNodeId);
    }

    state.selectedNodeId = nextId;
    if (clearTurbine) {
      state.selectedTurbineCode = "";
    }
    clearUploads();
    persistSelection();
    renderAll();

    if (isMonitorPage) {
      subscribeToNode(nextId);
      startPolling();
    }
    if (loadAfterSelect || (!isMonitorPage && state.selectedTurbineCode)) {
      await loadHistory();
    }
  }

  async function jumpToDetail(nodeId) {
    await selectNode(nodeId, { clearTurbine: true, loadAfterSelect: isMonitorPage });
    setView("detail");
  }

  function jumpToMap() {
    setView("map");
    requestAnimationFrame(() => chartStore.map?.resize());
  }

  async function selectTurbine(turbineCode) {
    state.selectedTurbineCode = String(turbineCode || "").trim();
    persistSelection();
    renderAll();
    if (!state.selectedNodeId) {
      return;
    }
    if (!isMonitorPage) {
      await loadHistory();
    }
  }

  function appendRealtimeRow(row) {
    if (!row || row.node_id !== state.selectedNodeId) {
      return;
    }
    const rowKey = getRowKey(row);
    if (state.uploadIds.has(rowKey)) {
      return;
    }
    updateNodeFromRow(row);
    state.uploads.push(row);
    state.uploadIds.add(rowKey);
    const limit = currentLimit();
    if (state.uploads.length > limit) {
      state.uploads = state.uploads.slice(-limit);
      state.uploadIds = new Set(state.uploads.map((item) => getRowKey(item)));
    }
    renderAll();
  }

  function formatDateTimeLocal(date) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
      date.getMinutes()
    )}`;
  }

  function applyQuickRange(minutes) {
    if (!dom.historyStart || !dom.historyEnd) {
      return;
    }
    const now = new Date();
    const start = new Date(now.getTime() - Number(minutes) * 60 * 1000);
    dom.historyStart.value = formatDateTimeLocal(start);
    dom.historyEnd.value = formatDateTimeLocal(now);
    if (state.selectedNodeId && (!isMonitorPage ? state.selectedTurbineCode : true)) {
      loadHistory().catch((error) => console.error("[dashboard] quick range failed", error));
    }
  }

  function bindSocket() {
    if (!socket) {
      return;
    }
    socket.on("connect", () => {
      if (state.selectedNodeId) {
        subscribeToNode(state.selectedNodeId);
      }
    });
    const handler = (payload) => appendRealtimeRow(payload?.data || payload);
    socket.on("monitor_update", handler);
    socket.on("node_data_update", handler);
  }

  function bindEvents() {
    dom.btnReload?.addEventListener("click", () => {
      loadHistory().catch((error) => console.error("[dashboard] reload failed", error));
    });

    dom.historyLimit?.addEventListener("change", () => {
      dom.historyLimit.value = String(currentLimit());
      if (state.selectedNodeId && (!isMonitorPage ? state.selectedTurbineCode : true)) {
        loadHistory().catch((error) => console.error("[dashboard] limit change failed", error));
      }
    });

    dom.historyStart?.addEventListener("change", () => {
      loadHistory().catch((error) => console.error("[dashboard] start change failed", error));
    });

    dom.historyEnd?.addEventListener("change", () => {
      loadHistory().catch((error) => console.error("[dashboard] end change failed", error));
    });

    dom.btnClearRange?.addEventListener("click", () => {
      if (dom.historyStart) dom.historyStart.value = "";
      if (dom.historyEnd) dom.historyEnd.value = "";
      loadHistory().catch((error) => console.error("[dashboard] clear range failed", error));
    });

    document.querySelectorAll("[data-range-min]").forEach((button) => {
      button.addEventListener("click", () => applyQuickRange(button.dataset.rangeMin || "0"));
    });

    dom.btnBackToMap?.addEventListener("click", jumpToMap);
    window.addEventListener("resize", resizeCharts);
  }

  async function loadNodes() {
    const result = await fetchJson("/api/nodes");
    state.nodes = sortNodes(Array.isArray(result.nodes) ? result.nodes : []);
    state.nodeMap = new Map(
      state.nodes.map((node) => [
        node.node_id,
        {
          ...node,
          turbines: normalizeTurbines(node.turbines || []),
        },
      ])
    );

    const fromQuery = new URLSearchParams(window.location.search).get("select");
    const fromStorage = window.localStorage.getItem(storageNodeKey) || "";
    const restoredNode = fromQuery || fromStorage;
    const restoredTurbine = window.localStorage.getItem(storageTurbineKey) || "";

    if (restoredNode && state.nodeMap.has(restoredNode)) {
      state.selectedNodeId = restoredNode;
      if (isMonitorPage && availableTurbines(restoredNode).includes(restoredTurbine)) {
        state.selectedTurbineCode = restoredTurbine;
      } else {
        state.selectedTurbineCode = "";
      }
    } else {
      state.selectedNodeId = "";
      state.selectedTurbineCode = "";
    }

    persistSelection();
    renderAll();

    if (usesDrilldownView) {
      setView("map");
    }

    if (state.selectedNodeId) {
      if (isMonitorPage) {
        subscribeToNode(state.selectedNodeId);
        startPolling();
        await loadHistory();
      }
    }
  }

  bindEvents();
  bindSocket();
  renderAll();
  loadNodes().catch((error) => console.error("[dashboard] init failed", error));
})();
