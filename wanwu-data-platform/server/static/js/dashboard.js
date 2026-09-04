(() => {
  const root = document.getElementById("dashboardPage");
  if (!root) {
    return;
  }

  const pageKind = root.dataset.pageKind || "overview";
  const isMonitorPage = pageKind === "monitor";
  const isOverviewPage = pageKind === "overview";
  const isMapPage = pageKind === "map";
  const isAdminUser = document.body?.dataset?.userRole === "admin";
  const usesDrilldownView = isMonitorPage || isOverviewPage || isMapPage;
  const waveOnlyPage = isMonitorPage || isOverviewPage;
  const storageNodeKey = "selectedNodeId";
  const storageTurbineKey = "selectedTurbineCode";
  const storageViewKey = `windsightDrillView:${pageKind}`;
  let pollIntervalMs = 3000;
  const defaultLimit = 600;
  const maxLimit = 20000;
  const nodeMapConfig = window.WindSightNodeMapConfig || { defaults: {}, nodes: {} };
  const amapConfig = window.WindSightAmapConfig || {};
  const socket = isMonitorPage && typeof io === "function" ? io() : null;
  root.classList.toggle("is-wave-only", waveOnlyPage);
  root.classList.toggle("is-map-only", isMapPage);
  const defaultUploadIntervalSeconds = 60;
  const uploadGapThresholdMultiplier = 1.5;
  const minChannelGapThresholdSeconds = 120;

  const runtimeConfig = {
    autoRefresh: true,
    showDebugLog: false,
  };

  const metrics = [
    { key: "voltage", label: "电压", unit: "V", min: 0, max: 250, color: "#2f6fed", elementId: "chartVoltage" },
    { key: "current", label: "电流", unit: "A", min: 0, max: 5, color: "#19b8d6", elementId: "chartCurrent" },
    { key: "speed", label: "转速", unit: "r/min", min: 0, max: 2500, color: "#f59e0b", elementId: "chartSpeed" },
    { key: "temperature", label: "温度", unit: "℃", min: 0, max: 100, color: "#ef4444", elementId: "chartTemperature" },
  ];
  const metricByKey = new Map(metrics.map((metric) => [metric.key, metric]));

  const state = {
    nodes: [],
    nodeMap: new Map(),
    selectedNodeId: "",
    selectedTurbineCode: window.localStorage.getItem(storageTurbineKey) || "",
    expandedTurbineGroups: new Map(),
    collapsedTurbineRoots: new Set(),
    uploads: [],
    uploadIds: new Set(),
    pollTimer: null,
    view: usesDrilldownView ? "map" : "chart",
    mapMode: "amap",
    metricZoom: null,
    syncingMetricZoom: false,
    historyEditOrder: [],
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
    historyLinkHint: document.getElementById("historyLinkHint"),
    btnClearRange: document.getElementById("btnClearRange"),
    mapView: document.getElementById("map-view"),
    treeView: document.getElementById("tree-view"),
    chartView: document.getElementById("chart-view"),
    btnBackToMap: document.getElementById("btnBackToMap"),
    btnBackToTree: document.getElementById("btnBackToTree"),
    lastDataTime: document.getElementById("lastDataTime"),
    topbarNodeChip: document.getElementById("topbarNodeChip"),
    topbarStatusChip: document.getElementById("topbarStatusChip"),
    chartNodeChip: document.getElementById("chartNodeChip"),
    chartTurbineChip: document.getElementById("chartTurbineChip"),
    chartStatusChip: document.getElementById("chartStatusChip"),
    chartUploadIntervalChip: document.getElementById("chartUploadIntervalChip"),
    chartLastDataTime: document.getElementById("chartLastDataTime"),
  };

  const chartStore = {
    map: dom.nodeMapChart || null,
    turbineTree: null,
    metrics: new Map(),
  };

  const amapState = {
    loaderPromise: null,
    map: null,
    mapStyle: "",
    markers: [],
    renderToken: 0,
    nodeSignature: "",
    fittedSignature: "",
  };

  const mapRenderState = {
    legendMode: "",
    summarySignature: "",
    unavailableSignature: "",
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function debugLog(...args) {
    if (runtimeConfig.showDebugLog) {
      console.debug("[dashboard]", ...args);
    }
  }

  function getThemeMode() {
    return document.body?.dataset.theme || document.documentElement.dataset.theme || "light";
  }

  function getThemePalette() {
    if (getThemeMode() === "dark") {
      return {
        tooltipBg: "rgba(10, 17, 34, 0.95)",
        tooltipBorder: "rgba(0, 243, 255, 0.4)",
        tooltipText: "#eaffff",
        axisText: "#82a0bc",
        axisLine: "rgba(0, 243, 255, 0.3)",
        splitLine: "rgba(0, 243, 255, 0.1)",
        zoomBorder: "rgba(0, 243, 255, 0.2)",
        zoomFill: "rgba(0, 243, 255, 0.15)",
        zoomBg: "rgba(10, 17, 34, 0.92)",
        emptyText: "#597a9f",
        labelText: "#eaffff",
        online: "#00f3ff",
        offline: "#47617f",
        fault: "#ff3366",
      };
    }
    return {
      tooltipBg: "rgba(255, 255, 255, 0.98)",
      tooltipBorder: "rgba(47, 111, 237, 0.14)",
      tooltipText: "#24364f",
      axisText: "#6f8198",
      axisLine: "rgba(142, 165, 190, 0.34)",
      splitLine: "rgba(142, 165, 190, 0.18)",
      zoomBorder: "rgba(142, 165, 190, 0.18)",
      zoomFill: "rgba(47, 111, 237, 0.12)",
      zoomBg: "rgba(233, 239, 246, 0.78)",
      emptyText: "#71849b",
      labelText: "#1f3552",
      online: "#2f6fed",
      offline: "#94a3b8",
      fault: "#ef4444",
    };
  }

  function getTreeGraphPalette() {
    if (getThemeMode() === "dark") {
      return {
        tooltipBg: "rgba(7, 14, 27, 0.94)",
        tooltipBorder: "rgba(125, 211, 252, 0.55)",
        tooltipText: "#f8fafc",
        hintText: "rgba(226, 232, 240, 0.78)",
        link: "rgba(56, 189, 248, 0.62)",
        rootFill: "#2563eb",
        rootBorder: "#bfdbfe",
        rootText: "#ffffff",
        rootSubText: "#dbeafe",
        rootShadow: "#60a5fa",
        groupFill: "#14243a",
        groupExpanded: "#22d3ee",
        groupSelected: "#f59e0b",
        groupDefault: "#93c5fd",
        groupText: "#f8fafc",
        groupSubText: "#cbd5e1",
        turbineFill: "#10233d",
        turbineSelectedFill: "#1d4ed8",
        turbineText: "#f7fbff",
        turbineSubText: "#dbeafe",
        seriesLabel: "#f8fafc",
      };
    }
    return {
      tooltipBg: "rgba(255, 255, 255, 0.98)",
      tooltipBorder: "rgba(37, 99, 235, 0.28)",
      tooltipText: "#0f172a",
      hintText: "rgba(51, 65, 85, 0.82)",
      link: "rgba(37, 99, 235, 0.5)",
      rootFill: "#2563eb",
      rootBorder: "#1e40af",
      rootText: "#ffffff",
      rootSubText: "#dbeafe",
      rootShadow: "#93c5fd",
      groupFill: "#ffffff",
      groupExpanded: "#0f766e",
      groupSelected: "#b45309",
      groupDefault: "#3b82f6",
      groupText: "#0f172a",
      groupSubText: "#334155",
      turbineFill: "#ffffff",
      turbineSelectedFill: "#dbe7fb",
      turbineText: "#0f172a",
      turbineSubText: "#475569",
      seriesLabel: "#0f172a",
    };
  }

  function withAlpha(color, alpha) {
    const value = String(color || "").trim();
    if (!value.startsWith("#")) {
      return value;
    }
    const normalized = value.length === 4
      ? `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`
      : value;
    const matched = /^#([0-9a-f]{6})$/i.exec(normalized);
    if (!matched) {
      return value;
    }
    const hex = matched[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function setText(id, value, fallback = "--") {
    const element = typeof id === "string" ? byId(id) : id;
    if (!element) {
      return;
    }
    const nextText = value === undefined || value === null || value === "" ? fallback : String(value);
    if (element.textContent !== nextText) {
      element.textContent = nextText;
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatNodeShortCode(nodeId) {
    const matched = /(\d+)$/.exec(String(nodeId || ""));
    return matched ? matched[1].padStart(3, "0").slice(-3) : String(nodeId || "--").slice(-3);
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

  async function fetchNodesForContext(queryParams) {
    const userId = queryParams.get("user_id") || "";
    if (userId) {
      try {
        const scoped = await fetchJson(`/api/admin/users/${encodeURIComponent(userId)}/registered_nodes`);
        if (scoped && Array.isArray(scoped.nodes)) {
          return { success: true, nodes: scoped.nodes };
        }
      } catch (error) {
        // Non-admin users cannot call the admin endpoint; fall through to their own node scope.
      }
    }
    return fetchJson("/api/nodes");
  }

  function sortNodes(nodes) {
    return [...nodes].sort((a, b) => String(a.node_id || "").localeCompare(String(b.node_id || ""), "zh-Hans-CN"));
  }

  function compareTurbineCodes(left, right) {
    const a = String(left || "").trim();
    const b = String(right || "").trim();
    const aNum = Number(a);
    const bNum = Number(b);
    const aIsNum = a !== "" && Number.isFinite(aNum);
    const bIsNum = b !== "" && Number.isFinite(bNum);
    if (aIsNum && bIsNum && aNum !== bNum) {
      return aNum - bNum;
    }
    return a.localeCompare(b, "zh-Hans-CN", { numeric: true, sensitivity: "base" });
  }

  function normalizeTurbines(turbines) {
    return Array.from(new Set((turbines || []).map((item) => String(item).trim()).filter(Boolean))).sort(compareTurbineCodes);
  }

  function safeNumber(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatValue(value) {
    const number = safeNumber(value);
    return number === null ? "--" : number.toFixed(2);
  }

  function normalizeUploadIntervalSeconds(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return defaultUploadIntervalSeconds;
    }
    return Math.min(86400, Math.max(5, Math.round(number)));
  }

  function formatDurationSeconds(seconds) {
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    if (value >= 3600 && value % 3600 === 0) return `${value / 3600} 小时`;
    if (value >= 60 && value % 60 === 0) return `${value / 60} 分钟`;
    if (value >= 60) return `${Math.floor(value / 60)} 分 ${value % 60} 秒`;
    return `${value} 秒`;
  }

  function selectedUploadIntervalSeconds() {
    const node = getNodeRecord(state.selectedNodeId);
    if (node?.upload_interval_seconds !== undefined) {
      return normalizeUploadIntervalSeconds(node.upload_interval_seconds);
    }
    const rowWithExpected = state.uploads.find((row) => row?.expected_interval_seconds !== undefined);
    return normalizeUploadIntervalSeconds(rowWithExpected?.expected_interval_seconds);
  }

  function parseRowTimestampMs(row) {
    const timestamp = row?.timestamp;
    if (!timestamp) return null;
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function rowGapInfo(row, rowIndex, rows = state.uploads) {
    const interval = normalizeUploadIntervalSeconds(row?.expected_interval_seconds ?? selectedUploadIntervalSeconds());
    const threshold = Math.max(
      minChannelGapThresholdSeconds,
      Number(row?.gap_threshold_seconds ?? interval * uploadGapThresholdMultiplier)
    );
    let gap = Number(row?.gap_from_previous_seconds);
    if (!Number.isFinite(gap) && rowIndex > 0) {
      const previousMs = parseRowTimestampMs(rows[rowIndex - 1]);
      const currentMs = parseRowTimestampMs(row);
      if (previousMs !== null && currentMs !== null) {
        gap = (currentMs - previousMs) / 1000;
      }
    }
    const hasGap = row?.is_gap_after_previous === true || (Number.isFinite(gap) && gap > threshold);
    return {
      interval,
      threshold,
      gap: Number.isFinite(gap) ? gap : null,
      hasGap,
    };
  }

  function setMetricCardValue(metric, value) {
    const element = byId(`cardValue-${metric.key}`);
    if (!element) {
      return;
    }

    const textValue = formatValue(value);
    if (textValue === "--") {
      element.textContent = "--";
      return;
    }

    element.textContent = "";
    const numberElement = document.createElement("span");
    numberElement.className = "metric-value-number";
    numberElement.textContent = textValue;

    const unitElement = document.createElement("span");
    unitElement.className = "metric-value-unit";
    unitElement.textContent = metric.unit;

    element.append(numberElement, unitElement);
  }

  function updateMetricChartTitles() {
    metrics.forEach((metric) => {
      const titleElement = document.querySelector(`.detail-chart-${metric.key} .chart-card-head span:last-child`);
      if (titleElement) {
        titleElement.textContent = `${metric.label}波形（${metric.unit}）`;
      }
    });
  }

  function currentLimit() {
    const raw = parseInt((dom.historyLimit && dom.historyLimit.value) || `${defaultLimit}`, 10);
    if (!Number.isFinite(raw)) {
      return defaultLimit;
    }
    return Math.max(1, Math.min(maxLimit, raw));
  }

  function normalizeHistoryLimit() {
    const limit = currentLimit();
    if (dom.historyLimit) {
      dom.historyLimit.value = String(limit);
    }
    return limit;
  }

  function setHistoryHint(message, tone = "info") {
    if (!dom.historyLinkHint) {
      return;
    }
    const text = String(message || "").trim();
    dom.historyLinkHint.textContent = text;
    dom.historyLinkHint.hidden = !text;
    dom.historyLinkHint.dataset.tone = tone;
  }

  function canLoadHistoryForCurrentSelection() {
    if (!state.selectedNodeId) {
      return false;
    }
    return !waveOnlyPage || !!state.selectedTurbineCode;
  }

  function recordHistoryEdit(field) {
    if (!isOverviewPage) {
      return;
    }
    state.historyEditOrder = state.historyEditOrder.filter((item) => item !== field);
    state.historyEditOrder.push(field);
    if (state.historyEditOrder.length > 2) {
      state.historyEditOrder = state.historyEditOrder.slice(-2);
    }
  }

  function hasHistoryFieldValue(field) {
    if (field === "limit") {
      return !!dom.historyLimit?.value;
    }
    if (field === "start") {
      return !!dom.historyStart?.value;
    }
    if (field === "end") {
      return !!dom.historyEnd?.value;
    }
    return false;
  }

  function historyFieldPairFromState() {
    const recent = state.historyEditOrder.filter((field) => hasHistoryFieldValue(field));
    if (recent.length >= 2) {
      return recent.slice(-2);
    }

    const edited = recent[recent.length - 1] || "";
    if ((edited === "start" || edited === "end") && hasHistoryFieldValue("limit")) {
      return [edited, "limit"];
    }
    if (edited === "limit") {
      if (hasHistoryFieldValue("start")) {
        return ["limit", "start"];
      }
      if (hasHistoryFieldValue("end")) {
        return ["limit", "end"];
      }
    }

    if (hasHistoryFieldValue("start") && hasHistoryFieldValue("end")) {
      return ["start", "end"];
    }
    if (hasHistoryFieldValue("start") && hasHistoryFieldValue("limit")) {
      return ["start", "limit"];
    }
    if (hasHistoryFieldValue("end") && hasHistoryFieldValue("limit")) {
      return ["end", "limit"];
    }
    return [];
  }

  function parseHistoryInputDate(value) {
    if (!value) {
      return null;
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function historyRangeIsInvalid() {
    const start = parseHistoryInputDate(dom.historyStart?.value || "");
    const end = parseHistoryInputDate(dom.historyEnd?.value || "");
    return !!(start && end && start.getTime() > end.getTime());
  }

  function apiTimeToDateTimeLocal(value) {
    if (!value) {
      return "";
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return "";
    }
    return formatDateTimeLocal(parsed, { includeSeconds: true });
  }

  function setHistoryDateField(field, value) {
    const localValue = apiTimeToDateTimeLocal(value);
    if (!localValue) {
      return false;
    }
    if (field === "start" && dom.historyStart) {
      dom.historyStart.value = localValue;
      return true;
    }
    if (field === "end" && dom.historyEnd) {
      dom.historyEnd.value = localValue;
      return true;
    }
    return false;
  }

  function reflectOverviewLoadedRange(rows) {
    if (!isOverviewPage) {
      return;
    }
    if (!Array.isArray(rows) || !rows.length) {
      if (!dom.historyStart?.value && !dom.historyEnd?.value) {
        setHistoryHint("当前筛选条件没有历史数据，时间范围未更新。", "warning");
      }
      return;
    }

    const hadStart = !!dom.historyStart?.value;
    const hadEnd = !!dom.historyEnd?.value;
    const firstTs = rows[0]?.timestamp || "";
    const lastTs = rows[rows.length - 1]?.timestamp || "";
    let changed = false;

    if (!hadStart) {
      changed = setHistoryDateField("start", firstTs) || changed;
    }
    if (!hadEnd) {
      changed = setHistoryDateField("end", lastTs) || changed;
    }
    if (changed) {
      setHistoryHint(`已显示实际加载范围：${rows.length} 帧。`, "success");
    }
  }

  async function fetchHistoryMeta(mode, fields = {}) {
    const params = new URLSearchParams();
    params.set("node_id", state.selectedNodeId);
    params.set("mode", mode);
    if (state.selectedTurbineCode) {
      params.set("turbine", state.selectedTurbineCode);
    }
    if (fields.limit) {
      params.set("limit", String(fields.limit));
    }
    if (fields.start) {
      params.set("start", fields.start);
    }
    if (fields.end) {
      params.set("end", fields.end);
    }
    return fetchJson(`/api/data_meta?${params.toString()}`);
  }

  function pairHas(pair, field) {
    return pair.includes(field);
  }

  async function syncHistoryLinkedFields() {
    if (!isOverviewPage || !state.selectedNodeId) {
      return true;
    }

    normalizeHistoryLimit();
    if (historyRangeIsInvalid()) {
      setHistoryHint("开始时间不能晚于结束时间，请调整后再确认。", "error");
      return false;
    }

    const pair = historyFieldPairFromState();
    if (pair.length < 2) {
      setHistoryHint("", "info");
      return true;
    }

    if (pairHas(pair, "start") && pairHas(pair, "end")) {
      const meta = await fetchHistoryMeta("count", {
        start: dom.historyStart.value,
        end: dom.historyEnd.value,
      });
      const count = Math.max(0, Math.min(maxLimit, Number(meta.count) || 0));
      if (dom.historyLimit) {
        dom.historyLimit.value = String(Math.max(1, count));
      }
      setHistoryHint(count > 0 ? `已按开始和结束时间计算回放帧数：${count} 帧。` : "该时段暂无数据，回放帧数保留为 1。", count > 0 ? "success" : "warning");
      return true;
    }

    if (pairHas(pair, "start") && pairHas(pair, "limit")) {
      const requested = normalizeHistoryLimit();
      const meta = await fetchHistoryMeta("nth", {
        start: dom.historyStart.value,
        limit: requested,
      });
      const target = meta.nth_ts || meta.last_ts;
      if (setHistoryDateField("end", target)) {
        const count = Number(meta.count) || 0;
        setHistoryHint(
          count >= requested
            ? `已按开始时间和 ${requested} 帧确定结束时间。`
            : `可用帧数不足 ${requested} 帧，已使用最后一帧时间作为结束时间。`,
          count >= requested ? "success" : "warning"
        );
      } else {
        setHistoryHint("开始时间之后暂无可用数据，结束时间未更新。", "warning");
      }
      return true;
    }

    if (pairHas(pair, "end") && pairHas(pair, "limit")) {
      const requested = normalizeHistoryLimit();
      const meta = await fetchHistoryMeta("nth_before", {
        end: dom.historyEnd.value,
        limit: requested,
      });
      const target = meta.nth_ts || meta.first_ts;
      if (setHistoryDateField("start", target)) {
        const count = Number(meta.count) || 0;
        setHistoryHint(
          count >= requested
            ? `已按结束时间和 ${requested} 帧确定开始时间。`
            : `可用帧数不足 ${requested} 帧，已使用最早一帧时间作为开始时间。`,
          count >= requested ? "success" : "warning"
        );
      } else {
        setHistoryHint("结束时间之前暂无可用数据，开始时间未更新。", "warning");
      }
      return true;
    }

    setHistoryHint("", "info");
    return true;
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
    const palette = getThemePalette();
    if (status === "fault") return palette.fault;
    if (status === "online") return palette.online;
    return palette.offline;
  }

  function getNodeVisualColor(node) {
    const palette = getThemePalette();
    if (node.status === "fault") {
      return palette.fault;
    }
    if (node.status === "online") {
      return node.accentColor || palette.online;
    }
    return palette.offline;
  }

  function getStatusLabel(status) {
    if (status === "fault") return "故障";
    if (status === "online") return "在线";
    return "离线";
  }

  function toFiniteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function getValidGeo(node) {
    const lng = toFiniteNumber(node?.geo?.lng);
    const lat = toFiniteNumber(node?.geo?.lat);
    if (lng === null || lat === null || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      return null;
    }
    return [lng, lat];
  }

  function partitionNodesByGeo(nodes) {
    const locatedNodes = [];
    const missingNodes = [];
    (Array.isArray(nodes) ? nodes : []).forEach((node) => {
      if (getValidGeo(node)) {
        locatedNodes.push(node);
      } else {
        missingNodes.push(node);
      }
    });
    return { locatedNodes, missingNodes };
  }

  function getAmapAvailability(nodes) {
    const key = String(amapConfig.jsKey || "").trim();
    if (!key || amapConfig.enabled === false) {
      return { usable: false, reason: "未配置高德地图 Key", locatedNodes: [], missingNodes: nodes || [] };
    }
    if (!Array.isArray(nodes) || !nodes.length) {
      return { usable: false, reason: "暂无节点", locatedNodes: [], missingNodes: [] };
    }
    const { locatedNodes, missingNodes } = partitionNodesByGeo(nodes);
    if (!locatedNodes.length) {
      return {
        usable: false,
        reason: "暂无可定位节点，请先设置经纬度",
        locatedNodes,
        missingNodes,
      };
    }
    return { usable: true, reason: "高德地图模式", locatedNodes, missingNodes };
  }

  function normalizeAmapServiceHost(value) {
    const host = String(value || "").trim();
    if (!host) {
      return "";
    }
    return host.endsWith("/") ? host : `${host}/`;
  }

  function applyAmapSecurityConfig() {
    const serviceHost = normalizeAmapServiceHost(amapConfig.securityServiceHost);
    if (serviceHost) {
      window._AMapSecurityConfig = {
        ...(window._AMapSecurityConfig || {}),
        serviceHost,
      };
      return;
    }
    const securityJsCode = String(amapConfig.securityCode || "").trim();
    if (securityJsCode) {
      window._AMapSecurityConfig = {
        ...(window._AMapSecurityConfig || {}),
        securityJsCode,
      };
    }
  }

  function loadAmapLoaderScript() {
    if (window.AMapLoader) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const existing = document.querySelector("script[data-windsight-amap-loader]");
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("高德地图加载器加载失败")), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = "https://webapi.amap.com/loader.js";
      script.async = true;
      script.dataset.windsightAmapLoader = "1";
      script.addEventListener("load", () => resolve(), { once: true });
      script.addEventListener("error", () => reject(new Error("高德地图加载器加载失败")), { once: true });
      document.head.appendChild(script);
    });
  }

  function loadAmap() {
    if (window.AMap?.Map) {
      return Promise.resolve(window.AMap);
    }
    if (!amapState.loaderPromise) {
      applyAmapSecurityConfig();
      amapState.loaderPromise = loadAmapLoaderScript().then(() => {
        if (!window.AMapLoader?.load) {
          throw new Error("高德地图加载器不可用");
        }
        return window.AMapLoader.load({
          key: String(amapConfig.jsKey || "").trim(),
          version: "2.0",
          plugins: ["AMap.Scale", "AMap.ToolBar"],
        });
      });
    }
    return amapState.loaderPromise;
  }

  function getAmapMapStyle() {
    return getThemeMode() === "dark" ? "amap://styles/darkblue" : "amap://styles/whitesmoke";
  }

  function disposeAmapMap() {
    try {
      if (amapState.map && amapState.markers.length) {
        amapState.map.remove(amapState.markers);
      }
      if (amapState.map) {
        amapState.map.destroy();
      }
    } catch (error) {
      console.warn("[dashboard] amap cleanup failed", error);
    }
    amapState.map = null;
    amapState.mapStyle = "";
    amapState.markers = [];
    amapState.nodeSignature = "";
    amapState.fittedSignature = "";
  }

  function removeAmapMarkers() {
    try {
      if (amapState.map && amapState.markers.length) {
        amapState.map.remove(amapState.markers);
      }
    } catch (error) {
      console.warn("[dashboard] amap marker cleanup failed", error);
    }
    amapState.markers = [];
  }

  function buildAmapNodeSignature(nodes) {
    return [
      state.selectedNodeId || "",
      nodes
        .map((node) => {
          const geo = getValidGeo(node) || [];
          return [
            node.nodeId,
            node.displayName,
            node.zoneLabel,
            geo[0],
            geo[1],
            node.status,
            node.turbineCount,
            node.accentColor,
          ].join(":");
        })
        .join("|"),
    ].join("||");
  }

  function buildUnavailableRenderSignature(nodes, reason) {
    return [
      "amap-unavailable",
      reason || "",
      nodes
        .map((node) => {
          const geo = getValidGeo(node) || [];
          return [node.nodeId, geo[0], geo[1], node.status, node.turbineCount].join(":");
        })
        .join("|"),
    ].join("||");
  }

  function getAmapDefaultCenter(nodes) {
    const configured = Array.isArray(amapConfig.defaultCenter) ? amapConfig.defaultCenter : [];
    const cfgLng = toFiniteNumber(configured[0]);
    const cfgLat = toFiniteNumber(configured[1]);
    if (cfgLng !== null && cfgLat !== null) {
      return [cfgLng, cfgLat];
    }
    const points = nodes.map(getValidGeo).filter(Boolean);
    if (!points.length) {
      return [116.397428, 39.90923];
    }
    const totals = points.reduce(
      (acc, point) => {
        acc.lng += point[0];
        acc.lat += point[1];
        return acc;
      },
      { lng: 0, lat: 0 }
    );
    return [totals.lng / points.length, totals.lat / points.length];
  }

  function getAmapDefaultZoom() {
    const zoom = Number(amapConfig.defaultZoom);
    return Number.isFinite(zoom) ? Math.max(3, Math.min(18, zoom)) : 10;
  }

  function getNodeRecord(nodeId) {
    return state.nodeMap.get(nodeId) || null;
  }

  function resolveNodeMeta(nodeOrId) {
    const node = typeof nodeOrId === "string" ? getNodeRecord(nodeOrId) || { node_id: nodeOrId } : nodeOrId || {};
    const nodeId = node.node_id || "";
    const defaults = nodeMapConfig.defaults || {};
    const turbines = normalizeTurbines(node.turbines || []);
    const nodeGeo = getValidGeo(node);
    const hasGeo = !!nodeGeo;
    const registeredName = String(node.display_name || "").trim();
    return {
      nodeId,
      displayName: registeredName || node.node_id || "未命名节点",
      zoneLabel: hasGeo ? "已定位区域" : "未定位区域",
      description: defaults.description || "风场边缘采集节点",
      mapX: undefined,
      mapY: undefined,
      geo: nodeGeo ? { lng: nodeGeo[0], lat: nodeGeo[1] } : null,
      accentColor: defaults.accentColor || "#2f6fed",
      status: getNodeStatus(node),
      online: !!node.online,
      lastUpload: node.last_upload || "",
      turbineCount: node.turbine_count || turbines.length || 0,
      turbines,
      uploadIntervalSeconds: normalizeUploadIntervalSeconds(node.upload_interval_seconds),
    };
  }

  function persistSelection() {
    window.localStorage.setItem(storageNodeKey, state.selectedNodeId || "");
    window.localStorage.setItem(storageTurbineKey, state.selectedTurbineCode || "");
  }

  function persistView(mode = state.view) {
    if (!usesDrilldownView) {
      return;
    }
    window.localStorage.setItem(storageViewKey, mode || "map");
  }

  function clearUploads() {
    state.uploads = [];
    state.uploadIds = new Set();
  }

  function resetMetricZoom() {
    state.metricZoom = null;
  }

  function clampNumber(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return min;
    }
    return Math.max(min, Math.min(max, number));
  }

  function getMetricXExtent() {
    const rows = state.selectedTurbineCode ? rowsForSelectedTurbine() : state.uploads;
    return { min: 0, max: Math.max(rows.length - 1, 1) };
  }

  function getMetricYExtent(metricKey) {
    const metric = metricByKey.get(metricKey);
    const min = Number(metric?.min);
    const max = Number(metric?.max);
    return {
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) && max > min ? max : 1,
    };
  }

  function normalizeMetricZoomRange(startValue, endValue, extent) {
    const min = Number(extent?.min);
    const max = Number(extent?.max);
    const start = Number(startValue);
    const end = Number(endValue);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || !Number.isFinite(start) || !Number.isFinite(end)) {
      return null;
    }
    const fullSpan = max - min;
    const minSpan = Math.max(fullSpan * 0.001, 1e-6);
    let nextStart = Math.min(start, end);
    let nextEnd = Math.max(start, end);
    let span = nextEnd - nextStart;
    if (span >= fullSpan * 0.98) {
      return { startValue: min, endValue: max };
    }
    if (span < minSpan) {
      const center = (nextStart + nextEnd) / 2;
      nextStart = center - minSpan / 2;
      nextEnd = center + minSpan / 2;
      span = nextEnd - nextStart;
    }
    if (nextStart < min) {
      nextEnd += min - nextStart;
      nextStart = min;
    }
    if (nextEnd > max) {
      nextStart -= nextEnd - max;
      nextEnd = max;
    }
    nextStart = clampNumber(nextStart, min, max);
    nextEnd = clampNumber(nextEnd, min, max);
    if (nextEnd - nextStart < minSpan) {
      return { startValue: min, endValue: max };
    }
    return { startValue: nextStart, endValue: nextEnd };
  }

  function isFullMetricZoomRange(range, extent) {
    if (!range || !extent) {
      return false;
    }
    const span = Math.max(Number(extent.max) - Number(extent.min), 1);
    const tolerance = span * 0.002;
    return range.startValue <= extent.min + tolerance && range.endValue >= extent.max - tolerance;
  }

  function readMetricZoomRange(zoom, extent) {
    if (!zoom || !extent) {
      return null;
    }
    const startValue = Number(zoom.startValue);
    const endValue = Number(zoom.endValue);
    if (Number.isFinite(startValue) && Number.isFinite(endValue)) {
      return normalizeMetricZoomRange(startValue, endValue, extent);
    }
    const start = Number(zoom.start);
    const end = Number(zoom.end);
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const fullSpan = extent.max - extent.min;
      return normalizeMetricZoomRange(
        extent.min + fullSpan * (start / 100),
        extent.min + fullSpan * (end / 100),
        extent
      );
    }
    return null;
  }

  function getMetricZoomPayload(event, axis) {
    const payloads = Array.isArray(event?.batch) ? event.batch : event ? [event] : [];
    const ids = axis === "x" ? new Set(["metric-x-inside", "metric-x-slider"]) : new Set(["metric-y-inside"]);
    const indexes = axis === "x" ? new Set([0, 2]) : new Set([1]);
    return payloads.find((payload) => ids.has(payload?.dataZoomId) || indexes.has(payload?.dataZoomIndex)) || null;
  }

  function getStoredMetricZoom(axis, metricKey) {
    if (axis === "x") {
      return state.metricZoom?.x || null;
    }
    return state.metricZoom?.y?.[metricKey] || null;
  }

  function rememberMetricZoomFromChart(chart, metricKey, event) {
    if (!chart) {
      return { xRange: null, xIsFull: false, yRange: null, yIsFull: false };
    }
    const zoomItems = chart.getOption?.()?.dataZoom || [];
    const xExtent = getMetricXExtent();
    const yExtent = getMetricYExtent(metricKey);
    const nextZoom = {
      ...(state.metricZoom || {}),
      y: { ...(state.metricZoom?.y || {}) },
    };
    const xZoom = zoomItems.find((zoom) => zoom.id === "metric-x-inside") || zoomItems[0];
    const yZoom = zoomItems.find((zoom) => zoom.id === "metric-y-inside") || zoomItems[1];
    const xRange = readMetricZoomRange(getMetricZoomPayload(event, "x") || xZoom, xExtent);
    const yRange = readMetricZoomRange(getMetricZoomPayload(event, "y") || yZoom, yExtent);
    const xIsFull = isFullMetricZoomRange(xRange, xExtent);
    const yIsFull = isFullMetricZoomRange(yRange, yExtent);

    if (xRange) {
      if (xIsFull) {
        delete nextZoom.x;
      } else {
        nextZoom.x = xRange;
      }
    }
    if (yRange && metricKey) {
      if (yIsFull) {
        delete nextZoom.y[metricKey];
      } else {
        nextZoom.y[metricKey] = yRange;
      }
    }
    if (!Object.keys(nextZoom.y).length) {
      delete nextZoom.y;
    }
    state.metricZoom = Object.keys(nextZoom).length ? nextZoom : null;
    return { xRange, xIsFull, yRange, yIsFull };
  }

  function applyMetricZoom(config, axis = "x", metricKey = "") {
    const extent = axis === "x" ? getMetricXExtent() : getMetricYExtent(metricKey);
    const zoom = getStoredMetricZoom(axis, metricKey);
    const range = zoom ? normalizeMetricZoomRange(zoom.startValue, zoom.endValue, extent) : null;
    if (!range || isFullMetricZoomRange(range, extent)) {
      return config;
    }
    return {
      ...config,
      startValue: range.startValue,
      endValue: range.endValue,
    };
  }

  function findMetricDataZoomIndex(chart, axis) {
    const id = axis === "x" ? "metric-x-inside" : "metric-y-inside";
    const zoomItems = chart?.getOption?.()?.dataZoom || [];
    const index = zoomItems.findIndex((zoom) => zoom.id === id);
    return index >= 0 ? index : axis === "x" ? 0 : 1;
  }

  function findMetricDataZoomIndexes(chart, axis) {
    const ids = axis === "x" ? new Set(["metric-x-inside", "metric-x-slider"]) : new Set(["metric-y-inside"]);
    const zoomItems = chart?.getOption?.()?.dataZoom || [];
    const indexes = zoomItems
      .map((zoom, index) => (ids.has(zoom.id) ? index : -1))
      .filter((index) => index >= 0);
    if (indexes.length) {
      return indexes;
    }
    return [axis === "x" ? 0 : 1];
  }

  function dispatchMetricZoomByValue(chart, axis, metricKey, startValue, endValue) {
    const extent = axis === "x" ? getMetricXExtent() : getMetricYExtent(metricKey);
    const range = normalizeMetricZoomRange(startValue, endValue, extent);
    if (!chart || !range) {
      return null;
    }
    findMetricDataZoomIndexes(chart, axis).forEach((dataZoomIndex) => {
      chart.dispatchAction({
        type: "dataZoom",
        dataZoomIndex,
        startValue: range.startValue,
        endValue: range.endValue,
      });
    });
    return range;
  }

  function syncMetricXZoom(sourceChart, range, resetFull = false) {
    const nextRange = resetFull ? getMetricXExtent() : range;
    if (!nextRange || state.syncingMetricZoom) {
      return;
    }
    state.syncingMetricZoom = true;
    try {
      chartStore.metrics.forEach((chart) => {
        if (!chart || chart === sourceChart) {
          return;
        }
        dispatchMetricZoomByValue(chart, "x", chart.__windsightMetricKey || "", nextRange.startValue, nextRange.endValue);
      });
    } finally {
      state.syncingMetricZoom = false;
    }
  }

  function getMetricGridRect(chart) {
    try {
      const grid = chart.getModel().getComponent("grid", 0);
      const rect = grid?.coordinateSystem?.getRect?.();
      if (!rect) {
        return null;
      }
      const x = Number(rect.x);
      const y = Number(rect.y);
      const width = Number(rect.width);
      const height = Number(rect.height);
      return [x, y, width, height].every(Number.isFinite) && width > 2 && height > 2
        ? { x, y, width, height }
        : null;
    } catch (error) {
      return null;
    }
  }

  function getMetricHitRegion(chart, element, x, y) {
    const grid = getMetricGridRect(chart);
    if (grid) {
      const inPlot = x >= grid.x && x <= grid.x + grid.width && y >= grid.y && y <= grid.y + grid.height;
      const onYAxis = x < grid.x;
      const onXAxis = y > grid.y + grid.height;
      if (onYAxis && onXAxis) {
        return "y";
      }
      if (onYAxis) {
        return "y";
      }
      if (onXAxis) {
        return "x";
      }
      return inPlot ? "plot" : "none";
    }
    const rect = element.getBoundingClientRect();
    if (x < rect.width * 0.18) {
      return "y";
    }
    if (y > rect.height * 0.8) {
      return "x";
    }
    return "plot";
  }

  function getMetricAxisValueAtPixel(chart, x, y) {
    try {
      const grid = getMetricGridRect(chart);
      const px = grid ? clampNumber(x, grid.x + 1, grid.x + grid.width - 1) : x;
      const py = grid ? clampNumber(y, grid.y + 1, grid.y + grid.height - 1) : y;
      const value = chart.convertFromPixel({ gridIndex: 0 }, [px, py]);
      if (!Array.isArray(value) || value.length < 2) {
        return [null, null];
      }
      const xValue = Number(value[0]);
      const yValue = Number(value[1]);
      return [Number.isFinite(xValue) ? xValue : null, Number.isFinite(yValue) ? yValue : null];
    } catch (error) {
      return [null, null];
    }
  }

  function getMetricZoomWindow(chart, axis, metricKey) {
    const extent = axis === "x" ? getMetricXExtent() : getMetricYExtent(metricKey);
    const zoomItems = chart?.getOption?.()?.dataZoom || [];
    const zoom = zoomItems[findMetricDataZoomIndex(chart, axis)];
    const range = readMetricZoomRange(zoom, extent) || normalizeMetricZoomRange(extent.min, extent.max, extent);
    return range ? { ...range, extent } : null;
  }

  function zoomMetricAroundAnchor(chart, axis, metricKey, anchorValue, factor) {
    const windowRange = getMetricZoomWindow(chart, axis, metricKey);
    if (!windowRange) {
      return;
    }
    const start = windowRange.startValue;
    const end = windowRange.endValue;
    const span = Math.max(end - start, 1e-9);
    const anchor = Number.isFinite(anchorValue) ? anchorValue : (start + end) / 2;
    const ratio = clampNumber((anchor - start) / span, 0, 1);
    const nextSpan = span / factor;
    const nextStart = anchor - ratio * nextSpan;
    const nextEnd = nextStart + nextSpan;
    dispatchMetricZoomByValue(chart, axis, metricKey, nextStart, nextEnd);
  }

  function setupMetricChartZoom(chart, element, metricKey) {
    const zr = chart?.getZr?.();
    if (!chart || !element || !zr) {
      return;
    }
    if (chart.__windsightZoomHandlers) {
      const old = chart.__windsightZoomHandlers;
      try { zr.off("mousewheel", old.onWheel); } catch (error) {}
      try { zr.off("dblclick", old.onDblClick); } catch (error) {}
      try { zr.off("mousedown", old.onDown); } catch (error) {}
      try { zr.off("mousemove", old.onMove); } catch (error) {}
      try { zr.off("mouseup", old.onUp); } catch (error) {}
      try { zr.off("globalout", old.onUp); } catch (error) {}
    }

    let dragging = false;
    let dragStartPoint = null;
    let dragStartWindow = null;

    const onWheel = (params) => {
      const event = params?.event;
      if (event?.preventDefault) {
        event.preventDefault();
      }
      const x = Number(params?.offsetX);
      const y = Number(params?.offsetY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      const region = getMetricHitRegion(chart, element, x, y);
      if (region === "none") {
        return;
      }
      const delta = Number.isFinite(params?.wheelDelta) ? params.wheelDelta : -Number(event?.deltaY || 0);
      const factor = delta > 0 ? 1.1 : 0.9;
      const [xValue, yValue] = getMetricAxisValueAtPixel(chart, x, y);
      if (region === "x") {
        zoomMetricAroundAnchor(chart, "x", metricKey, xValue, factor);
      } else if (region === "y") {
        zoomMetricAroundAnchor(chart, "y", metricKey, yValue, factor);
      } else {
        zoomMetricAroundAnchor(chart, "x", metricKey, xValue, factor);
        zoomMetricAroundAnchor(chart, "y", metricKey, yValue, factor);
      }
    };

    const onDblClick = (params) => {
      const x = Number(params?.offsetX);
      const y = Number(params?.offsetY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      const region = getMetricHitRegion(chart, element, x, y);
      const xExtent = getMetricXExtent();
      const yExtent = getMetricYExtent(metricKey);
      if (region === "x") {
        dispatchMetricZoomByValue(chart, "x", metricKey, xExtent.min, xExtent.max);
      } else if (region === "y") {
        dispatchMetricZoomByValue(chart, "y", metricKey, yExtent.min, yExtent.max);
      } else if (region === "plot") {
        dispatchMetricZoomByValue(chart, "x", metricKey, xExtent.min, xExtent.max);
        dispatchMetricZoomByValue(chart, "y", metricKey, yExtent.min, yExtent.max);
      }
    };

    const onDown = (params) => {
      const event = params?.event;
      if (event && event.button !== undefined && event.button !== 0) {
        return;
      }
      const x = Number(params?.offsetX);
      const y = Number(params?.offsetY);
      if (!Number.isFinite(x) || !Number.isFinite(y) || getMetricHitRegion(chart, element, x, y) !== "plot") {
        return;
      }
      const xWindow = getMetricZoomWindow(chart, "x", metricKey);
      const yWindow = getMetricZoomWindow(chart, "y", metricKey);
      if (!xWindow || !yWindow) {
        return;
      }
      dragging = true;
      dragStartPoint = { x, y };
      dragStartWindow = {
        xStart: xWindow.startValue,
        xEnd: xWindow.endValue,
        yStart: yWindow.startValue,
        yEnd: yWindow.endValue,
      };
      element.style.cursor = "grabbing";
    };

    const onMove = (params) => {
      if (!dragging || !dragStartPoint || !dragStartWindow) {
        return;
      }
      const x = Number(params?.offsetX);
      const y = Number(params?.offsetY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      const grid = getMetricGridRect(chart);
      const width = grid ? grid.width : Math.max(1, element.getBoundingClientRect().width);
      const height = grid ? grid.height : Math.max(1, element.getBoundingClientRect().height);
      const xSpan = Math.max(dragStartWindow.xEnd - dragStartWindow.xStart, 1e-9);
      const ySpan = Math.max(dragStartWindow.yEnd - dragStartWindow.yStart, 1e-9);
      const xShift = -((x - dragStartPoint.x) / width) * xSpan;
      const yShift = ((y - dragStartPoint.y) / height) * ySpan;
      dispatchMetricZoomByValue(chart, "x", metricKey, dragStartWindow.xStart + xShift, dragStartWindow.xEnd + xShift);
      dispatchMetricZoomByValue(chart, "y", metricKey, dragStartWindow.yStart + yShift, dragStartWindow.yEnd + yShift);
    };

    const onUp = () => {
      if (!dragging) {
        return;
      }
      dragging = false;
      dragStartPoint = null;
      dragStartWindow = null;
      element.style.cursor = "";
    };

    zr.on("mousewheel", onWheel);
    zr.on("dblclick", onDblClick);
    zr.on("mousedown", onDown);
    zr.on("mousemove", onMove);
    zr.on("mouseup", onUp);
    zr.on("globalout", onUp);
    chart.__windsightZoomHandlers = { onWheel, onDblClick, onDown, onMove, onUp };
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

  function updateNodeFromRow(row, options = {}) {
    if (!row || !row.node_id) {
      return;
    }
    const markOnline = !!options.markOnline;
    const updateLastUpload = !!options.updateLastUpload;
    const current = state.nodeMap.get(row.node_id) || {};
    const rowTurbines = Object.keys(row.turbines || {});
    const turbines = normalizeTurbines([...(current.turbines || []), ...rowTurbines]);
    const patch = {
      node_id: row.node_id,
      turbines,
      turbine_count: turbines.length || rowTurbines.length,
    };
    if (markOnline) {
      patch.online = true;
    }
    if (updateLastUpload) {
      patch.last_upload = row.timestamp || "";
    }
    if (row.expected_interval_seconds !== undefined) {
      patch.upload_interval_seconds = normalizeUploadIntervalSeconds(row.expected_interval_seconds);
    }
    upsertNode({
      ...patch,
    });
  }

  function availableTurbines(nodeId = state.selectedNodeId) {
    const node = getNodeRecord(nodeId);
    if (node && normalizeTurbines(node.turbines || []).length > 0) {
      return normalizeTurbines(node.turbines || []);
    }
    const seen = [];
    for (let index = state.uploads.length - 1; index >= 0; index -= 1) {
      const row = state.uploads[index];
      if (row && row.node_id === nodeId) {
        seen.push(...Object.keys(row.turbines || {}));
      }
    }
    return normalizeTurbines(seen);
  }

  function buildTurbineGroups(turbineCodes, groupSize = 8) {
    const normalized = normalizeTurbines(turbineCodes);
    const groups = [];
    for (let index = 0; index < normalized.length; index += groupSize) {
      const items = normalized.slice(index, index + groupSize);
      if (!items.length) {
        continue;
      }
      groups.push({
        groupId: `${items[0]}-${items[items.length - 1]}`,
        label: `${items[0]}-${items[items.length - 1]}`,
        items,
      });
    }
    return groups;
  }

  function getExpandedGroupSet(nodeId = state.selectedNodeId) {
    if (!nodeId) {
      return new Set();
    }
    const expanded = state.expandedTurbineGroups.get(nodeId);
    return expanded ? new Set(expanded) : new Set();
  }

  function setExpandedGroupSet(nodeId, groupSet) {
    if (!nodeId) {
      return;
    }
    state.expandedTurbineGroups.set(nodeId, new Set(groupSet || []));
  }

  function getExpandedGroupsForRender(nodeId, groups) {
    if (!nodeId) {
      return new Set();
    }
    return getExpandedGroupSet(nodeId);
  }

  function resetExpandedGroups(nodeId) {
    if (!nodeId) {
      return;
    }
    state.expandedTurbineGroups.set(nodeId, new Set());
    state.collapsedTurbineRoots.delete(nodeId);
  }

  function isTurbineRootCollapsed(nodeId = state.selectedNodeId) {
    return !!nodeId && state.collapsedTurbineRoots.has(nodeId);
  }

  function toggleTurbineRootGroups(nodeId = state.selectedNodeId) {
    if (!nodeId) {
      return;
    }
    if (state.collapsedTurbineRoots.has(nodeId)) {
      state.collapsedTurbineRoots.delete(nodeId);
    } else {
      state.collapsedTurbineRoots.add(nodeId);
      setExpandedGroupSet(nodeId, new Set());
      if (state.selectedNodeId === nodeId) {
        state.selectedTurbineCode = "";
        persistSelection();
      }
    }
    renderAll();
  }

  function ensureExpandedGroupForTurbine(turbineCode, nodeId = state.selectedNodeId) {
    if (!nodeId || !turbineCode) {
      return;
    }
    const targetCode = String(turbineCode).trim();
    const groups = buildTurbineGroups(availableTurbines(nodeId));
    const matchedGroup = groups.find((group) => group.items.includes(targetCode));
    if (!matchedGroup) {
      return;
    }
    const expanded = getExpandedGroupSet(nodeId);
    expanded.add(matchedGroup.groupId);
    setExpandedGroupSet(nodeId, expanded);
  }

  function toggleTurbineGroup(groupId) {
    if (!state.selectedNodeId || !groupId) {
      return;
    }
    const expanded = getExpandedGroupSet(state.selectedNodeId);
    if (expanded.has(groupId)) {
      expanded.delete(groupId);
    } else {
      expanded.add(groupId);
    }
    setExpandedGroupSet(state.selectedNodeId, expanded);
    renderTurbineTree();
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

  function rowsForSelectedTurbine() {
    const turbineCode = String(state.selectedTurbineCode || "").trim();
    if (!turbineCode) {
      return [];
    }
    return state.uploads.filter((row) => !!row?.turbines?.[turbineCode]);
  }

  function renderMapSummary() {
    if (!dom.nodeMapSummary) {
      return;
    }
    const total = state.nodes.length;
    const online = state.nodes.filter((node) => getNodeStatus(node) === "online").length;
    const fault = state.nodes.filter((node) => getNodeStatus(node) === "fault").length;
    const configured = state.nodes.filter((node) => !!getValidGeo(resolveNodeMeta(node))).length;
    const chips = [
      { label: "总节点", value: total },
      { label: "在线", value: online },
      { label: "故障", value: fault },
      { label: "已定位", value: configured },
    ];
    const nextSignature = chips.map((chip) => `${chip.label}:${chip.value}`).join("|");
    if (mapRenderState.summarySignature === nextSignature) {
      return;
    }
    dom.nodeMapSummary.innerHTML = chips
      .map((chip) => `<span class="map-summary-chip"><strong>${chip.value}</strong><span>${chip.label}</span></span>`)
      .join("");
    mapRenderState.summarySignature = nextSignature;
  }

  function buildMapNodes() {
    return state.nodes.map((node) => resolveNodeMeta(node));
  }

  function renderMapLegend() {
    const mode = "amap";
    if (!dom.nodeMapFallback) {
      return;
    }
    if (mapRenderState.legendMode === mode && dom.nodeMapFallback.dataset.legendMode === mode) {
      return;
    }
    dom.nodeMapFallback.innerHTML = `
      <div class="map-legend">
        <span><i class="legend-dot is-online"></i>在线节点</span>
        <span><i class="legend-dot is-offline"></i>离线节点</span>
        <span><i class="legend-dot is-fault"></i>故障节点</span>
        <span><i class="legend-line"></i>高德地图</span>
      </div>
    `;
    dom.nodeMapFallback.dataset.legendMode = mode;
    mapRenderState.legendMode = mode;
  }

  function buildAmapMarkerContent(node, index = 0) {
    const status = node.status || "offline";
    const selectedClass = node.nodeId === state.selectedNodeId ? "is-selected" : "";
    const statusText = getStatusLabel(status);
    const color = node.accentColor || getNodeVisualColor(node);
    const count = Number(node.turbineCount) || 0;
    const markerDelay = `${(index % 6) * -0.55}s`;
    return `
      <button
        class="amap-node-marker is-${status} ${selectedClass}"
        type="button"
        style="--node-color:${escapeHtml(color)};--marker-delay:${markerDelay};"
        aria-label="${escapeHtml(node.displayName)}"
      >
        <span class="amap-node-visual" aria-hidden="true">
          <span class="amap-node-pin">
            <strong>${escapeHtml(formatNodeShortCode(node.nodeId))}</strong>
            <em>${count}</em>
          </span>
          <span class="amap-node-shadow"></span>
        </span>
        <span class="amap-node-caption">
          <strong>${escapeHtml(node.displayName || node.nodeId)}</strong>
          <small>${escapeHtml(node.zoneLabel || "--")} · ${escapeHtml(statusText)}</small>
        </span>
      </button>
    `;
  }

  function renderAmapLocationPanel(locatedNodes, missingNodes, totalNodes) {
    const selectedMissing = missingNodes.find((node) => node.nodeId === state.selectedNodeId);
    const missingPreview = missingNodes.slice(0, 4);
    const moreCount = Math.max(0, missingNodes.length - missingPreview.length);
    return `
      <div class="amap-location-panel ${missingNodes.length ? "has-missing" : "is-complete"}" data-amap-location-panel>
        <div class="amap-location-status">
          <strong>已定位 ${locatedNodes.length} 个 / 未定位 ${missingNodes.length} 个</strong>
          <span>共 ${Number(totalNodes || locatedNodes.length)} 个注册节点</span>
        </div>
        ${
          selectedMissing
            ? `<div class="amap-location-alert">当前节点“${escapeHtml(selectedMissing.displayName || selectedMissing.nodeId)}”未配置经纬度，请点击左侧节点旁的定位按钮设置。</div>`
            : ""
        }
        ${
          missingNodes.length
            ? `<div class="amap-location-missing">
                ${missingPreview
                  .map((node) => `<span>${escapeHtml(node.displayName || node.nodeId)}</span>`)
                  .join("")}
                ${moreCount ? `<span>还有 ${moreCount} 个</span>` : ""}
              </div>`
            : ""
        }
      </div>
    `;
  }

  async function renderAmapNodeMap(nodes, token, options = {}) {
    const element = dom.nodeMapChart;
    if (!element) {
      return;
    }

    const nextSignature = buildAmapNodeSignature(nodes);
    const missingNodes = Array.isArray(options.missingNodes) ? options.missingNodes : [];
    const totalNodes = Number(options.totalNodes || nodes.length + missingNodes.length);
    const needsShell = !amapState.map || !element.querySelector("[data-amap-canvas]");
    renderMapLegend();
    mapRenderState.unavailableSignature = "";
    element.classList.add("is-amap-mode");
    if (needsShell) {
      element.innerHTML = `
        <div class="amap-node-map-shell">
          <div class="amap-node-map-canvas" data-amap-canvas></div>
          <div class="amap-map-meta">
            <span>高德地图</span>
            <strong data-amap-node-count>${nodes.length} 个节点</strong>
            <small>真实坐标模式</small>
          </div>
          <div data-amap-location-panel-host>
            ${renderAmapLocationPanel(nodes, missingNodes, totalNodes)}
          </div>
        </div>
      `;
    } else {
      const countElement = element.querySelector("[data-amap-node-count]");
      if (countElement) {
        countElement.textContent = `${nodes.length} 个节点`;
      }
      const panelHost = element.querySelector("[data-amap-location-panel-host]");
      if (panelHost) {
        panelHost.innerHTML = renderAmapLocationPanel(nodes, missingNodes, totalNodes);
      } else {
        element.querySelector(".amap-node-map-shell")?.insertAdjacentHTML(
          "beforeend",
          `<div data-amap-location-panel-host>${renderAmapLocationPanel(nodes, missingNodes, totalNodes)}</div>`
        );
      }
    }

    const canvas = element.querySelector("[data-amap-canvas]");
    if (!canvas) {
      return;
    }

    const AMap = await loadAmap();
    if (token !== amapState.renderToken) {
      return;
    }

    let map = amapState.map;
    const nextMapStyle = getAmapMapStyle();
    if (!map) {
      map = new AMap.Map(canvas, {
        center: getAmapDefaultCenter(nodes),
        zoom: getAmapDefaultZoom(),
        viewMode: "2D",
        resizeEnable: true,
        mapStyle: nextMapStyle,
      });
      amapState.map = map;
      amapState.mapStyle = nextMapStyle;

      if (AMap.Scale) {
        map.addControl(new AMap.Scale());
      }
      if (AMap.ToolBar) {
        map.addControl(new AMap.ToolBar({ position: { right: "18px", top: "18px" } }));
      }
    } else if (amapState.mapStyle !== nextMapStyle) {
      map.setMapStyle(nextMapStyle);
      amapState.mapStyle = nextMapStyle;
    }

    if (amapState.nodeSignature === nextSignature && amapState.markers.length) {
      return;
    }

    removeAmapMarkers();
    const markers = nodes.map((node, index) => {
      const marker = new AMap.Marker({
        position: getValidGeo(node),
        content: buildAmapMarkerContent(node, index),
        anchor: "bottom-center",
        zIndex: node.nodeId === state.selectedNodeId ? 120 : 100,
      });
      marker.on("click", () => {
        handleMapNodeClick(node.nodeId).catch((error) => console.error("[dashboard] map node select failed", error));
      });
      return marker;
    });

    amapState.markers = markers;
    amapState.nodeSignature = nextSignature;
    map.add(markers);
    const selectedNode = nodes.find((node) => node.nodeId === state.selectedNodeId);
    if (amapState.fittedSignature !== nextSignature && selectedNode) {
      map.setZoomAndCenter(Math.max(getAmapDefaultZoom(), 13), getValidGeo(selectedNode));
      amapState.fittedSignature = nextSignature;
    } else if (amapState.fittedSignature !== nextSignature && markers.length > 1) {
      map.setFitView(markers, false, [96, 96, 96, 96], 16);
      amapState.fittedSignature = nextSignature;
    } else if (amapState.fittedSignature !== nextSignature && markers.length === 1) {
      map.setZoomAndCenter(Math.max(getAmapDefaultZoom(), 12), getValidGeo(nodes[0]));
      amapState.fittedSignature = nextSignature;
    }
  }

  function renderAmapUnavailable(nodes, reason) {
    const element = dom.nodeMapChart;
    if (!element) {
      return;
    }
    const nextSignature = buildUnavailableRenderSignature(nodes, reason);
    if (
      mapRenderState.unavailableSignature === nextSignature &&
      element.querySelector(".amap-unavailable-shell")
    ) {
      return;
    }
    amapState.renderToken += 1;
    disposeAmapMap();
    renderMapLegend();
    element.classList.add("is-amap-mode");
    const emptyLocation = String(reason || "").includes("暂无可定位节点");
    const title = emptyLocation ? "暂无可定位节点" : "高德地图不可用";
    const note = emptyLocation
      ? "请在左侧展开用户和节点，点击节点旁的定位按钮设置经纬度；设置后即可显示真实高德地图。"
      : "当前页面只保留高德地图模式，请检查网络、Key 配置或安全域名。";
    element.innerHTML = `
      <div class="amap-unavailable-shell">
        <div class="amap-unavailable-card">
          <div class="amap-unavailable-title">${escapeHtml(title)}</div>
          <div class="amap-unavailable-reason">${escapeHtml(reason || "请检查地图配置")}</div>
          <div class="amap-unavailable-note">${escapeHtml(note)}</div>
        </div>
        <div class="amap-unavailable-count">${nodes.length} 个节点</div>
      </div>
    `;
    mapRenderState.unavailableSignature = nextSignature;
  }

  function renderMapChart() {
    const nodes = buildMapNodes();
    const availability = getAmapAvailability(nodes);
    if (!availability.usable) {
      renderAmapUnavailable(nodes, availability.reason);
      return;
    }

    const token = amapState.renderToken + 1;
    amapState.renderToken = token;
    renderAmapNodeMap(availability.locatedNodes, token, {
      missingNodes: availability.missingNodes,
      totalNodes: nodes.length,
    }).catch((error) => {
      console.warn("[dashboard] amap render failed", error);
      if (token === amapState.renderToken) {
        renderAmapUnavailable(nodes, "高德地图加载失败，请检查网络或 Key 配置");
      }
    });
  }

  function renderTurbineTree() {
    if (!dom.turbineTree) {
      return;
    }
    if (!state.selectedNodeId) {
      disposeTurbineTreeChart();
      dom.turbineTree.innerHTML = '<div class="turbine-tree-empty">请先选择地图节点。</div>';
      return;
    }

    const node = resolveNodeMeta(state.selectedNodeId);
    const turbineCodes = availableTurbines();
    if (!turbineCodes.length) {
      disposeTurbineTreeChart();
      dom.turbineTree.innerHTML = '<div class="turbine-tree-empty">当前节点没有可用的发电机清单。</div>';
      return;
    }

    renderTurbineTreeGraph(node, turbineCodes);
  }

  function disposeTurbineTreeChart() {
    if (chartStore.turbineTree) {
      chartStore.turbineTree.dispose();
      chartStore.turbineTree = null;
    }
    dom.turbineTree?.classList.remove("is-graph-mode");
    if (dom.turbineTree) {
      dom.turbineTree.style.height = "";
    }
  }

  function ensureTurbineTreeChart() {
    if (!dom.turbineTree || typeof echarts !== "object") {
      return null;
    }
    if (!chartStore.turbineTree || chartStore.turbineTree.isDisposed?.()) {
      chartStore.turbineTree = echarts.init(dom.turbineTree);
      chartStore.turbineTree.off("click");
      chartStore.turbineTree.off("dblclick");
      const handleTreeGraphNodeAction = (params) => {
        if (params.dataType !== "node") {
          return;
        }
        const item = params.data || {};
        if (item.nodeKind === "root") {
          toggleTurbineRootGroups(item.nodeId || state.selectedNodeId);
          return;
        }
        if (item.nodeKind === "group") {
          toggleTurbineGroup(item.groupId || "");
          return;
        }
        if (item.nodeKind === "turbine") {
          selectTurbine(item.turbineCode || "").catch((error) =>
            console.error("[dashboard] select turbine failed", error)
          );
        }
      };
      chartStore.turbineTree.on("click", handleTreeGraphNodeAction);
      chartStore.turbineTree.on("dblclick", handleTreeGraphNodeAction);
    }
    return chartStore.turbineTree;
  }

  function buildRadialTurbineTreeLayout(turbineGroups, expandedGroups, rootCollapsed, containerWidth) {
    const canvasWidth = Math.max(980, Number(containerWidth) || 980);
    const groupCount = turbineGroups.length;
    const rootSize = { width: 154, height: 74 };
    const groupSize = { width: 122, height: 56 };
    const turbineSize = { width: 70, height: 36 };
    const margin = 76;
    const centerX = Math.max(300, Math.min(canvasWidth * 0.42, canvasWidth - 410));
    const groupRadius = Math.max(190, Math.min(330, canvasWidth * 0.23));
    const turbineRadius = Math.max(178, Math.min(250, canvasWidth * 0.17));
    const baseCenterY = groupRadius + turbineRadius + margin;

    const points = [
      {
        kind: "root",
        x: centerX,
        y: baseCenterY,
        width: rootSize.width,
        height: rootSize.height,
      },
    ];

    const groupLayouts = rootCollapsed
      ? []
      : turbineGroups.map((group, index) => {
          const expanded = expandedGroups.has(group.groupId);
          const angle = groupCount <= 1 ? 0 : -Math.PI / 2 + (index * Math.PI * 2) / groupCount;
          const groupX = centerX + Math.cos(angle) * groupRadius;
          const groupY = baseCenterY + Math.sin(angle) * groupRadius;
          const visibleItems = expanded ? group.items : [];
          const fanSpan = Math.min(Math.PI * 1.25, Math.max(Math.PI * 0.55, visibleItems.length * 0.38));
          const itemLayouts = visibleItems.map((code, itemIndex) => {
            const offset = visibleItems.length <= 1
              ? 0
              : (itemIndex / (visibleItems.length - 1) - 0.5) * fanSpan;
            const itemAngle = angle + offset;
            return {
              code,
              x: groupX + Math.cos(itemAngle) * turbineRadius,
              y: groupY + Math.sin(itemAngle) * turbineRadius,
              angle: itemAngle,
            };
          });

          points.push({
            kind: "group",
            x: groupX,
            y: groupY,
            width: groupSize.width,
            height: groupSize.height,
          });
          itemLayouts.forEach((item) => {
            points.push({
              kind: "turbine",
              x: item.x,
              y: item.y,
              width: turbineSize.width,
              height: turbineSize.height,
            });
          });

          return { group, expanded, angle, x: groupX, y: groupY, itemLayouts };
        });

    const bounds = points.reduce(
      (acc, point) => ({
        minX: Math.min(acc.minX, point.x - point.width / 2),
        maxX: Math.max(acc.maxX, point.x + point.width / 2),
        minY: Math.min(acc.minY, point.y - point.height / 2),
        maxY: Math.max(acc.maxY, point.y + point.height / 2),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }
    );

    const shiftX = Math.max(0, margin - bounds.minX)
      - Math.max(0, bounds.maxX - (canvasWidth - margin));
    const shiftY = Math.max(0, margin - bounds.minY);
    const root = { x: centerX + shiftX, y: baseCenterY + shiftY };
    const shiftedGroups = groupLayouts.map((layout) => ({
      ...layout,
      x: layout.x + shiftX,
      y: layout.y + shiftY,
      itemLayouts: layout.itemLayouts.map((item) => ({
        ...item,
        x: item.x + shiftX,
        y: item.y + shiftY,
      })),
    }));
    const canvasHeight = Math.max(520, bounds.maxY - bounds.minY + margin * 2);

    return { canvasWidth, canvasHeight, root, groupLayouts: shiftedGroups };
  }

  function renderTurbineTreeGraph(node, turbineCodes) {
    const chart = ensureTurbineTreeChart();
    if (!chart) {
      return;
    }

    const turbineGroups = buildTurbineGroups(turbineCodes);
    const expandedGroups = getExpandedGroupsForRender(state.selectedNodeId, turbineGroups);
    const rootCollapsed = isTurbineRootCollapsed(state.selectedNodeId);
    const layout = buildRadialTurbineTreeLayout(
      turbineGroups,
      expandedGroups,
      rootCollapsed,
      (dom.turbineTree?.clientWidth || 960) - 16
    );
    const treePalette = getTreeGraphPalette();
    const groupLayouts = layout.groupLayouts;

    dom.turbineTree.style.height = `${layout.canvasHeight}px`;
    dom.turbineTree.classList.add("is-graph-mode");

    const nodeStatus = node.status || "offline";
    const rootActionText = rootCollapsed ? "展开分组" : "收回分组";

    const graphNodes = [
      {
        id: `node:${node.nodeId}`,
        name: formatNodeShortCode(node.nodeId),
        nodeKind: "root",
        nodeId: node.nodeId,
        x: layout.root.x,
        y: layout.root.y,
        symbol: "roundRect",
        symbolSize: [154, 74],
        draggable: true,
        fixed: true,
        value: rootActionText,
        itemStyle: {
          color: treePalette.rootFill,
          borderColor: treePalette.rootBorder,
          borderWidth: 3,
          shadowBlur: 14,
          shadowColor: withAlpha(treePalette.rootShadow, 0.42),
        },
        label: {
          show: true,
          formatter: `{code|${formatNodeShortCode(node.nodeId)}}\n{name|${getStatusLabel(nodeStatus)} · ${rootActionText}}`,
          rich: {
            code: { color: treePalette.rootText, fontSize: 18, fontWeight: 800, lineHeight: 24 },
            name: { color: treePalette.rootSubText, fontSize: 11, lineHeight: 16 },
          },
        },
      },
    ];

    const graphLinks = [];

    groupLayouts.forEach((layout) => {
      const selectedInGroup = layout.group.items.includes(state.selectedTurbineCode);
      const groupColor = layout.expanded
        ? treePalette.groupExpanded
        : selectedInGroup
          ? treePalette.groupSelected
          : treePalette.groupDefault;
      graphNodes.push({
        id: `group:${layout.group.groupId}`,
        name: layout.group.label,
        nodeKind: "group",
        groupId: layout.group.groupId,
        x: layout.x,
        y: layout.y,
        symbol: "roundRect",
        symbolSize: layout.expanded ? [128, 58] : [116, 54],
        draggable: true,
        fixed: true,
        value: layout.expanded ? "收起" : "展开",
        itemStyle: {
          color: treePalette.groupFill,
          borderColor: groupColor,
          borderWidth: layout.expanded ? 4 : 3,
          shadowBlur: layout.expanded ? 14 : 4,
          shadowColor: withAlpha(groupColor, layout.expanded ? 0.32 : 0.16),
        },
        label: {
          show: true,
          formatter: `{code|${layout.group.label}}\n{name|${layout.group.items.length} 台 · ${layout.expanded ? "收起" : "展开"}}`,
          rich: {
            code: { color: treePalette.groupText, fontSize: 13, fontWeight: 800, lineHeight: 20 },
            name: { color: treePalette.groupSubText, fontSize: 10, lineHeight: 14 },
          },
        },
      });
      graphLinks.push({
        source: `node:${node.nodeId}`,
        target: `group:${layout.group.groupId}`,
        lineStyle: { color: treePalette.link, width: 3, curveness: 0.18 },
      });

      layout.itemLayouts.forEach((item) => {
        const snapshot = latestSnapshotForCode(item.code);
        const selected = item.code === state.selectedTurbineCode;
        const turbineColor = selected ? "#2563eb" : snapshot ? "#16a34a" : node.online ? "#d97706" : "#64748b";
        graphNodes.push({
          id: `turbine:${item.code}`,
          name: item.code,
          nodeKind: "turbine",
          turbineCode: item.code,
          x: item.x,
          y: item.y,
          symbol: "roundRect",
          symbolSize: selected ? [78, 40] : [70, 36],
          draggable: true,
          fixed: true,
          value: snapshot ? "有数据" : "无数据",
          itemStyle: {
            color: selected ? treePalette.turbineSelectedFill : treePalette.turbineFill,
            borderColor: turbineColor,
            borderWidth: selected ? 4 : 2,
            shadowBlur: selected ? 12 : 3,
            shadowColor: withAlpha(turbineColor, selected ? 0.32 : 0.14),
          },
          label: {
            show: true,
          formatter: `{code|${item.code}}\n{name|${snapshot ? "有数据" : "无数据"}}`,
          rich: {
              code: { color: treePalette.turbineText, fontSize: 11, fontWeight: 800, lineHeight: 15 },
              name: { color: treePalette.turbineSubText, fontSize: 8, lineHeight: 11 },
            },
          },
        });
        graphLinks.push({
          source: `group:${layout.group.groupId}`,
          target: `turbine:${item.code}`,
          lineStyle: { color: withAlpha(turbineColor, 0.52), width: 2.2, curveness: 0.14 },
        });
      });
    });

    chart.setOption(
      {
        backgroundColor: "transparent",
        animationDurationUpdate: 280,
        tooltip: {
          trigger: "item",
          backgroundColor: treePalette.tooltipBg,
          borderColor: treePalette.tooltipBorder,
          textStyle: { color: treePalette.tooltipText },
          formatter(params) {
            const item = params.data || {};
            if (item.nodeKind === "root") {
              return `${node.displayName || node.nodeId}<br/>${node.zoneLabel || "--"}<br/>${item.value}`;
            }
            if (item.nodeKind === "group") {
              return `${item.name}<br/>${item.value}`;
            }
            if (item.nodeKind === "turbine") {
              return `发电机 ${item.turbineCode}<br/>${item.value}`;
            }
            return params.name || "";
          },
        },
        graphic: [
          {
            type: "text",
            left: 22,
            top: 18,
            style: {
              text: rootCollapsed
                ? "点击主节点展开分组。"
                : "点击主节点收回分组；点击分组展开或收起。",
              fill: treePalette.hintText,
              font: "12px Microsoft YaHei, sans-serif",
            },
          },
        ],
        series: [
          {
            type: "graph",
            layout: "none",
            roam: true,
            draggable: true,
            edgeSymbol: ["none", "arrow"],
            edgeSymbolSize: [0, 8],
            emphasis: {
              focus: "adjacency",
              lineStyle: { width: 4 },
            },
            data: graphNodes,
            links: graphLinks,
            lineStyle: {
              color: treePalette.link,
              width: 2,
              curveness: 0.16,
            },
            label: {
              show: true,
              color: treePalette.seriesLabel,
            },
          },
        ],
      },
      true
    );
    chart.resize();
  }

  function renderMetricCards() {
    const snapshot = latestSnapshotForCode();
    const hint = state.selectedTurbineCode
      ? `${state.selectedNodeId || "--"} · 发电机 ${state.selectedTurbineCode}`
      : "等待选择发电机";
    metrics.forEach((metric) => {
      setMetricCardValue(metric, snapshot ? snapshot.turbine[metric.key] : null);
      setText(`cardHint-${metric.key}`, hint);
    });
  }

  function placeholderCopy(title, text, kicker = isMonitorPage ? "实时下钻" : "历史下钻") {
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
        title: waveOnlyPage ? "请先在左侧选择节点" : "请先选择地图节点",
        text: waveOnlyPage
          ? "在左侧按用户、节点、发电机展开，选择实时监测或数据概览后查看四图波形。"
          : "在节点地图中点击目标节点，地图会聚焦到该节点。",
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
      chart.__windsightMetricKey = metric.key;
      chart.on("dataZoom", (event) => {
        if (state.syncingMetricZoom) {
          return;
        }
        const remembered = rememberMetricZoomFromChart(chart, metric.key, event);
        syncMetricXZoom(chart, remembered.xRange, remembered.xIsFull);
      });
      setupMetricChartZoom(chart, element, metric.key);
      chartStore.metrics.set(metric.key, chart);
    });
  }

  function buildMetricOption(metric, index) {
    const palette = getThemePalette();
    const axisColor = palette.axisText;
    const chartRows = rowsForSelectedTurbine();
    const times = chartRows.map((row) => row.timestamp || "");
    const xMax = Math.max(times.length - 1, 1);
    const seriesData = [];
    const anomalyData = [];
    chartRows.forEach((row, rowIndex) => {
      const turbine = row?.turbines?.[state.selectedTurbineCode];
      const value = turbine ? turbine[metric.key] : null;
      const metricValue = safeNumber(value);
      const gapInfo = rowGapInfo(row, rowIndex, chartRows);
      if (gapInfo.hasGap) {
        seriesData.push({
          value: [Math.max(0, rowIndex - 0.001), null],
          rowIndex,
          isGapBreak: true,
        });
      }
      const point = {
        value: [rowIndex, metricValue],
        rowIndex,
        isGapAfterPrevious: gapInfo.hasGap,
        gapSeconds: gapInfo.gap,
        expectedIntervalSeconds: gapInfo.interval,
        gapThresholdSeconds: gapInfo.threshold,
      };
      seriesData.push(point);
      if (gapInfo.hasGap && metricValue !== null) {
        anomalyData.push(point);
      }
    });

    return {
      animation: false,
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        backgroundColor: palette.tooltipBg,
        borderColor: palette.tooltipBorder,
        borderWidth: 1,
        textStyle: {
          color: palette.tooltipText,
        },
        extraCssText:
          getThemeMode() === "dark"
            ? "box-shadow: 0 16px 28px rgba(0, 0, 0, 0.32); border-radius: 12px;"
            : "box-shadow: 0 14px 24px rgba(116, 142, 172, 0.16); border-radius: 12px;",
        formatter(params) {
          const list = Array.isArray(params) ? params : [params];
          const point =
            list.find((item) => item?.data && item.data.isGapAfterPrevious && Array.isArray(item.value)) ||
            list.find((item) => item?.data && !item.data.isGapBreak && Array.isArray(item.value)) ||
            list[0];
          const data = point?.data || {};
          const value = Array.isArray(point?.value) ? point.value : [point?.dataIndex, point?.value];
          const rowIndex = Number.isInteger(data.rowIndex) ? data.rowIndex : Math.round(Number(value?.[0]));
          const metricValue = Number(value?.[1]);
          const time = times[rowIndex] || "--";
          const textValue = Number.isFinite(metricValue) ? metricValue.toFixed(2) : "--";
          const lines = [`${time}`, `${metric.label}: ${textValue} ${metric.unit}`];
          if (data.isGapAfterPrevious && Number.isFinite(Number(data.gapSeconds))) {
            lines.push(
              `<span style="color:#ef4444">上传断档：间隔 ${formatDurationSeconds(data.gapSeconds)}，超过阈值 ${formatDurationSeconds(data.gapThresholdSeconds)}</span>`
            );
          }
          return lines.join("<br/>");
        },
      },
      grid: {
        left: 48,
        right: 18,
        top: 36,
        bottom: index === metrics.length - 1 ? 48 : 24,
      },
      xAxis: {
        type: "value",
        min: 0,
        max: xMax,
        axisLine: {
          lineStyle: { color: palette.axisLine },
        },
        axisLabel: {
          color: axisColor,
          hideOverlap: true,
          formatter(value) {
            const rowIndex = Math.round(Number(value));
            if (!Number.isFinite(rowIndex) || Math.abs(Number(value) - rowIndex) > 0.25) {
              return "";
            }
            const timestamp = times[rowIndex];
            if (!timestamp) {
              return "";
            }
            const parts = String(timestamp).split(/[ T]/);
            return (parts[1] || parts[0] || "").slice(0, 8);
          },
        },
      },
      yAxis: {
        type: "value",
        min: metric.min,
        max: metric.max,
        scale: false,
        name: "",
        nameTextStyle: {
          color: axisColor,
        },
        axisLabel: {
          color: axisColor,
        },
        splitLine: {
          lineStyle: { color: palette.splitLine },
        },
      },
      dataZoom: [
        applyMetricZoom({
          id: "metric-x-inside",
          type: "inside",
          xAxisIndex: 0,
          filterMode: "none",
          zoomOnMouseWheel: false,
          moveOnMouseMove: false,
          moveOnMouseWheel: false,
        }, "x", metric.key),
        applyMetricZoom({
          id: "metric-y-inside",
          type: "inside",
          yAxisIndex: 0,
          filterMode: "none",
          zoomOnMouseWheel: false,
          moveOnMouseMove: false,
          moveOnMouseWheel: false,
        }, "y", metric.key),
        ...(index === metrics.length - 1
          ? [
              applyMetricZoom({
                id: "metric-x-slider",
                type: "slider",
                xAxisIndex: 0,
                height: 16,
                bottom: 10,
                filterMode: "none",
                borderColor: palette.zoomBorder,
                fillerColor: palette.zoomFill,
                backgroundColor: palette.zoomBg,
              }, "x", metric.key),
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
              { offset: 0, color: withAlpha(metric.color, getThemeMode() === "dark" ? 0.34 : 0.22) },
              { offset: 1, color: withAlpha(metric.color, getThemeMode() === "dark" ? 0.05 : 0.02) },
            ]),
          },
          data: seriesData,
        },
        {
          type: "scatter",
          name: "上传断档",
          symbol: "diamond",
          symbolSize: 11,
          z: 6,
          itemStyle: {
            color: "#ef4444",
            borderColor: "#ffffff",
            borderWidth: 1,
          },
          emphasis: {
            scale: 1.4,
          },
          data: anomalyData,
        },
      ],
    };
  }

  function clearMetricCharts() {
    chartStore.metrics.forEach((chart) => chart.clear());
  }

  function resizeNodeMap() {
    if (amapState.map?.resize) {
      amapState.map.resize();
    }
  }

  function resizeCharts() {
    resizeNodeMap();
    chartStore.turbineTree?.resize();
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

  function renderAll() {
    if (!waveOnlyPage) {
      renderMapSummary();
      renderMapChart();
      renderTurbineTree();
    }
    renderSelectionSummary();
    renderMetricCards();
    renderMetricCharts();
  }

  function buildHistoryUrl() {
    const params = new URLSearchParams();
    params.set("node_id", state.selectedNodeId);
    params.set("limit", String(currentLimit()));
    if (state.selectedTurbineCode) {
      params.set("turbine", state.selectedTurbineCode);
    }
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
    if (waveOnlyPage && !state.selectedTurbineCode) {
      clearUploads();
      renderAll();
      return;
    }
    const result = await fetchJson(buildHistoryUrl());
    const rows = Array.isArray(result.data) ? result.data : [];
    state.uploads = rows;
    state.uploadIds = new Set(rows.map((row) => getRowKey(row)));
    reflectOverviewLoadedRange(rows);
    if (rows.length) {
      updateNodeFromRow(rows[rows.length - 1]);
    }
    renderAll();
  }

  async function loadUserRuntimeConfig() {
    if (isAdminUser) {
      return;
    }
    try {
      const result = await fetchJson("/api/my/config");
      const data = result.data || {};
      const nextInterval = Number(data.poll_interval || 3000);
      pollIntervalMs = Math.min(30000, Math.max(500, Number.isFinite(nextInterval) ? nextInterval : 3000));
      runtimeConfig.autoRefresh = data.auto_refresh !== false;
      runtimeConfig.showDebugLog = !!data.show_debug_log;
      debugLog("user runtime config loaded", { pollIntervalMs, ...runtimeConfig });
    } catch (error) {
      console.warn("[dashboard] user config fallback to defaults", error);
    }
  }

  function stopPolling() {
    if (state.pollTimer) {
      window.clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    if (!isMonitorPage || !state.selectedNodeId || !runtimeConfig.autoRefresh) {
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
      state.expandedTurbineGroups.clear();
      resetMetricZoom();
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

    const sameNode = state.selectedNodeId === nextId;
    state.selectedNodeId = nextId;
    if (!sameNode) {
      resetMetricZoom();
    }
    if (clearTurbine) {
      state.selectedTurbineCode = "";
      resetExpandedGroups(nextId);
    } else if (!sameNode) {
      resetExpandedGroups(nextId);
    }
    clearUploads();
    if (state.selectedTurbineCode) {
      ensureExpandedGroupForTurbine(state.selectedTurbineCode, nextId);
    }
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

  function appendRealtimeRow(row) {
    if (!row || row.node_id !== state.selectedNodeId) {
      return;
    }
    const rowKey = getRowKey(row);
    if (state.uploadIds.has(rowKey)) {
      return;
    }
    updateNodeFromRow(row, { markOnline: true, updateLastUpload: true });
    if (state.selectedTurbineCode && !row?.turbines?.[state.selectedTurbineCode]) {
      renderSelectionSummary();
      renderTurbineTree();
      return;
    }
    state.uploads.push(row);
    state.uploadIds.add(rowKey);
    const limit = currentLimit();
    if (state.uploads.length > limit) {
      state.uploads = state.uploads.slice(-limit);
      state.uploadIds = new Set(state.uploads.map((item) => getRowKey(item)));
    }
    renderAll();
  }

  function formatDateTimeLocal(date, options = {}) {
    const pad = (value) => String(value).padStart(2, "0");
    const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
      date.getMinutes()
    )}`;
    return options.includeSeconds ? `${base}:${pad(date.getSeconds())}` : base;
  }

  async function applyQuickRange(minutes) {
    if (!dom.historyStart || !dom.historyEnd) {
      return;
    }
    const now = new Date();
    const start = new Date(now.getTime() - Number(minutes) * 60 * 1000);
    dom.historyStart.value = formatDateTimeLocal(start, { includeSeconds: isOverviewPage });
    dom.historyEnd.value = formatDateTimeLocal(now, { includeSeconds: isOverviewPage });
    if (isOverviewPage) {
      state.historyEditOrder = ["start", "end"];
      const linked = await syncHistoryLinkedFields();
      if (!linked) {
        return;
      }
    }
    if (canLoadHistoryForCurrentSelection()) {
      await loadHistory();
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
    const handler = (payload) => {
      if (!runtimeConfig.autoRefresh) {
        return;
      }
      appendRealtimeRow(payload?.data || payload);
    };
    socket.on("monitor_update", handler);
    socket.on("node_data_update", handler);
  }

  function renderSelectionSummary() {
    const node = state.selectedNodeId ? resolveNodeMeta(state.selectedNodeId) : null;
    const latestTime =
      latestSnapshotForCode()?.row?.timestamp || state.uploads[state.uploads.length - 1]?.timestamp || "--";

    setText("selectedNodeLabel", node ? `${node.displayName} (${node.nodeId})` : "请选择地图节点");
    setText("selectedNodeZone", node ? node.zoneLabel : "--");
    setText("selectedNodeStatus", node ? getStatusLabel(node.status) : "--");
    setText("selectedNodeTime", node?.lastUpload || "--");
    setText("selectedNodeDescription", node ? node.description : "--");
    setText("selectedTurbineLabel", state.selectedTurbineCode ? `发电机 ${state.selectedTurbineCode}` : "请在树中选择");
    setText(dom.topbarNodeChip, node ? node.displayName : "未选择节点");
    if (dom.topbarStatusChip) {
      setText(dom.topbarStatusChip, node ? `节点${getStatusLabel(node.status)}` : "等待接入");
    }
    setText(dom.lastDataTime, latestTime);
    setText(dom.chartNodeChip, node ? node.displayName : "未选择节点");
    setText(dom.chartTurbineChip, state.selectedTurbineCode ? `发电机 ${state.selectedTurbineCode}` : "未选择发电机");
    setText(dom.chartStatusChip, node ? `节点${getStatusLabel(node.status)}` : "等待接入");
    setText(
      dom.chartUploadIntervalChip,
      node
        ? `上传周期 ${formatDurationSeconds(node.uploadIntervalSeconds)} / 断档 ${formatDurationSeconds(
            Math.max(minChannelGapThresholdSeconds, node.uploadIntervalSeconds * uploadGapThresholdMultiplier)
          )}`
        : "上传周期 --"
    );
    setText(dom.chartLastDataTime, latestTime);
  }

  function setViewSection(element, active) {
    if (!element) {
      return;
    }
    element.classList.toggle("is-active", active);
    element.setAttribute("aria-hidden", String(!active));
  }

  function setView(mode) {
    if (!usesDrilldownView) {
      return;
    }
    let nextMode = mode;
    if (isMapPage) {
      nextMode = "map";
    }
    else if (waveOnlyPage) {
      nextMode = "chart";
    } else if (nextMode === "chart" && (!state.selectedNodeId || !state.selectedTurbineCode)) {
      nextMode = state.selectedNodeId ? "tree" : "map";
    } else if (nextMode === "tree" && !state.selectedNodeId) {
      nextMode = "map";
    }

    state.view = nextMode;
    persistView(state.view);
    const mapMode = !waveOnlyPage && nextMode === "map";
    const treeMode = !waveOnlyPage && nextMode === "tree";
    const chartMode = nextMode === "chart";

    setViewSection(dom.mapView, mapMode);
    setViewSection(dom.treeView, treeMode);
    setViewSection(dom.chartView, chartMode);

    if (dom.btnBackToMap) {
      dom.btnBackToMap.classList.toggle("is-hidden", waveOnlyPage || !treeMode);
    }
    if (dom.btnBackToTree) {
      dom.btnBackToTree.classList.toggle("is-hidden", waveOnlyPage || !chartMode);
    }

    requestAnimationFrame(() => {
      if (mapMode) {
        resizeNodeMap();
      }
      if (treeMode && chartStore.turbineTree) {
        chartStore.turbineTree.resize();
      }
      if (chartMode) {
        chartStore.metrics.forEach((chart) => chart.resize());
      }
    });
  }

  async function handleMapNodeClick(nodeId) {
    const nextId = String(nodeId || "").trim();
    if (!nextId) {
      return;
    }
    if (isMapPage) {
      window.localStorage.setItem(storageNodeKey, nextId);
      window.localStorage.removeItem(storageTurbineKey);
      const params = new URLSearchParams(window.location.search);
      params.set("select", nextId);
      params.delete("node_id");
      params.delete("turbine");
      params.delete("generator");
      params.delete("view");
      const nextUrl = `${window.location.pathname}?${params.toString()}`;
      window.location.href = nextUrl;
      return;
    }
    await jumpToTree(nextId);
  }

  async function jumpToTree(nodeId = state.selectedNodeId) {
    const nextId = String(nodeId || "").trim();
    if (!nextId) {
      jumpToMap();
      return;
    }
    setView("tree");
    await selectNode(nextId, { clearTurbine: true, loadAfterSelect: isMonitorPage });
    setView("tree");
  }

  async function jumpToDetail(nodeId) {
    await jumpToTree(nodeId);
  }

  function jumpToMap() {
    setView("map");
    requestAnimationFrame(resizeNodeMap);
  }

  function jumpToTreeView() {
    if (!state.selectedNodeId) {
      jumpToMap();
      return;
    }
    setView("tree");
  }

  async function selectTurbine(turbineCode) {
    const nextCode = String(turbineCode || "").trim();
    if (!nextCode) {
      return;
    }
    if (state.selectedTurbineCode !== nextCode) {
      resetMetricZoom();
    }
    state.selectedTurbineCode = nextCode;
    ensureExpandedGroupForTurbine(state.selectedTurbineCode);
    persistSelection();
    setView("chart");
    renderAll();

    if (!state.selectedNodeId) {
      return;
    }
    await loadHistory();
  }

  async function confirmHistoryFilters() {
    normalizeHistoryLimit();
    if (isOverviewPage) {
      const linked = await syncHistoryLinkedFields();
      if (!linked) {
        return;
      }
      if (!canLoadHistoryForCurrentSelection()) {
        setHistoryHint("筛选条件已更新，选择节点和发电机后生效。", "info");
        return;
      }
      await loadHistory();
      return;
    }

    await loadHistory();
  }

  function bindEvents() {
    dom.btnReload?.addEventListener("click", () => {
      confirmHistoryFilters().catch((error) => {
        setHistoryHint("筛选条件联动失败，请检查输入后重试。", "error");
        console.error("[dashboard] reload failed", error);
      });
    });

    dom.historyLimit?.addEventListener("input", () => {
      recordHistoryEdit("limit");
    });

    dom.historyStart?.addEventListener("input", () => {
      recordHistoryEdit("start");
    });

    dom.historyEnd?.addEventListener("input", () => {
      recordHistoryEdit("end");
    });

    dom.historyLimit?.addEventListener("change", () => {
      recordHistoryEdit("limit");
      dom.historyLimit.value = String(currentLimit());
      if (!isOverviewPage && state.selectedNodeId && (!isMonitorPage ? state.selectedTurbineCode : true)) {
        loadHistory().catch((error) => console.error("[dashboard] limit change failed", error));
      }
    });

    dom.historyStart?.addEventListener("change", () => {
      recordHistoryEdit("start");
      if (!isOverviewPage) {
        loadHistory().catch((error) => console.error("[dashboard] start change failed", error));
      }
    });

    dom.historyEnd?.addEventListener("change", () => {
      recordHistoryEdit("end");
      if (!isOverviewPage) {
        loadHistory().catch((error) => console.error("[dashboard] end change failed", error));
      }
    });

    [dom.historyLimit, dom.historyStart, dom.historyEnd].forEach((input) => {
      input?.addEventListener("keydown", (event) => {
        if (!isOverviewPage || event.key !== "Enter") {
          return;
        }
        event.preventDefault();
        confirmHistoryFilters().catch((error) => {
          setHistoryHint("筛选条件联动失败，请检查输入后重试。", "error");
          console.error("[dashboard] enter confirm failed", error);
        });
      });
    });

    dom.btnClearRange?.addEventListener("click", () => {
      if (dom.historyStart) dom.historyStart.value = "";
      if (dom.historyEnd) dom.historyEnd.value = "";
      if (isOverviewPage) {
        state.historyEditOrder = ["limit"];
        setHistoryHint("", "info");
      }
      if (!isOverviewPage) {
        loadHistory().catch((error) => console.error("[dashboard] clear range failed", error));
      } else if (canLoadHistoryForCurrentSelection()) {
        loadHistory().catch((error) => console.error("[dashboard] clear range failed", error));
      }
    });

    document.querySelectorAll("[data-range-min]").forEach((button) => {
      button.addEventListener("click", () => {
        applyQuickRange(button.dataset.rangeMin || "0").catch((error) => {
          setHistoryHint("快捷时段联动失败，请重试。", "error");
          console.error("[dashboard] quick range failed", error);
        });
      });
    });

    dom.btnBackToMap?.addEventListener("click", jumpToMap);
    dom.btnBackToTree?.addEventListener("click", jumpToTreeView);
    window.addEventListener("resize", resizeCharts);
    window.addEventListener("windsight:themechange", () => {
      renderAll();
      requestAnimationFrame(resizeCharts);
    });
  }

  function resolveInitialView(options = {}) {
    const savedView = usesDrilldownView ? window.localStorage.getItem(storageViewKey) || "" : "";
    const preferTree = !!options.preferTree;
    const forceChart = !!options.forceChart;

    if (!usesDrilldownView) {
      return "chart";
    }
    if (isMapPage) {
      return "map";
    }
    if (waveOnlyPage) {
      return "chart";
    }
    if (forceChart && state.selectedNodeId && state.selectedTurbineCode) {
      return "chart";
    }
    if ((preferTree || savedView === "tree") && state.selectedNodeId) {
      return "tree";
    }
    if (savedView === "chart" && state.selectedNodeId && state.selectedTurbineCode) {
      return "chart";
    }
    if (savedView === "map") {
      return "map";
    }
    if (state.selectedNodeId && !state.selectedTurbineCode) {
      return "tree";
    }
    return "map";
  }

  async function loadNodes() {
    const queryParams = new URLSearchParams(window.location.search);
    const result = await fetchNodesForContext(queryParams);
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

    const userFromQuery = queryParams.get("user_id") || "";
    const fromQuery = queryParams.get("select") || "";
    const turbineFromQuery = queryParams.get("turbine") || queryParams.get("generator") || "";
    const viewFromQuery = (queryParams.get("view") || queryParams.get("mode") || "").toLowerCase();
    const canRestoreStoredSelection = !userFromQuery && !fromQuery;
    const storedNode = window.localStorage.getItem(storageNodeKey) || "";
    const canRestoreStoredTurbine = canRestoreStoredSelection || (isMapPage && !!fromQuery && storedNode === fromQuery);
    const fromStorage = canRestoreStoredSelection ? window.localStorage.getItem(storageNodeKey) || "" : "";
    const restoredNode = fromQuery || fromStorage;
    const restoredTurbine = turbineFromQuery || (canRestoreStoredTurbine ? window.localStorage.getItem(storageTurbineKey) || "" : "");

    if (restoredNode && state.nodeMap.has(restoredNode)) {
      state.selectedNodeId = restoredNode;
      if (availableTurbines(restoredNode).includes(restoredTurbine)) {
        state.selectedTurbineCode = restoredTurbine;
      } else {
        state.selectedTurbineCode = "";
      }
    } else {
      state.selectedNodeId = "";
      state.selectedTurbineCode = "";
    }

    renderAll();
    setView(resolveInitialView({ preferTree: !!fromQuery && !turbineFromQuery, forceChart: viewFromQuery === "chart" || !!turbineFromQuery }));
    persistSelection();

    if (!state.selectedNodeId) {
      return;
    }

    if (isMapPage) {
      setView("map");
      return;
    }

    if (isMonitorPage) {
      subscribeToNode(state.selectedNodeId);
      startPolling();
      await loadHistory();
      return;
    }

    if (state.selectedTurbineCode) {
      await loadHistory();
    }
  }

  async function initDashboard() {
    await loadUserRuntimeConfig();
    bindEvents();
    bindSocket();
    updateMetricChartTitles();
    renderAll();
    await loadNodes();
  }

  initDashboard().catch((error) => console.error("[dashboard] init failed", error));
})();
