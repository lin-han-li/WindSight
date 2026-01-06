/**
 * WindSight 系统概览页（system_overview.html）
 * 目标：
 * - 展示：在线节点数、节点总数、近24h数据帧数、最近上报时间、DB大小
 * - 展示：节点状态墙（在线/离线 + 最后上报时间）
 * - 点击节点卡片：跳转 /monitor，并通过 localStorage 传递选中的 node_id
 *
 * 注意：
 * - 本项目已移除“故障诊断/知识图谱/报告生成”等功能，此页面不包含相关入口。
 * - 所有文字为简体中文。
 */

const elStatOnline = document.getElementById('stat-online');
const elStatTotal = document.getElementById('stat-total');
const elStat24h = document.getElementById('stat-24h');
const elStatLatest = document.getElementById('stat-latest');
const elStatRecords = document.getElementById('stat-records');
const elStatDb = document.getElementById('stat-db');
const elStatTimeout = document.getElementById('stat-timeout');

const elOnlyOnlineSwitch = document.getElementById('onlyOnlineSwitch');
const elBtnRefreshNodes = document.getElementById('btnRefreshNodes');
const elNodeStatusGrid = document.getElementById('nodeStatusGrid');
const elNodeStatusEmpty = document.getElementById('nodeStatusEmpty');

if (!elStatOnline || !elNodeStatusGrid) {
  console.warn('[WindSight] system_overview.js 未检测到系统概览页元素，已跳过初始化。');
} else {
  async function fetchJson(url) {
    const resp = await fetch(url, { method: 'GET' });
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    if (!ct.includes('application/json')) {
      throw new Error('接口未返回 JSON（可能未登录）');
    }
    return await resp.json();
  }

  function setText(el, txt) {
    if (!el) return;
    el.textContent = (txt === undefined || txt === null || txt === '') ? '--' : String(txt);
  }

  function nodeBadge(online) {
    const cls = online ? 'bg-success' : 'bg-secondary';
    const text = online ? '在线' : '离线';
    return `<span class="badge ${cls}">${text}</span>`;
  }

  function renderNodes(nodes, onlyOnline) {
    const list = Array.isArray(nodes) ? nodes : [];
    const visible = onlyOnline ? list.filter(n => !!n.online) : list;

    if (visible.length === 0) {
      if (elNodeStatusEmpty) elNodeStatusEmpty.classList.remove('d-none');
      elNodeStatusGrid.innerHTML = '';
      return;
    }

    if (elNodeStatusEmpty) elNodeStatusEmpty.classList.add('d-none');

    const html = visible.map(n => {
      const nodeId = n.node_id || '';
      const online = !!n.online;
      const last = n.last_upload || '--';
      const borderCls = online ? 'border-success' : 'border-secondary';
      const hint = online ? '点击进入该节点实时监测' : '离线节点（仍可回放历史数据）';

      return `
        <div class="col">
          <div class="card h-100 border ${borderCls}" role="button" data-node-id="${nodeId}">
            <div class="card-body">
              <div class="d-flex justify-content-between align-items-start mb-2">
                <div style="min-width: 0;">
                  <div class="fw-bold text-truncate" title="${nodeId}">${nodeId || '未知节点'}</div>
                  <div class="text-muted small mt-1">最后上报：${last}</div>
                </div>
                ${nodeBadge(online)}
              </div>
              <div class="text-muted small">
                <i class="bi bi-cursor me-1"></i>${hint}
              </div>
            </div>
          </div>
        </div>
      `;
    }).join('');

    elNodeStatusGrid.innerHTML = html;

    // 绑定点击事件（事件委托）
    elNodeStatusGrid.querySelectorAll('[data-node-id]').forEach(card => {
      card.addEventListener('click', () => {
        const nodeId = (card.getAttribute('data-node-id') || '').trim();
        if (!nodeId) return;
        try {
          localStorage.setItem('selectedNodeId', nodeId);
        } catch (e) {
          // 忽略 localStorage 不可用
        }
        window.location.href = '/monitor';
      });
    });
  }

  async function loadStats() {
    try {
      const s = await fetchJson('/api/dashboard/stats');
      setText(elStatOnline, s.online_nodes ?? 0);
      setText(elStatTotal, s.total_nodes ?? 0);
      setText(elStat24h, s.records_24h ?? 0);
      setText(elStatLatest, s.latest_upload || '--');
      setText(elStatRecords, s.total_records ?? 0);
      setText(elStatDb, (typeof s.database_size_mb === 'number') ? s.database_size_mb.toFixed(2) : '0.00');
      setText(elStatTimeout, s.node_timeout_sec ?? '--');
    } catch (e) {
      console.error('[WindSight] 系统概览统计加载失败:', e);
    }
  }

  async function loadNodesOnce() {
    try {
      const onlyOnline = !!(elOnlyOnlineSwitch && elOnlyOnlineSwitch.checked);
      const res = await fetchJson('/api/nodes');
      const nodes = (res && res.success && Array.isArray(res.nodes)) ? res.nodes : [];
      renderNodes(nodes, onlyOnline);
    } catch (e) {
      console.error('[WindSight] 节点列表加载失败:', e);
    }
  }

  function bindUi() {
    if (elOnlyOnlineSwitch) {
      elOnlyOnlineSwitch.addEventListener('change', () => {
        loadNodesOnce();
      });
    }
    if (elBtnRefreshNodes) {
      elBtnRefreshNodes.addEventListener('click', () => {
        loadStats();
        loadNodesOnce();
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindUi();
    loadStats();
    loadNodesOnce();
    // 轻量轮询：刷新统计与节点状态（默认 3 秒）
    setInterval(() => {
      loadStats();
      loadNodesOnce();
    }, 3000);
  });
}


