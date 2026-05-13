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
  const storageViewKey = `windsightDrillView:${pageKind}`;
  const pollIntervalMs = 3000;
  const defaultLimit = 600;
  const maxLimit = 20000;
  const nodeMapConfig = window.WindSightNodeMapConfig || { defaults: {}, nodes: {} };
  const socket = isMonitorPage && typeof io === "function" ? io() : null;

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
    metricZoom: null,
    syncingMetricZoom: false,
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
    chartLastDataTime: document.getElementById("chartLastDataTime"),
  };

  const chartStore = {
    map: dom.nodeMapChart || null,
    turbineTree: null,
    metrics: new Map(),
  };

  function byId(id) {
    return document.getElementById(id);
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
    element.textContent = value === undefined || value === null || value === "" ? fallback : String(value);
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

  function getNodeRecord(nodeId) {
    return state.nodeMap.get(nodeId) || null;
  }

  function resolveNodeMeta(nodeOrId) {
    const node = typeof nodeOrId === "string" ? getNodeRecord(nodeOrId) || { node_id: nodeOrId } : nodeOrId || {};
    const nodeId = node.node_id || "";
    const defaults = nodeMapConfig.defaults || {};
    const configNodes = nodeMapConfig.nodes || {};
    const aliasId = nodeId.startsWith("WIND_") ? nodeId.replace("WIND_", "WIN_") : nodeId.startsWith("WIN_") ? nodeId.replace("WIN_", "WIND_") : nodeId;
    const preset = configNodes[nodeId] || configNodes[aliasId] || {};
    const turbines = normalizeTurbines(node.turbines || []);
    return {
      nodeId,
      displayName: preset.displayName || node.node_id || "未命名节点",
      zoneLabel: preset.zoneLabel || defaults.zoneLabel || "未标定区域",
      description: preset.description || defaults.description || "风场边缘采集节点",
      mapX: preset.mapX,
      mapY: preset.mapY,
      topologyX: preset.topologyX ?? preset.mapX,
      topologyY: preset.topologyY ?? preset.mapY,
      geo: preset.geo || null,
      accentColor: preset.accentColor || defaults.accentColor || "#2f6fed",
      status: getNodeStatus(node),
      online: !!node.online,
      lastUpload: node.last_upload || "",
      turbineCount: node.turbine_count || turbines.length || 0,
      turbines,
    };
  }

  function assignAutoMapPosition(index, total) {
    const safeTotal = Math.max(1, Number(total) || 1);
    const columns = Math.ceil(Math.sqrt(safeTotal));
    const rows = Math.ceil(safeTotal / columns);
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = columns <= 1 ? 50 : 18 + (column * 64) / (columns - 1);
    const y = rows <= 1 ? 50 : 20 + (row * 60) / (rows - 1);
    return { mapX: Math.round(x), mapY: Math.round(y) };
  }

  function resolveTopologyPosition(node, index, total) {
    const x = Number(node?.topologyX);
    const y = Number(node?.topologyY);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      return { x, y, configured: true };
    }
    const legacyX = Number(node?.mapX);
    const legacyY = Number(node?.mapY);
    if (Number.isFinite(legacyX) && Number.isFinite(legacyY)) {
      return { x: legacyX, y: legacyY, configured: true };
    }
    const auto = assignAutoMapPosition(index, total);
    return { x: auto.mapX, y: auto.mapY, configured: false };
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
    return { min: 0, max: Math.max(state.uploads.length - 1, 1) };
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
    const patch = {
      node_id: row.node_id,
      turbines: Object.keys(row.turbines || {}),
      turbine_count: Object.keys(row.turbines || {}).length,
    };
    if (markOnline) {
      patch.online = true;
    }
    if (updateLastUpload) {
      patch.last_upload = row.timestamp || "";
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
    for (let index = state.uploads.length - 1; index >= 0; index -= 1) {
      const row = state.uploads[index];
      if (row && row.node_id === nodeId) {
        return normalizeTurbines(Object.keys(row.turbines || {}));
      }
    }
    return [];
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

  function renderMapSummary() {
    if (!dom.nodeMapSummary) {
      return;
    }
    const total = state.nodes.length;
    const online = state.nodes.filter((node) => getNodeStatus(node) === "online").length;
    const fault = state.nodes.filter((node) => getNodeStatus(node) === "fault").length;
    const configured = state.nodes.filter((node) => {
      const meta = resolveNodeMeta(node);
      return Number.isFinite(Number(meta.topologyX)) || Number.isFinite(Number(meta.mapX));
    }).length;
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

  function buildTopologyNodes() {
    const totalNodes = state.nodes.length;
    return state.nodes.map((node, index) => {
      const meta = resolveNodeMeta(node);
      const position = resolveTopologyPosition(meta, index, totalNodes);
      return {
        ...meta,
        x: position.x,
        y: position.y,
        configured: position.configured,
      };
    });
  }

  function buildTopologyLinks(nodes) {
    const zones = new Map();
    nodes.forEach((node) => {
      const key = node.zoneLabel || "default";
      if (!zones.has(key)) {
        zones.set(key, []);
      }
      zones.get(key).push(node);
    });

    const links = [];
    zones.forEach((items) => {
      const sorted = [...items].sort((a, b) => a.x - b.x || a.y - b.y);
      for (let index = 0; index < sorted.length - 1; index += 1) {
        links.push([sorted[index], sorted[index + 1]]);
      }
    });
    if (!links.length && nodes.length > 1) {
      const sorted = [...nodes].sort((a, b) => a.x - b.x || a.y - b.y);
      for (let index = 0; index < sorted.length - 1; index += 1) {
        links.push([sorted[index], sorted[index + 1]]);
      }
    }
    return links;
  }

  function renderTopologyLegend() {
    if (!dom.nodeMapFallback) {
      return;
    }
    dom.nodeMapFallback.innerHTML = `
      <div class="topology-legend">
        <span><i class="legend-dot is-online"></i>在线节点</span>
        <span><i class="legend-dot is-offline"></i>离线节点</span>
        <span><i class="legend-dot is-fault"></i>故障节点</span>
        <span><i class="legend-line"></i>风场关联</span>
      </div>
    `;
  }

  function renderTopologyMap() {
    const element = dom.nodeMapChart;
    if (!element) {
      return;
    }

    const nodes = buildTopologyNodes();
    const links = buildTopologyLinks(nodes);
    renderTopologyLegend();

    if (!nodes.length) {
      element.innerHTML = '<div class="topology-empty">暂无节点</div>';
      return;
    }

    const linkSvg = links
      .map(([from, to]) => {
        const dx = Math.abs(Number(to.x) - Number(from.x));
        const bend = Math.max(5, Math.min(14, dx * 0.22));
        const c1x = Number(from.x) + bend;
        const c2x = Number(to.x) - bend;
        return `<path class="topology-link" d="M${from.x},${from.y} C${c1x},${from.y} ${c2x},${to.y} ${to.x},${to.y}" />`;
      })
      .join("");

    const nodeHtml = nodes
      .map((node) => {
        const status = node.status || "offline";
        const selectedClass = node.nodeId === state.selectedNodeId ? "is-selected" : "";
        const statusClass = `is-${status}`;
        const color = node.accentColor || getNodeVisualColor(node);
        const count = Number(node.turbineCount) || 0;
        const statusText = getStatusLabel(status);
        return `
          <button
            class="topology-node ${statusClass} ${selectedClass}"
            type="button"
            data-node-id="${escapeHtml(node.nodeId)}"
            style="--node-x:${node.x}%;--node-y:${node.y}%;--node-color:${escapeHtml(color)};"
            aria-label="${escapeHtml(node.displayName)}"
          >
            <span class="topology-node-core">
              <span class="topology-node-code">${escapeHtml(formatNodeShortCode(node.nodeId))}</span>
              <span class="topology-node-count">${count}</span>
              <span class="topology-node-status" aria-hidden="true"></span>
            </span>
            <span class="topology-node-label">
              <strong>${escapeHtml(node.displayName || node.nodeId)}</strong>
              <small>${escapeHtml(node.zoneLabel || "--")} · ${escapeHtml(statusText)}</small>
            </span>
          </button>
        `;
      })
      .join("");

    element.innerHTML = `
      <div class="topology-map-surface">
        <svg class="topology-map-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="topologyLinkGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stop-color="rgba(0, 243, 255, 0.08)" />
              <stop offset="45%" stop-color="rgba(0, 243, 255, 0.55)" />
              <stop offset="100%" stop-color="rgba(47, 111, 237, 0.2)" />
            </linearGradient>
          </defs>
          <path class="topology-corridor" d="M6,75 C21,60 30,66 43,52 C58,36 69,29 94,17" />
          <path class="topology-corridor muted" d="M8,26 C24,34 36,18 52,26 C68,35 78,47 94,37" />
          <path class="topology-corridor muted" d="M10,88 C29,79 45,84 62,68 C76,55 83,51 94,57" />
          ${linkSvg}
        </svg>
        <div class="topology-map-meta">
          <span>风场拓扑</span>
          <strong>${nodes.length} 个节点</strong>
        </div>
        <div class="topology-node-layer">${nodeHtml}</div>
      </div>
    `;

    element.querySelectorAll("[data-node-id]").forEach((button) => {
      button.addEventListener("click", () => {
        const nodeId = button.dataset.nodeId || "";
        jumpToTree(nodeId).catch((error) => console.error("[dashboard] jump to tree failed", error));
      });
    });
  }

  function renderMapChart() {
    renderTopologyMap();
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
    const times = state.uploads.map((row) => row.timestamp || "");
    const xMax = Math.max(times.length - 1, 1);
    const seriesData = state.uploads.map((row, rowIndex) => {
      const turbine = row?.turbines?.[state.selectedTurbineCode];
      const value = turbine ? turbine[metric.key] : null;
      return [rowIndex, safeNumber(value)];
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
          const point = Array.isArray(params) ? params[0] : params;
          const value = Array.isArray(point?.value) ? point.value : [point?.dataIndex, point?.value];
          const rowIndex = Math.round(Number(value?.[0]));
          const metricValue = Number(value?.[1]);
          const time = times[rowIndex] || "--";
          const textValue = Number.isFinite(metricValue) ? metricValue.toFixed(2) : "--";
          return `${time}<br/>${metric.label}: ${textValue} ${metric.unit}`;
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
      ],
    };
  }

  function clearMetricCharts() {
    chartStore.metrics.forEach((chart) => chart.clear());
  }

  function resizeTopologyMap() {
    // CSS-driven SVG/HTML topology does not require an imperative resize.
  }

  function resizeCharts() {
    resizeTopologyMap();
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
    if (nextMode === "chart" && (!state.selectedNodeId || !state.selectedTurbineCode)) {
      nextMode = state.selectedNodeId ? "tree" : "map";
    } else if (nextMode === "tree" && !state.selectedNodeId) {
      nextMode = "map";
    }

    state.view = nextMode;
    persistView(state.view);
    const mapMode = nextMode === "map";
    const treeMode = nextMode === "tree";
    const chartMode = nextMode === "chart";

    setViewSection(dom.mapView, mapMode);
    setViewSection(dom.treeView, treeMode);
    setViewSection(dom.chartView, chartMode);

    if (dom.btnBackToMap) {
      dom.btnBackToMap.classList.toggle("is-hidden", !treeMode);
    }
    if (dom.btnBackToTree) {
      dom.btnBackToTree.classList.toggle("is-hidden", !chartMode);
    }

    requestAnimationFrame(() => {
      if (mapMode) {
        resizeTopologyMap();
      }
      if (treeMode && chartStore.turbineTree) {
        chartStore.turbineTree.resize();
      }
      if (chartMode) {
        chartStore.metrics.forEach((chart) => chart.resize());
      }
    });
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
    requestAnimationFrame(resizeTopologyMap);
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
    if (!isMonitorPage) {
      await loadHistory();
    } else {
      requestAnimationFrame(() => chartStore.metrics.forEach((chart) => chart.resize()));
    }
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

    if (!usesDrilldownView) {
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
    setView(resolveInitialView({ preferTree: !!fromQuery }));
    persistSelection();

    if (!state.selectedNodeId) {
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

  bindEvents();
  bindSocket();
  updateMetricChartTitles();
  renderAll();
  loadNodes().catch((error) => console.error("[dashboard] init failed", error));
})();
