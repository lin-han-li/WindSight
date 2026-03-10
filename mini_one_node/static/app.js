(() => {
  const params = new URLSearchParams(window.location.search);
  const defaultNodeId = String(window.MINI_DEFAULT_NODE_ID || "WIN_001");
  const filterNodeId = (params.get("node_id") || "").trim();

  const elNodeId = document.getElementById("node-id");
  const elModeLabel = document.getElementById("mode-label");
  const elStatusBadge = document.getElementById("status-badge");
  const elStatusText = document.getElementById("status-text");
  const elRecvCount = document.getElementById("recv-count");
  const elLast = document.getElementById("last-received");
  const elNodeList = document.getElementById("node-list");
  const elParsed = document.getElementById("parsed");
  const elRaw = document.getElementById("raw-json");
  const elBtnClear = document.getElementById("btnClearView");

  const state = {
    activeNodeId: filterNodeId || "",
    recvCount: 0,
    nodes: new Map(),
  };

  function setStatus(stateValue) {
    const value = String(stateValue || "disconnected");
    if (elStatusBadge) {
      elStatusBadge.textContent = value;
      elStatusBadge.className = "badge";
      if (value === "connected") elStatusBadge.classList.add("text-bg-success");
      else if (value === "connect_error") elStatusBadge.classList.add("text-bg-danger");
      else if (value === "socket.io_missing") elStatusBadge.classList.add("text-bg-warning");
      else elStatusBadge.classList.add("text-bg-secondary");
    }
    if (elStatusText) {
      if (value === "connected") elStatusText.textContent = "已连接";
      else if (value === "connect_error") elStatusText.textContent = "连接失败";
      else if (value === "socket.io_missing") elStatusText.textContent = "依赖缺失";
      else elStatusText.textContent = "未连接";
    }
  }

  function formatMode() {
    if (filterNodeId) {
      return `单节点过滤：${filterNodeId}`;
    }
    return "全节点监测";
  }

  function sortedNodes() {
    return Array.from(state.nodes.values()).sort((a, b) => String(b.received_at || "").localeCompare(String(a.received_at || "")));
  }

  function renderActiveNode() {
    const active = state.activeNodeId ? state.nodes.get(state.activeNodeId) : null;
    if (elNodeId) {
      elNodeId.textContent = active ? active.node_id : filterNodeId || "ALL";
    }
    if (elModeLabel) {
      elModeLabel.textContent = formatMode();
    }
    if (elLast) {
      elLast.textContent = active ? active.received_at || "--" : "--";
    }
    if (elParsed) {
      elParsed.textContent = active ? JSON.stringify(active.parsed || {}, null, 2) : "等待数据...";
    }
    if (elRaw) {
      elRaw.textContent = active ? JSON.stringify(active.raw || {}, null, 2) : "等待数据...";
    }
  }

  function renderNodeList() {
    if (!elNodeList) return;
    const rows = sortedNodes();
    if (rows.length === 0) {
      elNodeList.innerHTML = '<div class="text-muted small">暂无节点数据</div>';
      return;
    }
    elNodeList.innerHTML = rows
      .map((item) => {
        const active = item.node_id === state.activeNodeId ? "active" : "";
        const count = item.count || 0;
        const sub = (item.parsed && item.parsed.sub) || "--";
        const receivedAt = item.received_at || "--";
        return `
          <button type="button" class="list-group-item list-group-item-action ${active}" data-node-id="${item.node_id}">
            <div class="fw-bold">${item.node_id}</div>
            <div class="small text-muted">sub=${sub} · frames=${count}</div>
            <div class="small text-muted">${receivedAt}</div>
          </button>
        `;
      })
      .join("");
    elNodeList.querySelectorAll("[data-node-id]").forEach((button) => {
      button.addEventListener("click", () => {
        state.activeNodeId = button.dataset.nodeId || "";
        renderNodeList();
        renderActiveNode();
      });
    });
  }

  function resetView() {
    state.recvCount = 0;
    state.nodes = new Map();
    state.activeNodeId = filterNodeId || "";
    if (elRecvCount) elRecvCount.textContent = "0";
    renderNodeList();
    renderActiveNode();
  }

  function upsertMessage(msg, countAsReceived) {
    if (!msg || !msg.node_id) {
      return;
    }
    const previous = state.nodes.get(msg.node_id) || { count: 0 };
    state.nodes.set(msg.node_id, {
      ...msg,
      count: previous.count + (countAsReceived ? 1 : 0),
    });
    if (!state.activeNodeId) {
      state.activeNodeId = msg.node_id;
    }
    if (state.activeNodeId === msg.node_id) {
      renderActiveNode();
    }
    renderNodeList();
  }

  if (elBtnClear) {
    elBtnClear.addEventListener("click", resetView);
  }

  if (elRecvCount) {
    elRecvCount.textContent = "0";
  }
  renderNodeList();
  renderActiveNode();
  setStatus("disconnected");

  if (typeof window.io !== "function") {
    setStatus("socket.io_missing");
    if (elParsed) {
      elParsed.textContent =
        "未加载 Socket.IO 客户端。\n\n请确认可访问：\nhttps://cdn.socket.io/4.7.5/socket.io.min.js";
    }
    return;
  }

  const socket = window.io({
    transports: ["websocket", "polling"],
  });

  socket.on("connect", () => {
    setStatus("connected");
    if (filterNodeId) {
      socket.emit("subscribe_node", { node_id: filterNodeId || defaultNodeId });
    } else {
      socket.emit("subscribe_all");
    }
  });

  socket.on("disconnect", () => {
    setStatus("disconnected");
  });

  socket.on("connect_error", (err) => {
    setStatus("connect_error");
    if (elParsed) {
      elParsed.textContent = JSON.stringify(
        { message: err && err.message ? err.message : String(err || "unknown") },
        null,
        2
      );
    }
  });

  socket.on("mini_snapshot", (payload) => {
    const rows = Array.isArray(payload && payload.nodes) ? payload.nodes : [];
    rows.forEach((msg) => upsertMessage(msg, false));
  });

  socket.on("mini_update", (msg) => {
    if (filterNodeId && msg && msg.node_id !== filterNodeId) {
      return;
    }
    state.recvCount += 1;
    if (elRecvCount) {
      elRecvCount.textContent = String(state.recvCount);
    }
    upsertMessage(msg, true);
  });

  socket.on("error", (err) => {
    setStatus("connect_error");
    if (elParsed) {
      elParsed.textContent = JSON.stringify(err || { error: "unknown" }, null, 2);
    }
  });
})();
