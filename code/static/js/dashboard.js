/**
 * WindSight 前端可视化逻辑（monitor.html）
 *
 * 目标（按你的截图风格）：
 * - 左侧：节点列表（可点击）+ 节点下拉框（同步）
 * - 右侧：三张卡片选择“电压/电流/转速”主视图
 * - 主图：单个大图表（叠加多通道曲线），支持：
 *   - 轴独立缩放：滚轮在 X 轴区域 -> 只缩放时间；在 Y 轴区域 -> 只缩放幅值；在图内 -> 同时缩放
 *   - Grab 拖拽：按住鼠标拖动平移（右拖波形右移；上拖波形上移）
 *   - 一键重置缩放
 *
 * 约束：
 * - 使用 ECharts（base.html 已引入）
 * - 时域图 Y 轴必须包含 0（禁止 scale:true）
 * - 所有提示文字为简体中文
 */
(() => {
  // ========== DOM 防空 ==========
  const elNodeList = document.getElementById('nodeList');
  const elNodeSelect = document.getElementById('nodeSelect');
  const elChannelGrid = document.getElementById('channelCheckboxGrid');
  const elSelectedCount = document.getElementById('selectedCount');
  const elHistoryLimit = document.getElementById('historyLimit');
  const elHistoryStart = document.getElementById('historyStart');
  const elHistoryEnd = document.getElementById('historyEnd');
  const elBtnClearRange = document.getElementById('btnClearRange');
  const elBtnReload = document.getElementById('btnReload');
  const elBtnSelectAll = document.getElementById('btnSelectAll');
  const elBtnSelectNone = document.getElementById('btnSelectNone');
  const elLastDataTime = document.getElementById('wsLastDataTime');
  const elLastDataTimeMini = document.getElementById('wsLastDataTimeMini');
  const elResetZoom = document.getElementById('wsResetZoomMain');

  const elCardVoltage = document.getElementById('wsMetricCardVoltage');
  const elCardCurrent = document.getElementById('wsMetricCardCurrent');
  const elCardSpeed = document.getElementById('wsMetricCardSpeed');

  const elCardValueVoltage = document.getElementById('wsCardValueVoltage');
  const elCardValueCurrent = document.getElementById('wsCardValueCurrent');
  const elCardValueSpeed = document.getElementById('wsCardValueSpeed');

  const elMainChart = document.getElementById('wsMainChart');
  const elPortBadge = document.getElementById('uiPortBadge');

  if (!elNodeSelect || !elChannelGrid || !elMainChart || !elCardVoltage || !elCardCurrent || !elCardSpeed) {
    console.warn('[WindSight] dashboard.js 未检测到监测页元素，已跳过初始化。');
    return;
  }

  // ========== 常量/状态 ==========
  const CHANNEL_COUNT = 32;
  const POLL_INTERVAL_MS = 3000;
  const DEFAULT_LIMIT = 600;
  const MAX_HISTORY_LIMIT = 20000;
  const STORAGE_PREFIX = 'windsight';
  const PATH = (window.location && window.location.pathname) ? window.location.pathname : '';
  const IS_MONITOR_PAGE = (PATH === '/monitor');

  let selectedNodeId = '';
  let selectedChannels = new Set(); // 0..31
  let cachedRows = []; // [{timestamp, voltages[], currents[], speeds[]}]
  let activeMetric = 'voltage'; // 'voltage' | 'current' | 'speed'
  let pollingTimer = null;
  let cachedIdSet = new Set(); // 避免“轮询 + Socket”重复追加同一条记录

  // Socket.IO（可选）：用于实时追加数据（规则约定：监听 monitor_update）
  const socket = (typeof io === 'function') ? io() : null;
  let rafScheduled = false;

  // 保存当前缩放窗口，避免“新数据刷新 -> 缩放回默认”
  // 说明：
  // - 仅用 start/end(百分比) 会受到“数据全范围变化”的影响：新数据进来后，百分比对应的实际时间/幅值窗口会漂移，
  //   用户会感觉“缩放变了”。
  // - 因此这里优先使用 startValue/endValue（真实轴值）来锁定视窗，拖拽时只做平移、不改变缩放跨度。
  const zoomState = {
    x: { mode: 'percent', start: 0, end: 100, startValue: null, endValue: null }, // dataZoomIndex 0
    y: { mode: 'percent', start: 0, end: 100, startValue: null, endValue: null }  // dataZoomIndex 1
  };

  // 全量数据范围（用于“缩小回去”的边界约束）
  // 重要：不要用 axis.scale.getExtent() 当作“全量范围”，因为 dataZoom(filterMode) 生效后它可能变成“当前窗口范围”，
  // 会导致“放大后无法缩小”的体验。
  let fullDataExtent = {
    x: null, // {min,max}
    y: null  // {min,max}
  };

  // 交互状态（Grab）
  let isDragging = false;
  let dragStartPx = null; // {x,y}
  let dragStartWindow = null; // {x0,x1,y0,y1}

  const chart = echarts.init(elMainChart);

  function storageKey(name, nodeId = '') {
    // 说明：不同页面（/monitor vs /overview）不要互相覆盖；节点专属优先于全局
    const page = (window.location && window.location.pathname) ? window.location.pathname : 'page';
    const nid = (nodeId || '').trim();
    if (nid) return `${STORAGE_PREFIX}:${page}:${name}:node:${nid}`;
    return `${STORAGE_PREFIX}:${page}:${name}`;
  }

  function toDatetimeTextValue(d) {
    // 将 Date 转成文本输入可读字符串：YYYY-MM-DD HH:MM
    const pad = (n) => String(n).padStart(2, '0');
    const yyyy = d.getFullYear();
    const mm = pad(d.getMonth() + 1);
    const dd = pad(d.getDate());
    const hh = pad(d.getHours());
    const mi = pad(d.getMinutes());
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  }

  function datetimeLocalToServerParam(value) {
    // 关键修复：
    // - datetime-local 的值不带时区（形如 2026-01-06T23:24）
    // - 若在前端转成 toISOString()，不同浏览器对“无时区字符串”的解释可能不同（当 UTC/当本地），
    //   最终会导致后端时间范围错位，从而查询为空，看起来像“没有加载”。
    // - 后端 parse_client_datetime_to_utc 已约定：**无时区输入按北京时间解释**，
    //   因此这里直接把 datetime-local 原值传给后端最稳。
    const v = (value || '').trim();
    return v ? v : null;
  }

  function saveReplayRange() {
    // 保存“回放时段”（按页面维度 + 同时写全局）
    try {
      const start = elHistoryStart ? (elHistoryStart.value || '') : '';
      const end = elHistoryEnd ? (elHistoryEnd.value || '') : '';
      localStorage.setItem(storageKey('replay_start', ''), start);
      localStorage.setItem(storageKey('replay_end', ''), end);
    } catch (e) {}
  }

  function loadReplayRange() {
    try {
      if (!elHistoryStart && !elHistoryEnd) return;
      const start = localStorage.getItem(storageKey('replay_start', '')) || '';
      const end = localStorage.getItem(storageKey('replay_end', '')) || '';
      if (elHistoryStart && start) elHistoryStart.value = start;
      if (elHistoryEnd && end) elHistoryEnd.value = end;
    } catch (e) {}
  }

  function clearReplayRange(shouldReload = false) {
    if (elHistoryStart) elHistoryStart.value = '';
    if (elHistoryEnd) elHistoryEnd.value = '';
    saveReplayRange();
    if (shouldReload) loadHistoryOnce();
  }

  function applyQuickRangeMinutes(mins) {
    if (!elHistoryStart || !elHistoryEnd) return;
    const m = parseInt(String(mins), 10);
    if (!Number.isFinite(m) || m <= 0) return;
    const end = new Date();
    const start = new Date(end.getTime() - m * 60 * 1000);
    elHistoryStart.value = toDatetimeTextValue(start);
    elHistoryEnd.value = toDatetimeTextValue(end);
    saveReplayRange();
    loadHistoryOnce(); // 快捷时段：立即触发一次加载
  }

  function parsePositiveInt(v, fallback) {
    const n = parseInt(String(v || ''), 10);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
  }

  function setHistoryEndFromIso(isoTs) {
    if (!elHistoryEnd || !isoTs) return false;
    const d = new Date(String(isoTs));
    if (Number.isNaN(d.getTime())) return false;
    elHistoryEnd.value = toDatetimeTextValue(d);
    saveReplayRange();
    return true;
  }

  async function computeEndFromStartAndLimitThenLoad() {
    // 仅数据概览页：start + limit -> 自动计算 end（取第 N 条的时间戳）
    if (IS_MONITOR_PAGE) return;
    if (!selectedNodeId) return;
    if (!elHistoryStart || !elHistoryLimit) return;

    const startParam = datetimeLocalToServerParam(elHistoryStart.value);
    if (!startParam) {
      // 没有 start 时，按“最近 N 条”加载即可
      await loadHistoryOnce();
      return;
    }

    const n = parsePositiveInt(elHistoryLimit.value, DEFAULT_LIMIT);
    // 仅当用户输入的 N 合法时才计算
    const params = new URLSearchParams();
    params.set('node_id', selectedNodeId);
    params.set('mode', 'nth');
    params.set('start', startParam);
    params.set('limit', String(Math.min(MAX_HISTORY_LIMIT, Math.max(1, n))));

    const res = await fetchJson(`/api/data_meta?${params.toString()}`);
    if (!res || res.status !== 'success') {
      await loadHistoryOnce();
      return;
    }

    const count = parsePositiveInt(res.count, 0);
    const requested = parsePositiveInt(res.requested, n);
    const endIso = res.nth_ts || res.last_ts;

    if (endIso) {
      setHistoryEndFromIso(endIso);
      // 若不足 requested 条，提示一下（但仍按你输入的点数请求，实际返回会更少）
      if (count > 0 && count < requested && typeof window.showToast === 'function') {
        window.showToast(`该起始时间后仅有 ${count} 条数据，已将结束时间设置为当前可用的最后一条。`, 'warning');
      }
    } else {
      if (typeof window.showToast === 'function') {
        window.showToast('该开始时间后暂无数据，请调整开始时间。', 'warning');
      }
    }

    await loadHistoryOnce();
  }

  async function computeLimitFromStartAndEndThenLoad() {
    // 仅数据概览页：start + end -> 自动计算“合适点数”（范围内实际条数）
    if (IS_MONITOR_PAGE) return;
    if (!selectedNodeId) return;
    if (!elHistoryStart || !elHistoryEnd || !elHistoryLimit) return;

    const startParam = datetimeLocalToServerParam(elHistoryStart.value);
    const endParam = datetimeLocalToServerParam(elHistoryEnd.value);
    if (!startParam || !endParam) {
      await loadHistoryOnce();
      return;
    }

    const params = new URLSearchParams();
    params.set('node_id', selectedNodeId);
    params.set('mode', 'count');
    params.set('start', startParam);
    params.set('end', endParam);
    const res = await fetchJson(`/api/data_meta?${params.toString()}`);
    if (!res || res.status !== 'success') {
      await loadHistoryOnce();
      return;
    }

    const count = parsePositiveInt(res.count, 0);
    // 点数输入框允许 1..MAX
    const next = Math.min(MAX_HISTORY_LIMIT, Math.max(1, count));
    elHistoryLimit.value = String(next);
    await loadHistoryOnce();
  }

  function saveSelectedChannels(nodeId = '') {
    // 保存为 0..31 的数组
    try {
      const arr = Array.from(selectedChannels).sort((a, b) => a - b);
      localStorage.setItem(storageKey('selected_channels', nodeId), JSON.stringify(arr));
      // 同时写一份“全局”（用于还没选节点时的预览/初始显示）
      localStorage.setItem(storageKey('selected_channels', ''), JSON.stringify(arr));
    } catch (e) {}
  }

  function loadSelectedChannels(nodeId = '') {
    try {
      // 1) 优先节点专属
      const rawNode = localStorage.getItem(storageKey('selected_channels', nodeId));
      const raw = rawNode || localStorage.getItem(storageKey('selected_channels', ''));
      if (!raw) return false;
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return false;
      const next = new Set();
      arr.forEach(v => {
        const n = parseInt(String(v), 10);
        if (Number.isFinite(n) && n >= 0 && n < CHANNEL_COUNT) next.add(n);
      });
      if (next.size === 0) return false;
      selectedChannels = next;
      return true;
    } catch (e) {
      return false;
    }
  }

  function saveActiveMetric() {
    try {
      localStorage.setItem(storageKey('active_metric', ''), String(activeMetric || 'voltage'));
    } catch (e) {}
  }

  function loadActiveMetric() {
    try {
      const v = (localStorage.getItem(storageKey('active_metric', '')) || '').trim();
      if (v === 'voltage' || v === 'current' || v === 'speed') return v;
      return null;
    } catch (e) {
      return null;
    }
  }

  function saveHistoryRange(nodeId = '') {
    // 保存 datetime-local 字符串（不带时区）：后端按北京时间解释
    try {
      const payload = {
        start: elHistoryStart ? String(elHistoryStart.value || '') : '',
        end: elHistoryEnd ? String(elHistoryEnd.value || '') : ''
      };
      localStorage.setItem(storageKey('history_range', nodeId), JSON.stringify(payload));
      // 同时写一份“全局”（用于未选节点时的预览/初始显示）
      localStorage.setItem(storageKey('history_range', ''), JSON.stringify(payload));
    } catch (e) {}
  }

  function loadHistoryRange(nodeId = '') {
    try {
      const rawNode = localStorage.getItem(storageKey('history_range', nodeId));
      const raw = rawNode || localStorage.getItem(storageKey('history_range', ''));
      if (!raw) return false;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') return false;
      if (elHistoryStart) elHistoryStart.value = String(obj.start || '');
      if (elHistoryEnd) elHistoryEnd.value = String(obj.end || '');
      return true;
    } catch (e) {
      return false;
    }
  }

  function hasHistoryRange() {
    const s = elHistoryStart ? String(elHistoryStart.value || '').trim() : '';
    const e = elHistoryEnd ? String(elHistoryEnd.value || '').trim() : '';
    return !!(s || e);
  }

  function getHistoryRangeParams() {
    const params = new URLSearchParams();
    const s = elHistoryStart ? String(elHistoryStart.value || '').trim() : '';
    const e = elHistoryEnd ? String(elHistoryEnd.value || '').trim() : '';
    if (s) params.set('start', s);
    if (e) params.set('end', e);
    return params;
  }

  function setQuickRangeMinutes(minutes) {
    const m = Math.max(1, parseInt(String(minutes), 10));
    if (!Number.isFinite(m)) return;
    const now = new Date();
    const start = new Date(now.getTime() - m * 60 * 1000);

    // datetime-local 格式：YYYY-MM-DDTHH:MM（按浏览器本地时间显示）
    const toLocalInput = (d) => {
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };

    if (elHistoryStart) elHistoryStart.value = toLocalInput(start);
    if (elHistoryEnd) elHistoryEnd.value = toLocalInput(now);
    saveHistoryRange(selectedNodeId);
  }

  function autoFitMainChartHeight() {
    // 目标：让主图尽量撑满"剩余视口高度"，解决大屏下窗口过小问题。
    // 注意：getBoundingClientRect().top 是相对视口的；当页面滚动导致 top<0 时，按 0 处理避免高度异常变大。
    try {
      const rect = elMainChart.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight || 800;
      const top = Math.max(0, rect.top);
      const bottomSafe = 24;
      const minH = 650; // 兜底：保证波形足够大（已从520px增加到650px）
      const target = Math.max(minH, Math.floor(vh - top - bottomSafe));
      elMainChart.style.height = `${target}px`;
      chart.resize();
    } catch (e) {
      // 忽略：不影响主流程
    }
  }

  function setText(el, v, fallback = '--') {
    if (!el) return;
    const s = (v === undefined || v === null || v === '') ? fallback : String(v);
    el.textContent = s;
  }

  function channelColor(chIndex) {
    // 同一通道在不同指标下保持同色，便于对照
    const hue = Math.round((chIndex * 360) / CHANNEL_COUNT);
    return `hsl(${hue}, 75%, 45%)`;
  }

  function metricLabel(metric) {
    if (metric === 'current') return { name: '电流', unit: 'A' };
    if (metric === 'speed') return { name: '转速', unit: 'rpm' };
    return { name: '电压', unit: 'V' };
  }

  function metricValuesFromRow(row, metric) {
    if (!row) return [];
    if (metric === 'current') return Array.isArray(row.currents) ? row.currents : [];
    if (metric === 'speed') return Array.isArray(row.speeds) ? row.speeds : [];
    return Array.isArray(row.voltages) ? row.voltages : [];
  }

  function makeTimeLabelFormatter(showDate) {
    const pad2 = (n) => String(n).padStart(2, '0');
    return (value) => {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return '';
      const hh = pad2(d.getHours());
      const mm = pad2(d.getMinutes());
      if (!showDate) return `${hh}:${mm}`;
      const mo = pad2(d.getMonth() + 1);
      const dd = pad2(d.getDate());
      return `${mo}-${dd} ${hh}:${mm}`;
    };
  }

  function shouldShowDateOnXAxis() {
    // 仅用于“避免跨天误解”：当回放数据跨越日期时，X轴标签需要带日期
    const rows = cachedRows || [];
    if (rows.length < 2) return false;
    const first = rows[0];
    const last = rows[rows.length - 1];
    const a = Number((first && first.tms !== undefined) ? first.tms : Date.parse(first.timestamp));
    const b = Number((last && last.tms !== undefined) ? last.tms : Date.parse(last.timestamp));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    const da = new Date(a);
    const db = new Date(b);
    return da.toDateString() !== db.toDateString();
  }

  function buildTimeKeyedRows(rows) {
    // 将 timestamp 转为“可用于 ECharts time 轴”的数值毫秒；并处理同一毫秒/同一秒内多帧的唯一性
    // - 后端已升级为毫秒时间戳（推荐）
    // - 兼容历史数据（只有秒）：同一秒内多条记录会被分配 +1ms、+2ms...，避免 tooltip 出现“同一时刻多值”
    const seenMs = new Map(); // baseMs -> count
    const out = [];
    for (const r of (rows || [])) {
      const ts = (r && r.timestamp) ? String(r.timestamp) : '';
      const baseMs = Date.parse(ts);
      if (!Number.isFinite(baseMs)) continue;
      const c = (seenMs.get(baseMs) || 0);
      seenMs.set(baseMs, c + 1);
      const tms = baseMs + c;
      out.push({
        id: (r && r.id !== undefined && r.id !== null) ? Number(r.id) : null,
        timestamp: ts,
        tms,
        voltages: r.voltages || [],
        currents: r.currents || [],
        speeds: r.speeds || []
      });
    }
    return out;
  }

  function buildSeries() {
    const chList = Array.from(selectedChannels).sort((a, b) => a - b);
    const rows = cachedRows || [];
    const series = [];

    for (const ch of chList) {
      const name = `CH${ch + 1}`;
      const color = channelColor(ch);
      const data = [];
      for (const r of rows) {
        const t = (r && (r.tms !== undefined && r.tms !== null)) ? r.tms : r.timestamp;
        if (!t) continue;
        const arr = metricValuesFromRow(r, activeMetric);
        const v = (Array.isArray(arr) ? arr[ch] : null);
        if (v !== undefined && v !== null) data.push([t, v]);
      }
      series.push({
        name,
        type: 'line',
        showSymbol: false,
        data,
        lineStyle: { width: 2, color },
        itemStyle: { color },
        emphasis: { focus: 'series' }
      });
    }
    return series;
  }

  function computeFullDataExtentFromCache() {
    // 基于 cachedRows + 当前 activeMetric + 当前 selectedChannels 计算“全量数据范围”
    // 用途：
    // - 缩放缩小（zoom out）时的边界约束，避免被“当前窗口范围”锁死
    // - percent -> value 的稳定换算（减少随数据变化漂移）
    try {
      const rows = cachedRows || [];
      if (!rows.length) {
        fullDataExtent = { x: null, y: null };
        return;
      }

      // X：时间轴（毫秒）
      let xMin = Infinity;
      let xMax = -Infinity;
      for (const r of rows) {
        const t = (r && (r.tms !== undefined && r.tms !== null)) ? Number(r.tms) : Date.parse(String(r && r.timestamp ? r.timestamp : ''));
        if (!Number.isFinite(t)) continue;
        if (t < xMin) xMin = t;
        if (t > xMax) xMax = t;
      }
      const xOk = Number.isFinite(xMin) && Number.isFinite(xMax) && xMax > xMin;

      // Y：当前指标 + 当前通道的幅值范围
      let yMin = Infinity;
      let yMax = -Infinity;
      const chList = Array.from(selectedChannels).sort((a, b) => a - b);
      if (chList.length) {
        for (const r of rows) {
          const arr = metricValuesFromRow(r, activeMetric);
          if (!Array.isArray(arr)) continue;
          for (const ch of chList) {
            const v = Number(arr[ch]);
            if (!Number.isFinite(v)) continue;
            if (v < yMin) yMin = v;
            if (v > yMax) yMax = v;
          }
        }
      }
      let yOk = Number.isFinite(yMin) && Number.isFinite(yMax) && yMax > yMin;
      if (yOk) {
        // 时域图必须能看到 0：把 0 纳入全量范围，保证“缩小回全图”时能回到包含 0 的窗口
        yMin = Math.min(0, yMin);
        yMax = Math.max(0, yMax);
      }

      fullDataExtent = {
        x: xOk ? { min: xMin, max: xMax } : null,
        y: yOk ? { min: yMin, max: yMax } : null
      };
    } catch (e) {
      fullDataExtent = { x: null, y: null };
    }
  }

  function getFullDataExtent(axis) {
    return (axis === 'x') ? fullDataExtent.x : fullDataExtent.y;
  }

  function setSelectedCountUI() {
    setText(elSelectedCount, selectedChannels.size, '0');
  }

  function setActiveCard(metric) {
    activeMetric = metric;

    // 清理 active
    [elCardVoltage, elCardCurrent, elCardSpeed].forEach(el => el.classList.remove('ws-card-active'));
    if (metric === 'voltage') elCardVoltage.classList.add('ws-card-active');
    if (metric === 'current') elCardCurrent.classList.add('ws-card-active');
    if (metric === 'speed') elCardSpeed.classList.add('ws-card-active');
    saveActiveMetric();
  }

  function updateCardValues() {
    const last = cachedRows && cachedRows.length ? cachedRows[cachedRows.length - 1] : null;
    if (!last) {
      setText(elCardValueVoltage, '--');
      setText(elCardValueCurrent, '--');
      setText(elCardValueSpeed, '--');
      return;
    }
    // 默认显示 CH1 的瞬时值（符合直觉；多通道趋势在主图里看）
    const v = metricValuesFromRow(last, 'voltage')[0];
    const c = metricValuesFromRow(last, 'current')[0];
    const s = metricValuesFromRow(last, 'speed')[0];
    setText(elCardValueVoltage, (v !== undefined ? Number(v).toFixed(2) : '--'));
    setText(elCardValueCurrent, (c !== undefined ? Number(c).toFixed(2) : '--'));
    setText(elCardValueSpeed, (s !== undefined ? Math.round(Number(s)) : '--'));
  }

  function updateLastDataTimeUI() {
    const last = cachedRows && cachedRows.length ? cachedRows[cachedRows.length - 1] : null;
    const ts = last ? (last.timestamp || '--') : '--';
    setText(elLastDataTime, ts);
    setText(elLastDataTimeMini, ts);
  }

  function renderChart(resetZoom = false) {
    const chList = Array.from(selectedChannels).sort((a, b) => a - b);
    const label = metricLabel(activeMetric);
    const showDateOnXAxis = shouldShowDateOnXAxis();
    const xLabelFormatter = makeTimeLabelFormatter(showDateOnXAxis);

    if (!selectedNodeId || chList.length === 0) {
      chart.setOption({
        animation: false,
        tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
        legend: { type: 'scroll', top: 0, left: 0, right: 0, textStyle: { fontSize: 11 } },
        grid: { left: 60, right: 20, top: 40, bottom: 45, containLabel: true },
        xAxis: { type: 'time', axisLabel: { formatter: xLabelFormatter } },
        yAxis: {
          type: 'value',
          name: label.name,
          scale: false,
          min: (val) => Math.min(0, val.min)
        },
        dataZoom: [],
        series: []
      }, { notMerge: true, lazyUpdate: false });
      updateCardValues();
      updateLastDataTimeUI();
      return;
    }

    const series = buildSeries();
    // 计算全量数据范围：用于“以鼠标为中心缩放”的缩小边界
    computeFullDataExtentFromCache();

    const option = {
      animation: false,
      tooltip: { trigger: 'axis', axisPointer: { type: 'line' } },
      legend: { type: 'scroll', top: 0, left: 0, right: 0, textStyle: { fontSize: 11 } },
      grid: { left: 60, right: 20, top: 40, bottom: 45, containLabel: true },
      xAxis: { type: 'time', axisLabel: { formatter: xLabelFormatter } },
      yAxis: {
        type: 'value',
        name: `${label.name}（${label.unit}）`,
        scale: false, // 关键：必须包含 0
        min: (val) => Math.min(0, val.min),
        splitLine: { show: true }
      },
      // 使用 inside dataZoom 作为“可控窗口”
      dataZoom: [
        {
          type: 'inside',
          xAxisIndex: 0,
          filterMode: 'filter',
          moveOnMouseMove: false, // 禁用原生拖拽平移，改用自定义 Grab
          zoomOnMouseWheel: false, // 禁用原生滚轮缩放，改用自定义轴独立缩放
          moveOnMouseWheel: false,
          // 关键：带上当前窗口，避免刷新时回到默认
          ...(zoomState.x.mode === 'value' && zoomState.x.startValue !== null && zoomState.x.endValue !== null
            ? { startValue: zoomState.x.startValue, endValue: zoomState.x.endValue }
            : { start: zoomState.x.start, end: zoomState.x.end })
        },
        {
          type: 'inside',
          yAxisIndex: 0,
          filterMode: 'empty',
          moveOnMouseMove: false,
          zoomOnMouseWheel: false,
          moveOnMouseWheel: false,
          // 关键：带上当前窗口，避免刷新时回到默认
          ...(zoomState.y.mode === 'value' && zoomState.y.startValue !== null && zoomState.y.endValue !== null
            ? { startValue: zoomState.y.startValue, endValue: zoomState.y.endValue }
            : { start: zoomState.y.start, end: zoomState.y.end })
        }
      ],
      series
    };

    // notMerge=true 会重建 option，但我们显式把 dataZoom.start/end 带上，因此缩放不会丢
    chart.setOption(option, { notMerge: true, lazyUpdate: false });

    if (resetZoom) {
      resetZoomAll();
    }

    updateCardValues();
    updateLastDataTimeUI();
  }

  function scheduleRender() {
    // 高频数据推送时避免“每帧 setOption”抖动：统一合并到 rAF
    if (rafScheduled) return;
    rafScheduled = true;
    requestAnimationFrame(() => {
      rafScheduled = false;
      renderChart(false);
    });
  }

  function trySubscribeNode(nodeId) {
    // 数据概览页以“回放”为主，不做实时订阅，避免覆盖时段筛选结果
    if (!IS_MONITOR_PAGE) return;
    if (!socket || !nodeId) return;
    try {
      socket.emit('subscribe_node', { node_id: nodeId });
    } catch (e) {
      console.warn('[WindSight] subscribe_node 失败:', e);
    }
  }

  function tryUnsubscribeNode(nodeId) {
    if (!IS_MONITOR_PAGE) return;
    if (!socket || !nodeId) return;
    try {
      socket.emit('unsubscribe_node', { node_id: nodeId });
    } catch (e) {
      console.warn('[WindSight] unsubscribe_node 失败:', e);
    }
  }

  function appendRealtimeRow(row) {
    // 数据概览页不追加实时数据（避免打乱“回放时段”）
    if (!IS_MONITOR_PAGE) return;
    if (!row || !row.timestamp) return;
    const rid = (row.id !== undefined && row.id !== null) ? Number(row.id) : null;
    if (rid !== null && cachedIdSet.has(rid)) return;

    const ts = String(row.timestamp);
    let tms = Date.parse(ts);
    if (!Number.isFinite(tms)) return;
    const last = cachedRows && cachedRows.length ? cachedRows[cachedRows.length - 1] : null;
    if (last && last.tms !== undefined && Number.isFinite(Number(last.tms)) && Number(last.tms) === tms) {
      tms = tms + 1;
    }
    cachedRows.push({
      id: rid,
      timestamp: ts,
      tms,
      voltages: row.voltages || [],
      currents: row.currents || [],
      speeds: row.speeds || []
    });
    if (rid !== null) cachedIdSet.add(rid);

    // 限制缓存长度，避免无限增长（取 historyLimit 为上限）
    let maxKeep = DEFAULT_LIMIT;
    if (elHistoryLimit) {
      const v = parseInt(elHistoryLimit.value || `${DEFAULT_LIMIT}`, 10);
      // 与后端上限保持一致：允许 >2000（例如 3000/5000/20000）
      if (Number.isFinite(v)) maxKeep = Math.max(200, Math.min(MAX_HISTORY_LIMIT, v));
    }
    if (cachedRows.length > maxKeep) {
      cachedRows = cachedRows.slice(cachedRows.length - maxKeep);
    }
    scheduleRender();
  }

  function resetZoomAll() {
    // 清空 dataZoom 范围，让 ECharts 回到全范围
    zoomState.x.mode = 'percent';
    zoomState.x.start = 0; zoomState.x.end = 100;
    zoomState.x.startValue = null; zoomState.x.endValue = null;
    zoomState.y.mode = 'percent';
    zoomState.y.start = 0; zoomState.y.end = 100;
    zoomState.y.startValue = null; zoomState.y.endValue = null;
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, start: 0, end: 100 });
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, start: 0, end: 100 });
  }

  function getChartRect() {
    const rect = elMainChart.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }

  function clampNumber(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function getGridRectLocal() {
    // ECharts 绘图区（grid）在容器内的像素矩形：用于把“轴区域/边缘区域”的鼠标点
    // 投影到绘图区内部，确保 convertFromPixel 能稳定返回数据坐标。
    try {
      const rect = chart.getModel().getComponent('grid', 0).coordinateSystem.getRect();
      if (!rect) return null;
      const x = Number(rect.x);
      const y = Number(rect.y);
      const w = Number(rect.width);
      const h = Number(rect.height);
      if (![x, y, w, h].every(Number.isFinite)) return null;
      if (w <= 2 || h <= 2) return null;
      return { x, y, width: w, height: h };
    } catch (e) {
      return null;
    }
  }

  function getAxisValueAtPixel(axis, localX, localY) {
    // axis: 'x' | 'y'
    // localX/localY：相对图表 DOM 左上角的像素坐标（注意：不是 clientX/clientY）
    try {
      const grid = getGridRectLocal();
      let px = Number(localX);
      let py = Number(localY);
      if (grid) {
        // 将点“压到”绘图区内部：避免鼠标落在坐标轴标签/留白处时 convertFromPixel 返回 null
        const gx0 = grid.x + 1;
        const gx1 = grid.x + grid.width - 1;
        const gy0 = grid.y + 1;
        const gy1 = grid.y + grid.height - 1;
        if (axis === 'x') {
          py = clampNumber(py, gy0, gy1);
          // x 允许在 grid 左右之外也能算，但为了稳定同样夹一下
          px = clampNumber(px, gx0, gx1);
        } else {
          px = clampNumber(px, gx0, gx1);
          py = clampNumber(py, gy0, gy1);
        }
      }
      const v = chart.convertFromPixel({ gridIndex: 0 }, [px, py]);
      if (!v || !Array.isArray(v) || v.length < 2) return null;
      const n = (axis === 'x') ? Number(v[0]) : Number(v[1]);
      return Number.isFinite(n) ? n : null;
    } catch (e) {
      return null;
    }
  }

  function applyZoomPercent(index, start, end) {
    const s = Math.max(0, Math.min(100, start));
    const e = Math.max(0, Math.min(100, end));

    // 同步到缩放状态（用于刷新时复原）
    if (index === 0) {
      zoomState.x.mode = 'percent';
      zoomState.x.start = s;
      zoomState.x.end = e;
      zoomState.x.startValue = null;
      zoomState.x.endValue = null;
    } else if (index === 1) {
      zoomState.y.mode = 'percent';
      zoomState.y.start = s;
      zoomState.y.end = e;
      zoomState.y.startValue = null;
      zoomState.y.endValue = null;
    }
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: index, start: s, end: e });
  }

  function getCurrentDataZoom(index) {
    // 从 ECharts 当前 option 读取 dataZoom 状态（比自己推导更可靠）
    try {
      const opt = chart.getOption();
      const dz = (opt && opt.dataZoom && opt.dataZoom[index]) ? opt.dataZoom[index] : null;
      if (!dz) return null;
      return {
        start: (typeof dz.start === 'number') ? dz.start : null,
        end: (typeof dz.end === 'number') ? dz.end : null,
        startValue: (dz.startValue !== undefined && dz.startValue !== null) ? Number(dz.startValue) : null,
        endValue: (dz.endValue !== undefined && dz.endValue !== null) ? Number(dz.endValue) : null,
      };
    } catch (e) {
      return null;
    }
  }

  function getAxisExtent(axis) {
    // axis: 'x' | 'y'
    try {
      const comp = chart.getModel().getComponent(axis === 'x' ? 'xAxis' : 'yAxis', 0);
      const ext = comp && comp.axis && comp.axis.scale && comp.axis.scale.getExtent ? comp.axis.scale.getExtent() : null;
      if (!ext || ext.length !== 2) return null;
      const min = Number(ext[0]);
      const max = Number(ext[1]);
      if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
      if (max === min) return null;
      return { min, max };
    } catch (e) {
      return null;
    }
  }

  function ensureValueWindow(axis) {
    // axis: 'x' | 'y'
    const st = (axis === 'x') ? zoomState.x : zoomState.y;
    if (st.mode === 'value' && st.startValue !== null && st.endValue !== null) return true;

    // 1) 优先从 ECharts 内部 dataZoom 状态拿 startValue/endValue（最稳定）
    const dz = getCurrentDataZoom(axis === 'x' ? 0 : 1);
    if (dz && Number.isFinite(dz.startValue) && Number.isFinite(dz.endValue) && dz.startValue !== dz.endValue) {
      st.mode = 'value';
      st.startValue = Math.min(dz.startValue, dz.endValue);
      st.endValue = Math.max(dz.startValue, dz.endValue);
      return true;
    }

    // 优先用“全量数据范围”，避免 dataZoom 后 axisExtent 退化成“当前窗口范围”导致 percent->value 换算漂移
    const ext = getFullDataExtent(axis) || getAxisExtent(axis);
    if (!ext) return false;
    const start = (typeof st.start === 'number') ? st.start : 0;
    const end = (typeof st.end === 'number') ? st.end : 100;
    const sv = ext.min + (ext.max - ext.min) * (start / 100);
    const ev = ext.min + (ext.max - ext.min) * (end / 100);
    st.mode = 'value';
    st.startValue = Math.min(sv, ev);
    st.endValue = Math.max(sv, ev);
    return true;
  }

  function applyZoomValue(axis, startValue, endValue) {
    // axis: 'x' | 'y'
    const s = Number(startValue);
    const e = Number(endValue);
    if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return;
    const st = (axis === 'x') ? zoomState.x : zoomState.y;
    st.mode = 'value';
    st.startValue = Math.min(s, e);
    st.endValue = Math.max(s, e);
    if (axis === 'x') {
      chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, startValue: st.startValue, endValue: st.endValue });
    } else {
      chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, startValue: st.startValue, endValue: st.endValue });
    }
  }

  function zoomAroundCenterValue(axis, factor) {
    // factor >1 放大（范围变小）；factor <1 缩小（范围变大）
    if (!ensureValueWindow(axis)) {
      // 兜底：若无法获取轴范围，则回退到百分比缩放
      if (axis === 'x') zoomAroundCenterPercent(0, factor);
      else zoomAroundCenterPercent(1, factor);
      return;
    }
    const st = (axis === 'x') ? zoomState.x : zoomState.y;
    const center = (st.startValue + st.endValue) / 2;
    const range = Math.max(1e-9, (st.endValue - st.startValue) / factor);
    const ns = center - range / 2;
    const ne = center + range / 2;
    applyZoomValue(axis, ns, ne);
  }

  function zoomAroundAnchorValue(axis, anchorValue, factor) {
    // 以"鼠标所在数据坐标(anchorValue)"为锚点缩放：
    // - 放大：窗口变小，但鼠标指向的数据点尽量保持在原来的相对位置
    // - 缩小：窗口变大，同理
    if (!Number.isFinite(Number(anchorValue))) {
      // 如果无法获取锚点值，尝试使用中心缩放
      zoomAroundCenterValue(axis, factor);
      return;
    }
    
    // 确保能够获取当前窗口的值域范围
    if (!ensureValueWindow(axis)) {
      // 兜底：无法获取 value 窗口时退回到中心缩放（百分比缩放易随数据范围漂移）
      zoomAroundCenterValue(axis, factor);
      return;
    }

    const st = (axis === 'x') ? zoomState.x : zoomState.y;
    const s0 = Number(st.startValue);
    const e0 = Number(st.endValue);
    if (!Number.isFinite(s0) || !Number.isFinite(e0) || s0 === e0) {
      zoomAroundCenterValue(axis, factor);
      return;
    }

    const a = Number(anchorValue);
    const range0 = Math.max(1e-9, e0 - s0);
    
    // 计算鼠标点在当前窗口中的相对位置（0-1之间）
    const ratio = clampNumber((a - s0) / range0, 0, 1);
    
    // 计算缩放后的新范围
    const range1 = Math.max(1e-9, range0 / factor);

    // 以锚点为中心计算新窗口
    // 保持锚点在窗口中的相对位置不变
    let ns = a - ratio * range1;
    let ne = ns + range1;

    // 约束到当前轴的可用范围（避免缩放到完全没有数据的区间）
    const ext = getFullDataExtent(axis);
    if (ext && Number.isFinite(ext.min) && Number.isFinite(ext.max) && ext.max > ext.min) {
      const full = ext.max - ext.min;
      if (range1 >= full) {
        // 如果新范围大于等于全量范围，则显示全量
        ns = ext.min;
        ne = ext.max;
      } else {
        // 调整窗口位置，确保不超出边界
        if (ns < ext.min) { 
          const offset = ext.min - ns;
          ns = ext.min;
          ne += offset;
        }
        if (ne > ext.max) { 
          const offset = ne - ext.max;
          ne = ext.max;
          ns -= offset;
        }
        // 二次保护（极端情况下仍可能越界）
        if (ns < ext.min) ns = ext.min;
        if (ne > ext.max) ne = ext.max;
        if (ne - ns < range1) {
          // 如果调整后范围变小，重新计算以保持范围
          const center = (ns + ne) / 2;
          ns = center - range1 / 2;
          ne = center + range1 / 2;
          if (ns < ext.min) { ne += (ext.min - ns); ns = ext.min; }
          if (ne > ext.max) { ns -= (ne - ext.max); ne = ext.max; }
        }
      }
    }

    applyZoomValue(axis, ns, ne);
  }

  function zoomAroundCenterPercent(index, factor) {
    // 兼容兜底：按百分比缩放（不推荐，可能随数据漂移）
    const st = (index === 0) ? zoomState.x : zoomState.y;
    const start = (typeof st.start === 'number') ? st.start : 0;
    const end = (typeof st.end === 'number') ? st.end : 100;
    const center = (start + end) / 2;
    const range = Math.max(1, (end - start) / factor);
    let ns = center - range / 2;
    let ne = center + range / 2;
    if (ns < 0) { ne -= ns; ns = 0; }
    if (ne > 100) { ns -= (ne - 100); ne = 100; }
    applyZoomPercent(index, ns, ne);
  }

  function handleWheel(e) {
    if (!selectedNodeId) return;

    // 计算鼠标位置所属区域（参考旧版：底部 20% 为 X 轴；左侧 18% 为 Y 轴）
    const rect = getChartRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    // 检查鼠标是否在图表区域内
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
    
    const isOnXAxis = y > rect.height * 0.80;
    const isOnYAxis = x < rect.width * 0.18;

    e.preventDefault();
    e.stopPropagation();

    const factor = (e.deltaY < 0) ? 1.10 : 0.90;

    // 优先尝试获取鼠标位置的数据值作为锚点
    let anchorX = null;
    let anchorY = null;
    
    // 尝试从 ECharts 直接获取鼠标位置的数据坐标（更可靠）
    try {
      const grid = getGridRectLocal();
      if (grid) {
        // 将鼠标坐标转换为相对于 grid 的坐标
        const gridX = x - grid.x;
        const gridY = y - grid.y;
        // 确保在 grid 范围内
        if (gridX >= 0 && gridX <= grid.width && gridY >= 0 && gridY <= grid.height) {
          const pixel = [x, y];
          const value = chart.convertFromPixel({ gridIndex: 0 }, pixel);
          if (value && Array.isArray(value) && value.length >= 2) {
            anchorX = Number(value[0]);
            anchorY = Number(value[1]);
          }
        }
      }
    } catch (err) {
      // 如果直接转换失败，使用备用方法
    }
    
    // 如果直接转换失败，使用备用方法
    if (!Number.isFinite(anchorX)) {
      anchorX = getAxisValueAtPixel('x', x, y);
    }
    if (!Number.isFinite(anchorY)) {
      anchorY = getAxisValueAtPixel('y', x, y);
    }

    if (isOnXAxis && !isOnYAxis) {
      // X 轴区域：只缩放 X 轴
      zoomAroundAnchorValue('x', anchorX, factor);
      return;
    }
    if (isOnYAxis && !isOnXAxis) {
      // Y 轴区域：只缩放 Y 轴
      zoomAroundAnchorValue('y', anchorY, factor);
      return;
    }
    // 图内区域：同时缩放 X 和 Y 轴（以鼠标位置为锚点）
    zoomAroundAnchorValue('x', anchorX, factor);
    zoomAroundAnchorValue('y', anchorY, factor);
  }

  function handleMouseDown(e) {
    if (e.button !== 0) return; // 左键
    // 仅在图表区域内生效
    const rect = getChartRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;

    isDragging = true;
    // 拖拽时关闭 tooltip，避免提示框跟随导致“抖动感”（松开再恢复）
    try {
      chart.dispatchAction({ type: 'hideTip' });
    } catch (err) {}
    dragStartPx = { x: e.clientX, y: e.clientY };
    // 拖拽平移要求“不改变缩放跨度”：
    // - 若能拿到 value 窗口：用值域平移（最稳，且不随数据范围漂移）
    // - 若拿不到：退回到 percent 窗口平移（保证“任何缩放状态都能拖动”）
    const hasXValue = ensureValueWindow('x');
    const hasYValue = ensureValueWindow('y');

    // 记录鼠标按下时所在的数据坐标（用于值域平移）
    const startAxisValue = (() => {
      try {
        const rect = getChartRect();
        const px = [e.clientX - rect.left, e.clientY - rect.top];
        const v = chart.convertFromPixel({ gridIndex: 0 }, px);
        return { x: Number(v && v[0]), y: Number(v && v[1]) };
      } catch (err) {
        return { x: null, y: null };
      }
    })();

    // 记录当前 percent 窗口（用于兜底平移）
    const dzX = getCurrentDataZoom(0);
    const dzY = getCurrentDataZoom(1);
    const pxWin = {
      start: (dzX && typeof dzX.start === 'number') ? dzX.start : (typeof zoomState.x.start === 'number' ? zoomState.x.start : 0),
      end: (dzX && typeof dzX.end === 'number') ? dzX.end : (typeof zoomState.x.end === 'number' ? zoomState.x.end : 100),
    };
    const pyWin = {
      start: (dzY && typeof dzY.start === 'number') ? dzY.start : (typeof zoomState.y.start === 'number' ? zoomState.y.start : 0),
      end: (dzY && typeof dzY.end === 'number') ? dzY.end : (typeof zoomState.y.end === 'number' ? zoomState.y.end : 100),
    };

    dragStartWindow = {
      mode: (hasXValue && hasYValue) ? 'value' : 'percent',
      x: { startValue: zoomState.x.startValue, endValue: zoomState.x.endValue, start: pxWin.start, end: pxWin.end },
      y: { startValue: zoomState.y.startValue, endValue: zoomState.y.endValue, start: pyWin.start, end: pyWin.end },
      startAxisValue,
    };
  }

  function handleMouseMove(e) {
    if (!isDragging || !dragStartPx || !dragStartWindow) return;
    // 平移：拖拽过程中只改变窗口位置，不改变缩放跨度
    try {
      const rect = getChartRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const dxPx = e.clientX - dragStartPx.x;
      const dyPx = e.clientY - dragStartPx.y;

      // 获取网格区域尺寸（更贴近实际绘图区）
      let gridW = rect.width;
      let gridH = rect.height;
      try {
        const gridRect = chart.getModel().getComponent('grid', 0).coordinateSystem.getRect();
        if (gridRect && Number.isFinite(gridRect.width) && Number.isFinite(gridRect.height)) {
          gridW = Math.max(1, Number(gridRect.width));
          gridH = Math.max(1, Number(gridRect.height));
        }
      } catch (e2) {}

      if (dragStartWindow.mode === 'value') {
        // 值域平移（首选）
        const v = chart.convertFromPixel({ gridIndex: 0 }, [x, y]);
        const xv = Number(v && v[0]);
        const yv = Number(v && v[1]);
        const x0v = dragStartWindow.startAxisValue ? dragStartWindow.startAxisValue.x : null;
        const y0v = dragStartWindow.startAxisValue ? dragStartWindow.startAxisValue.y : null;
        let dxVal = null;
        let dyVal = null;
        if (Number.isFinite(xv) && Number.isFinite(yv) && Number.isFinite(x0v) && Number.isFinite(y0v)) {
          dxVal = xv - x0v;
          dyVal = yv - y0v;
        } else {
          // 兜底：用像素位移按当前 value 窗口跨度换算
          const xRange = Number(dragStartWindow.x.endValue) - Number(dragStartWindow.x.startValue);
          const yRange = Number(dragStartWindow.y.endValue) - Number(dragStartWindow.y.startValue);
          if (Number.isFinite(xRange) && gridW > 0) dxVal = (dxPx / gridW) * xRange;
          if (Number.isFinite(yRange) && gridH > 0) dyVal = -(dyPx / gridH) * yRange;
        }
        if (!Number.isFinite(dxVal) || !Number.isFinite(dyVal)) return;

        const nsx = dragStartWindow.x.startValue - dxVal;
        const nex = dragStartWindow.x.endValue - dxVal;
        const nsy = dragStartWindow.y.startValue - dyVal;
        const ney = dragStartWindow.y.endValue - dyVal;
        applyZoomValue('x', nsx, nex);
        applyZoomValue('y', nsy, ney);
        return;
      }

      // 百分比平移（兜底）：保证“任何缩放状态都能拖动”
      const xRangePct = Number(dragStartWindow.x.end) - Number(dragStartWindow.x.start);
      const yRangePct = Number(dragStartWindow.y.end) - Number(dragStartWindow.y.start);
      if (!Number.isFinite(xRangePct) || !Number.isFinite(yRangePct) || gridW <= 0 || gridH <= 0) return;

      // 像素 -> 百分比：右拖 dxPx>0 -> 窗口左移（start/end 变小），所以取负号
      const shiftXPct = -(dxPx / gridW) * xRangePct;
      const shiftYPct = (dyPx / gridH) * yRangePct;
      applyZoomPercent(0, dragStartWindow.x.start + shiftXPct, dragStartWindow.x.end + shiftXPct);
      applyZoomPercent(1, dragStartWindow.y.start + shiftYPct, dragStartWindow.y.end + shiftYPct);
    } catch (err) {
      // 忽略
    }
  }

  function handleMouseUp() {
    isDragging = false;
    dragStartPx = null;
    dragStartWindow = null;
    // 松开后允许 tooltip 正常工作（无需显式 showTip，鼠标移动即可触发）
  }

  // ========== API ==========
  async function fetchJson(url) {
    const resp = await fetch(url, { method: 'GET' });
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
      throw new Error('接口未返回 JSON（可能未登录）');
    }
    return await resp.json();
  }

  async function loadNodes() {
    const res = await fetchJson('/api/nodes');
    const nodes = (res && res.success && Array.isArray(res.nodes)) ? res.nodes : [];

    // 下拉框
    if (nodes.length === 0) {
      elNodeSelect.innerHTML = '<option value="">暂无节点数据（请先上报 /api/upload）</option>';
    } else {
      const opts = ['<option value="">请选择节点...</option>'];
      for (const n of nodes) {
        const id = n.node_id;
        if (!id) continue;
        const online = n.online ? '在线' : '离线';
        const last = n.last_upload ? `｜${n.last_upload}` : '';
        opts.push(`<option value="${id}">${id}（${online}${last}）</option>`);
      }
      elNodeSelect.innerHTML = opts.join('');
    }

    // 左侧列表（可点击）
    if (elNodeList) {
      if (nodes.length === 0) {
        elNodeList.innerHTML = `
          <div class="text-center text-muted py-5">
            <div class="spinner-border spinner-border-sm mb-2" role="status"><span class="visually-hidden">加载中...</span></div>
            <div>暂无节点</div>
            <small class="text-muted d-block mt-2">请启动模拟器或让终端开始上报</small>
          </div>
        `;
      } else {
        const html = nodes.map(n => {
          const id = n.node_id || '';
          const online = !!n.online;
          const badge = online ? 'bg-success' : 'bg-secondary';
          const txt = online ? '在线' : '离线';
          const active = (id && id === selectedNodeId) ? ' border-start border-4 border-primary bg-light' : '';
          return `
            <a class="list-group-item list-group-item-action${active}" data-node-id="${id}">
              <div class="d-flex justify-content-between align-items-center">
                <div class="fw-bold text-truncate" style="max-width: 160px;" title="${id}">${id}</div>
                <span class="badge ${badge}">${txt}</span>
              </div>
              <div class="text-muted small mt-1">${n.last_upload ? `最后上报：${n.last_upload}` : '最后上报：--'}</div>
            </a>
          `;
        }).join('');
        elNodeList.innerHTML = html;

        elNodeList.querySelectorAll('[data-node-id]').forEach(item => {
          item.addEventListener('click', () => {
            const id = (item.getAttribute('data-node-id') || '').trim();
            if (!id) return;
            setSelectedNode(id);
          });
        });
      }
    }
  }

  async function loadHistoryOnce() {
    const nodeId = (selectedNodeId || '').trim();
    if (!nodeId) {
      cachedRows = [];
      cachedIdSet = new Set();
      renderChart(true);
      return;
    }

    let limit = DEFAULT_LIMIT;
    if (elHistoryLimit) {
      limit = parseInt(elHistoryLimit.value || `${DEFAULT_LIMIT}`, 10);
      if (!Number.isFinite(limit)) limit = DEFAULT_LIMIT;
      // 与后端 MAX_HISTORY_LIMIT=20000 对齐，避免输入 3000 后被“自动改回 2000”
      limit = Math.max(1, Math.min(MAX_HISTORY_LIMIT, limit));
      elHistoryLimit.value = String(limit);
    }

    // 回放时段（可选）：优先按时间筛选，再叠加 limit 限制
    const startParam = elHistoryStart ? datetimeLocalToServerParam(elHistoryStart.value) : null;
    const endParam = elHistoryEnd ? datetimeLocalToServerParam(elHistoryEnd.value) : null;
    if (elHistoryStart || elHistoryEnd) {
      saveReplayRange();
    }

    const params = new URLSearchParams();
    params.set('node_id', nodeId);
    params.set('limit', String(limit));
    if (startParam) params.set('start', startParam);
    if (endParam) params.set('end', endParam);

    const res = await fetchJson(`/api/data?${params.toString()}`);
    const rows = (res && res.status === 'success' && Array.isArray(res.data)) ? res.data : [];
    if (!IS_MONITOR_PAGE && (startParam || endParam) && rows.length === 0) {
      if (typeof window.showToast === 'function') {
        window.showToast('该回放时段内暂无数据，请调整开始/结束时间或增大时段范围。', 'warning');
      }
    }
    cachedRows = buildTimeKeyedRows(rows);
    cachedIdSet = new Set(cachedRows.map(r => r && r.id).filter(v => v !== null));
    renderChart(false);
  }

  function stopPolling() {
    if (pollingTimer) {
      clearInterval(pollingTimer);
      pollingTimer = null;
    }
  }

  function startPolling() {
    // 数据概览页：不做自动轮询，避免“选择时段后又被最新数据刷掉”
    if (!IS_MONITOR_PAGE) return;
    stopPolling();
    if (!selectedNodeId) return;
    loadHistoryOnce();
    pollingTimer = setInterval(loadHistoryOnce, POLL_INTERVAL_MS);
  }

  // ========== UI ==========
  function buildChannelCheckboxes() {
    // 根据容器实际宽度自适应列数：
    // - 实时监测页左侧窄栏：2列为主，避免“按钮重叠”
    // - 数据概览页宽区域：尽量多列，提高效率
    let colClass = 'col-6 col-md-4 col-lg-3 col-xl-2';
    try {
      const w = elChannelGrid.getBoundingClientRect().width || 0;
      if (w > 0 && w < 360) {
        // 很窄：2列
        colClass = 'col-6';
      } else if (w >= 360 && w < 520) {
        // 中等：3列
        colClass = 'col-6 col-md-4';
      } else {
        // 宽：多列
        colClass = 'col-6 col-md-4 col-lg-3 col-xl-2';
      }
    } catch (e) {}

    const html = [];
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const id = `ws_ch_${i}`;
      html.push(`
        <div class="${colClass}">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" value="${i}" id="${id}">
            <label class="form-check-label" for="${id}" style="user-select:none;">
              <span class="badge bg-light text-dark border me-1">CH${i + 1}</span>
            </label>
          </div>
        </div>
      `);
    }
    elChannelGrid.innerHTML = html.join('');

    elChannelGrid.querySelectorAll('input.form-check-input').forEach(cb => {
      cb.addEventListener('change', () => {
        const ch = parseInt(cb.value, 10);
        if (cb.checked) selectedChannels.add(ch);
        else selectedChannels.delete(ch);
        setSelectedCountUI();
        saveSelectedChannels(selectedNodeId);
        renderChart(false);
      });
    });
  }

  function setAllChannels(checked) {
    selectedChannels.clear();
    elChannelGrid.querySelectorAll('input.form-check-input').forEach(cb => {
      cb.checked = !!checked;
      const ch = parseInt(cb.value, 10);
      if (checked) selectedChannels.add(ch);
    });
    setSelectedCountUI();
    saveSelectedChannels(selectedNodeId);
    renderChart(false);
  }

  function setSelectedNode(nodeId) {
    // 退订旧节点（Socket）
    if (selectedNodeId && selectedNodeId !== nodeId) {
      tryUnsubscribeNode(selectedNodeId);
    }

    selectedNodeId = nodeId;
    cachedRows = [];
    cachedIdSet = new Set();

    // 同步下拉框
    const opt = Array.from(elNodeSelect.options).find(o => o.value === nodeId);
    if (opt) elNodeSelect.value = nodeId;

    // 刷新左侧高亮
    if (elNodeList) {
      elNodeList.querySelectorAll('[data-node-id]').forEach(item => {
        const id = item.getAttribute('data-node-id');
        item.classList.remove('border-start', 'border-4', 'border-primary', 'bg-light');
        if (id === nodeId) item.classList.add('border-start', 'border-4', 'border-primary', 'bg-light');
      });
    }

    // 缓存选择（用于系统概览跳转）
    try { localStorage.setItem('selectedNodeId', nodeId); } catch (e) {}

    // 切换节点时：尝试恢复该节点的通道选择（优先节点专属）
    if (loadSelectedChannels(selectedNodeId)) {
      buildChannelCheckboxes();
      selectedChannels.forEach(ch => {
        const cb = document.getElementById(`ws_ch_${ch}`);
        if (cb) cb.checked = true;
      });
      setSelectedCountUI();
    }

    // 订阅新节点（Socket 实时追加）
    if (selectedNodeId) {
      trySubscribeNode(selectedNodeId);
    }

    // monitor：持续刷新；overview：选中后只拉一次（后续由“加载/时段/快捷按钮”触发）
    if (IS_MONITOR_PAGE) startPolling();
    else loadHistoryOnce();
  }

  function bindCards() {
    function activate(metric) {
      setActiveCard(metric);
      renderChart(false);
    }
    elCardVoltage.addEventListener('click', () => activate('voltage'));
    elCardCurrent.addEventListener('click', () => activate('current'));
    elCardSpeed.addEventListener('click', () => activate('speed'));
  }

  // ========== 初始化 ==========
  document.addEventListener('DOMContentLoaded', async () => {
    // 顶部“当前端口”徽章（可选：overview.html 才有）
    if (elPortBadge) {
      try {
        elPortBadge.textContent = window.location.port || '5000';
      } catch (e) {}
    }

    // 1) 通道选择：优先恢复本地记忆；没有记忆才默认 CH1/CH5
    const hasSaved = loadSelectedChannels('');
    if (!hasSaved) {
      selectedChannels = new Set([0, 4]);
    }
    buildChannelCheckboxes();
    selectedChannels.forEach(ch => {
      const cb = document.getElementById(`ws_ch_${ch}`);
      if (cb) cb.checked = true;
    });
    setSelectedCountUI();

    bindCards();
    // 2) 指标卡片：恢复上次选择
    const savedMetric = loadActiveMetric();
    setActiveCard(savedMetric || 'voltage');
    renderChart(true);

    // 让主图自动撑满视口剩余空间（比写死 620px 更适配各种屏幕）
    autoFitMainChartHeight();

    // 回放时段：恢复上次设置 + 绑定快捷按钮/清空按钮
    loadReplayRange();
    // 手动修改开始/结束时间：保存并（防抖）触发一次加载
    let rangeChangeRaf = 0;
    function onRangeChanged() {
      saveReplayRange();
      if (rangeChangeRaf) cancelAnimationFrame(rangeChangeRaf);
      rangeChangeRaf = requestAnimationFrame(() => {
        // 只有在已选择节点时才加载，避免空节点误请求
        if (selectedNodeId) loadHistoryOnce();
      });
    }
    if (elHistoryStart) elHistoryStart.addEventListener('change', onRangeChanged);
    if (elHistoryEnd) elHistoryEnd.addEventListener('change', onRangeChanged);

    // 回车刷新：回放时段 / 回放点数输入后按 Enter 立即刷新（无需点“加载”）
    function bindEnterRefresh(el, handler) {
      if (!el) return;
      el.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        handler();
      });
    }
    // 说明：overview 页支持时段回放；monitor 页没有时段，但回放点数仍支持 Enter 加载
    bindEnterRefresh(elHistoryStart, () => {
      if (!IS_MONITOR_PAGE) onRangeChanged();
    });
    bindEnterRefresh(elHistoryEnd, () => {
      if (!IS_MONITOR_PAGE) computeLimitFromStartAndEndThenLoad();
    });
    bindEnterRefresh(elHistoryLimit, () => {
      if (!selectedNodeId) return;
      if (!IS_MONITOR_PAGE && elHistoryStart && datetimeLocalToServerParam(elHistoryStart.value)) {
        computeEndFromStartAndLimitThenLoad();
        return;
      }
      loadHistoryOnce();
    });
    // 快捷时段按钮：两页都用 data-range-min
    document.querySelectorAll('[data-range-min]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mins = btn.getAttribute('data-range-min');
        applyQuickRangeMinutes(mins);
      });
    });
    if (elBtnClearRange) {
      elBtnClearRange.addEventListener('click', () => clearReplayRange(true));
    }

    // 事件绑定
    elNodeSelect.addEventListener('change', () => {
      const nid = (elNodeSelect.value || '').trim();
      if (!nid) return;
      setSelectedNode(nid);
    });
    if (elBtnReload) elBtnReload.addEventListener('click', loadHistoryOnce);
    if (elBtnSelectAll) elBtnSelectAll.addEventListener('click', () => setAllChannels(true));
    if (elBtnSelectNone) elBtnSelectNone.addEventListener('click', () => setAllChannels(false));
    if (elResetZoom) elResetZoom.addEventListener('click', resetZoomAll);

    // 自定义交互：轴独立缩放 + Grab 拖拽
    elMainChart.addEventListener('wheel', handleWheel, { passive: false });
    elMainChart.addEventListener('mousedown', handleMouseDown);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    // Socket 实时推送（可选）：仅实时监测页启用
    if (socket && IS_MONITOR_PAGE) {
      socket.on('monitor_update', (msg) => {
        try {
          if (!msg || msg.node_id !== selectedNodeId) return;
          // 安全：确保 data 存在且包含 channels 结构（本项目实际为 voltages/currents/speeds）
          const data = msg.data || null;
          if (!data) return;
          appendRealtimeRow(data);
        } catch (e) {
          console.warn('[WindSight] monitor_update 处理失败:', e);
        }
      });

      socket.on('node_data_update', (msg) => {
        try {
          if (!msg || msg.node_id !== selectedNodeId) return;
          const data = msg.data || null;
          if (!data) return;
          appendRealtimeRow(data);
        } catch (e) {
          console.warn('[WindSight] node_data_update 处理失败:', e);
        }
      });
    }

    // resize：既要调整画布，也要重新计算自适应高度
    let resizeRaf = 0;
    window.addEventListener('resize', () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        autoFitMainChartHeight();
        // 通道区域宽度可能变化（尤其是侧边栏/窗口缩放），重建一次避免布局挤压
        buildChannelCheckboxes();
        // 恢复已选通道的勾选状态
        selectedChannels.forEach(ch => {
          const cb = document.getElementById(`ws_ch_${ch}`);
          if (cb) cb.checked = true;
        });
      });
    });

    // 拉节点列表
    try {
      await loadNodes();
    } catch (e) {
      console.error('[WindSight] 节点列表加载失败:', e);
    }

    // 从系统概览传递的预选节点
    try {
      const preset = (localStorage.getItem('selectedNodeId') || '').trim();
      if (preset) {
        const opt = Array.from(elNodeSelect.options).find(o => o.value === preset);
        if (opt) setSelectedNode(preset);
      }
    } catch (e) {}
  });
})();


