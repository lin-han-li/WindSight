/**
 * WindSight 数据概览（Dashboard）
 * 核心：node_id + 32 通道选择 -> 三窗口（电压/电流/转速）时间曲线回放
 *
 * 约束：
 * - 尽量复用 Bootstrap 5 与现有黑色 Dashboard 风格
 * - 仅使用 ECharts（已在 base.html CDN 引入）
 * - 时域图 Y 轴必须能看到 0（不要用 scale:true）
 */

// ==================== DOM 获取（防空指针）====================
const elNodeSelect = document.getElementById('nodeSelect');
const elChannelGrid = document.getElementById('channelCheckboxGrid');
const elSelectedCount = document.getElementById('selectedCount');
const elHistoryLimit = document.getElementById('historyLimit');
const elBtnReload = document.getElementById('btnReload');
const elBtnSelectAll = document.getElementById('btnSelectAll');
const elBtnSelectNone = document.getElementById('btnSelectNone');
const elLastDataTime = document.getElementById('lastDataTime');

const elVoltageChart = document.getElementById('voltageChart');
const elCurrentChart = document.getElementById('currentChart');
const elSpeedChart = document.getElementById('speedChart');

// 页面可能被复用：没有关键元素则直接退出
if (!elNodeSelect || !elChannelGrid || !elVoltageChart || !elCurrentChart || !elSpeedChart) {
  console.warn('[WindSight] 页面元素缺失，Dashboard 脚本已跳过初始化。');
} else {
  // ==================== 状态 ====================
  const CHANNEL_COUNT = 32;
  const MAX_POINTS_DEFAULT = 600;
  const socket = (typeof io === 'function') ? io() : null;

  let selectedNodeId = '';
  let selectedChannels = new Set(); // 0..31

  // 缓存数据：按 node 的回放数据（升序）
  // 每条记录：{timestamp, voltages[], currents[], speeds[]}
  let cachedRows = [];

  // ECharts 实例
  const chartVoltage = echarts.init(elVoltageChart);
  const chartCurrent = echarts.init(elCurrentChart);
  const chartSpeed = echarts.init(elSpeedChart);

  // 通道颜色：确保三张图对同一通道使用同色，便于对照
  function channelColor(chIndex) {
    // 使用 HSL 均匀分布，颜色稳定且可区分
    const hue = Math.round((chIndex * 360) / CHANNEL_COUNT);
    return `hsl(${hue}, 75%, 45%)`;
  }

  function getSelectedChannelList() {
    return Array.from(selectedChannels).sort((a, b) => a - b);
  }

  function setSelectedCountUI() {
    if (elSelectedCount) elSelectedCount.textContent = String(selectedChannels.size);
  }

  function setLastDataTimeUI(ts) {
    if (!elLastDataTime) return;
    elLastDataTime.textContent = ts || '--';
  }

  // ==================== 图表配置（时域：Y轴包含0）====================
  function makeTimeSeriesOption(titleText, yName) {
    return {
      animation: false,
      title: {
        show: false
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'line' }
      },
      legend: {
        type: 'scroll',
        top: 0,
        left: 0,
        right: 0,
        textStyle: { fontSize: 11 }
      },
      grid: { left: 50, right: 20, top: 35, bottom: 35, containLabel: true },
      xAxis: {
        type: 'time',
        axisLabel: { color: '#64748b' }
      },
      yAxis: {
        type: 'value',
        name: yName,
        nameTextStyle: { color: '#64748b' },
        scale: false, // 关键：不要让图表“自缩放”而看不到0
        min: function (val) {
          // 强制包含0
          return Math.min(0, val.min);
        },
        axisLabel: { color: '#64748b' }
      },
      series: []
    };
  }

  function renderChartsFromCache() {
    const chList = getSelectedChannelList();

    // 若未选择节点或未选通道：清空图表
    if (!selectedNodeId || chList.length === 0) {
      chartVoltage.setOption(makeTimeSeriesOption('电压', '电压'), { notMerge: true, lazyUpdate: false });
      chartCurrent.setOption(makeTimeSeriesOption('电流', '电流'), { notMerge: true, lazyUpdate: false });
      chartSpeed.setOption(makeTimeSeriesOption('转速', '转速'), { notMerge: true, lazyUpdate: false });
      setLastDataTimeUI('--');
      return;
    }

    // 组装 series：每个通道一条线
    const voltageSeries = [];
    const currentSeries = [];
    const speedSeries = [];

    // 预组装：按通道缓存数组（性能更稳）
    // data item: [time, value]
    const rows = cachedRows || [];

    // last time
    const lastRow = rows.length ? rows[rows.length - 1] : null;
    setLastDataTimeUI(lastRow ? (lastRow.timestamp || '--') : '--');

    for (const ch of chList) {
      const name = `CH${ch + 1}`;
      const color = channelColor(ch);

      const vData = [];
      const cData = [];
      const sData = [];

      for (const r of rows) {
        const t = r.timestamp;
        if (!t) continue;
        const v = (Array.isArray(r.voltages) ? r.voltages[ch] : null);
        const c = (Array.isArray(r.currents) ? r.currents[ch] : null);
        const s = (Array.isArray(r.speeds) ? r.speeds[ch] : null);

        if (v !== undefined && v !== null) vData.push([t, v]);
        if (c !== undefined && c !== null) cData.push([t, c]);
        if (s !== undefined && s !== null) sData.push([t, s]);
      }

      voltageSeries.push({
        name,
        type: 'line',
        showSymbol: false,
        data: vData,
        lineStyle: { width: 2, color },
        itemStyle: { color }
      });
      currentSeries.push({
        name,
        type: 'line',
        showSymbol: false,
        data: cData,
        lineStyle: { width: 2, color },
        itemStyle: { color }
      });
      speedSeries.push({
        name,
        type: 'line',
        showSymbol: false,
        data: sData,
        lineStyle: { width: 2, color },
        itemStyle: { color }
      });
    }

    const optV = makeTimeSeriesOption('电压', '电压');
    optV.series = voltageSeries;
    const optC = makeTimeSeriesOption('电流', '电流');
    optC.series = currentSeries;
    const optS = makeTimeSeriesOption('转速', '转速');
    optS.series = speedSeries;

    // 高频更新时建议用 requestAnimationFrame
    requestAnimationFrame(() => {
      chartVoltage.setOption(optV, { notMerge: true, lazyUpdate: false });
      chartCurrent.setOption(optC, { notMerge: true, lazyUpdate: false });
      chartSpeed.setOption(optS, { notMerge: true, lazyUpdate: false });
    });
  }

  // ==================== 数据请求 ====================
  async function fetchJson(url) {
    const resp = await fetch(url, { method: 'GET' });
    // /api/nodes /api/node_data 需要登录，未登录会 302 到 /login，返回 HTML
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
      throw new Error('接口未返回 JSON（可能未登录或服务器异常）');
    }
    return await resp.json();
  }

  async function loadNodeList() {
    try {
      elNodeSelect.innerHTML = '<option value="">加载中...</option>';
      const res = await fetchJson('/api/nodes');
      const nodes = (res && res.success && Array.isArray(res.nodes)) ? res.nodes : [];
      if (nodes.length === 0) {
        elNodeSelect.innerHTML = '<option value="">暂无节点数据（先向 /api/upload 上报）</option>';
        return;
      }

      const opts = ['<option value="">请选择节点...</option>'];
      for (const n of nodes) {
        const id = n.node_id;
        if (!id) continue;
        const online = n.online ? '在线' : '离线';
        const last = n.last_upload ? `｜${n.last_upload}` : '';
        opts.push(`<option value="${id}">${id}（${online}${last}）</option>`);
      }
      elNodeSelect.innerHTML = opts.join('');
    } catch (e) {
      console.error('[WindSight] 加载节点列表失败:', e);
      elNodeSelect.innerHTML = '<option value="">加载失败（请确认已登录）</option>';
    }
  }

  async function loadNodeHistory() {
    const nodeId = (selectedNodeId || '').trim();
    if (!nodeId) {
      cachedRows = [];
      renderChartsFromCache();
      return;
    }

    let limit = MAX_POINTS_DEFAULT;
    if (elHistoryLimit) {
      try {
        limit = parseInt(elHistoryLimit.value || `${MAX_POINTS_DEFAULT}`, 10);
      } catch (e) {
        limit = MAX_POINTS_DEFAULT;
      }
      limit = Math.max(50, Math.min(2000, limit));
      elHistoryLimit.value = String(limit);
    }

    try {
      const res = await fetchJson(`/api/node_data?node_id=${encodeURIComponent(nodeId)}&limit=${limit}`);
      const rows = (res && res.success && Array.isArray(res.data)) ? res.data : [];
      cachedRows = rows.map(r => ({
        timestamp: r.timestamp,
        voltages: r.voltages || [],
        currents: r.currents || [],
        speeds: r.speeds || []
      }));
      renderChartsFromCache();
    } catch (e) {
      console.error('[WindSight] 加载历史数据失败:', e);
      cachedRows = [];
      renderChartsFromCache();
      if (typeof window.showToast === 'function') {
        window.showToast('加载历史数据失败：请确认已登录并选择正确节点', 'warning');
      }
    }
  }

  // ==================== 通道复选框 ====================
  function buildChannelCheckboxes() {
    const chunks = [];
    for (let i = 0; i < CHANNEL_COUNT; i++) {
      const id = `ch_${i}`;
      const label = `CH${i + 1}`;
      chunks.push(`
        <div class="col-6 col-md-4 col-lg-3 col-xl-2">
          <div class="form-check">
            <input class="form-check-input" type="checkbox" value="${i}" id="${id}">
            <label class="form-check-label" for="${id}" style="user-select: none;">
              <span class="badge bg-light text-dark border me-1">${label}</span>
            </label>
          </div>
        </div>
      `);
    }
    elChannelGrid.innerHTML = chunks.join('');

    // 事件：单个通道勾选
    elChannelGrid.querySelectorAll('input.form-check-input').forEach((cb) => {
      cb.addEventListener('change', () => {
        const ch = parseInt(cb.value, 10);
        if (cb.checked) selectedChannels.add(ch);
        else selectedChannels.delete(ch);
        setSelectedCountUI();
        renderChartsFromCache();
      });
    });
  }

  function setAllChannels(checked) {
    selectedChannels.clear();
    elChannelGrid.querySelectorAll('input.form-check-input').forEach((cb) => {
      cb.checked = !!checked;
      const ch = parseInt(cb.value, 10);
      if (checked) selectedChannels.add(ch);
    });
    setSelectedCountUI();
    renderChartsFromCache();
  }

  // ==================== Socket.IO（可选实时追加）====================
  function trySubscribeNode(nodeId) {
    if (!socket) return;
    if (!nodeId) return;
    try {
      socket.emit('subscribe_node', { node_id: nodeId });
    } catch (e) {
      console.warn('[WindSight] subscribe_node 失败:', e);
    }
  }

  function tryUnsubscribeNode(nodeId) {
    if (!socket) return;
    if (!nodeId) return;
    try {
      socket.emit('unsubscribe_node', { node_id: nodeId });
    } catch (e) {
      console.warn('[WindSight] unsubscribe_node 失败:', e);
    }
  }

  function appendRealtimeRow(row) {
    if (!row || !row.timestamp) return;
    cachedRows.push({
      timestamp: row.timestamp,
      voltages: row.voltages || [],
      currents: row.currents || [],
      speeds: row.speeds || []
    });

    // 限制缓存长度，避免无限增长
    const maxKeep = Math.max(200, Math.min(2000, parseInt(elHistoryLimit?.value || '600', 10) || 600));
    if (cachedRows.length > maxKeep) {
      cachedRows = cachedRows.slice(cachedRows.length - maxKeep);
    }
    renderChartsFromCache();
  }

  if (socket) {
    socket.on('monitor_update', (msg) => {
      try {
        if (!msg || msg.node_id !== selectedNodeId) return;
        // 兼容：后端 emit 的 data 结构为 NodeData.to_dict()
        const data = msg.data || {};
        appendRealtimeRow(data);
      } catch (e) {
        console.warn('[WindSight] monitor_update 处理失败:', e);
      }
    });

    socket.on('node_data_update', (msg) => {
      try {
        if (!msg || msg.node_id !== selectedNodeId) return;
        const data = msg.data || {};
        appendRealtimeRow(data);
      } catch (e) {
        console.warn('[WindSight] node_data_update 处理失败:', e);
      }
    });
  }

  // ==================== 事件绑定 ====================
  elNodeSelect.addEventListener('change', async () => {
    const next = (elNodeSelect.value || '').trim();

    // 退订旧节点
    if (selectedNodeId && selectedNodeId !== next) {
      tryUnsubscribeNode(selectedNodeId);
    }

    selectedNodeId = next;
    cachedRows = [];
    setLastDataTimeUI('--');

    // 订阅新节点（用于实时追加）
    if (selectedNodeId) {
      trySubscribeNode(selectedNodeId);
    }

    await loadNodeHistory();
  });

  if (elBtnReload) {
    elBtnReload.addEventListener('click', async () => {
      await loadNodeHistory();
    });
  }
  if (elBtnSelectAll) {
    elBtnSelectAll.addEventListener('click', () => setAllChannels(true));
  }
  if (elBtnSelectNone) {
    elBtnSelectNone.addEventListener('click', () => setAllChannels(false));
  }

  // ==================== 初始化 ====================
  document.addEventListener('DOMContentLoaded', async () => {
    // 端口显示（仅用于提示，真实端口取当前地址栏）
    const badge = document.getElementById('uiPortBadge');
    if (badge) {
      try {
        const port = window.location.port || '5000';
        badge.textContent = port;
      } catch (e) {}
    }

    buildChannelCheckboxes();
    setSelectedCountUI();

    // 默认给用户一点“可见效果”：预选 CH1 与 CH5（对应需求示例）
    selectedChannels.add(0);
    selectedChannels.add(4);
    // 勾选 UI
    ['ch_0', 'ch_4'].forEach((id) => {
      const cb = document.getElementById(id);
      if (cb) cb.checked = true;
    });
    setSelectedCountUI();

    // 初始空图
    renderChartsFromCache();

    // 拉取节点列表
    await loadNodeList();

    // 从系统概览页（/system_overview）传递的“预选节点”
    try {
      const preset = (localStorage.getItem('selectedNodeId') || '').trim();
      if (preset) {
        const opt = Array.from(elNodeSelect.options).find(o => o.value === preset);
        if (opt) {
          elNodeSelect.value = preset;
          // 触发一次 change：进入订阅/轮询逻辑
          elNodeSelect.dispatchEvent(new Event('change'));
        }
        localStorage.removeItem('selectedNodeId');
      }
    } catch (e) {
      // 忽略 localStorage 不可用
    }

    // 响应式：窗口变化时 resize
    window.addEventListener('resize', () => {
      chartVoltage.resize();
      chartCurrent.resize();
      chartSpeed.resize();
    });
  });
}


