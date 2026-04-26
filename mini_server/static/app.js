(() => {
  const params = new URLSearchParams(window.location.search);
  const allNodesToken = String(window.MINI_ALL_NODES_TOKEN || "__all__");
  const initialNodeId = (params.get("node_id") || "").trim() || allNodesToken;

  const elNodeId = document.getElementById("node-id");
  const elNodeFilter = document.getElementById("node-filter");
  const elNodeCount = document.getElementById("node-count");
  const elKnownNodes = document.getElementById("known-nodes");
  const elStatusBadge = document.getElementById("status-badge");
  const elStatusText = document.getElementById("status-text");
  const elRecvCount = document.getElementById("recv-count");
  const elLast = document.getElementById("last-received");
  const elParsed = document.getElementById("parsed");
  const elRaw = document.getElementById("raw-json");
  const elBtnClear = document.getElementById("btnClearView");

  const latestByNode = new Map();
  const nodeMetaByNode = new Map();
  let currentNodeId = initialNodeId;
  let recvCount = 0;

  function resetView(message = "已清空，等待数据...") {
    recvCount = 0;
    if (elRecvCount) elRecvCount.textContent = "0";
    if (elLast) elLast.textContent = "--";
    if (elParsed) elParsed.textContent = message;
    if (elRaw) elRaw.textContent = message;
  }

  function setStatus(state) {
    const textMap = {
      connected: "已连接",
      disconnected: "未连接",
      connect_error: "连接失败",
      socket_io_missing: "依赖缺失",
    };
    const badgeClassMap = {
      connected: "bg-success",
      connect_error: "bg-danger",
      socket_io_missing: "bg-warning",
      disconnected: "bg-secondary",
    };

    const normalized = String(state || "disconnected");
    if (elStatusBadge) {
      elStatusBadge.textContent = normalized;
      elStatusBadge.classList.remove("bg-success", "bg-secondary", "bg-danger", "bg-warning");
      elStatusBadge.classList.add(badgeClassMap[normalized] || "bg-secondary");
    }
    if (elStatusText) {
      elStatusText.textContent = textMap[normalized] || "未连接";
    }
  }

  function updateUrl() {
    const url = new URL(window.location.href);
    if (currentNodeId === allNodesToken) {
      url.searchParams.delete("node_id");
    } else {
      url.searchParams.set("node_id", currentNodeId);
    }
    window.history.replaceState(null, "", url.toString());
  }

  function getSortedNodeIds() {
    return [...nodeMetaByNode.keys()].sort((left, right) => {
      const a = nodeMetaByNode.get(left) || {};
      const b = nodeMetaByNode.get(right) || {};
      return String(b.received_at || "").localeCompare(String(a.received_at || "")) || left.localeCompare(right);
    });
  }

  function renderNodeOptions() {
    if (!elNodeFilter) return;
    const ids = getSortedNodeIds();
    const currentValue = currentNodeId;
    elNodeFilter.innerHTML = "";

    const allOption = document.createElement("option");
    allOption.value = allNodesToken;
    allOption.textContent = "全部节点（自动跟随最新）";
    elNodeFilter.appendChild(allOption);

    ids.forEach((nodeId) => {
      const option = document.createElement("option");
      option.value = nodeId;
      option.textContent = nodeId;
      elNodeFilter.appendChild(option);
    });

    elNodeFilter.value = ids.includes(currentValue) || currentValue === allNodesToken ? currentValue : allNodesToken;
  }

  function renderNodeSummary() {
    const ids = getSortedNodeIds();
    if (elNodeCount) elNodeCount.textContent = String(ids.length);
    if (elKnownNodes) {
      elKnownNodes.textContent = ids.length ? ids.join("、") : "暂无";
    }
  }

  function getCurrentMessage() {
    if (currentNodeId !== allNodesToken) {
      return latestByNode.get(currentNodeId) || null;
    }

    for (const nodeId of getSortedNodeIds()) {
      const msg = latestByNode.get(nodeId);
      if (msg) return msg;
    }
    return null;
  }

  function renderMessage(msg) {
    if (!msg) {
      if (elNodeId) {
        elNodeId.textContent =
          currentNodeId === allNodesToken ? "全部节点" : currentNodeId;
      }
      if (elLast) elLast.textContent = "--";
      if (elParsed) {
        elParsed.textContent =
          currentNodeId === allNodesToken
            ? "等待任意节点上报数据..."
            : `等待节点 ${currentNodeId} 上报数据...`;
      }
      if (elRaw) {
        elRaw.textContent =
          currentNodeId === allNodesToken
            ? "等待任意节点上报数据..."
            : `等待节点 ${currentNodeId} 上报数据...`;
      }
      return;
    }

    if (elNodeId) {
      elNodeId.textContent =
        currentNodeId === allNodesToken ? `${msg.node_id}（最新）` : msg.node_id;
    }
    if (elLast) elLast.textContent = msg.received_at || "--";
    if (elParsed) {
      elParsed.textContent = JSON.stringify(msg.parsed || {}, null, 2);
    }
    if (elRaw) {
      const raw = typeof msg.raw === "object" ? msg.raw : msg;
      elRaw.textContent = JSON.stringify(raw, null, 2);
    }
  }

  function applyNodeSelection(nextNodeId, syncUrl = true) {
    currentNodeId = nextNodeId || allNodesToken;
    if (syncUrl) updateUrl();
    renderNodeOptions();
    renderNodeSummary();
    renderMessage(getCurrentMessage());
  }

  function rememberNode(meta) {
    if (!meta || !meta.node_id) return;
    const previous = nodeMetaByNode.get(meta.node_id) || {};
    nodeMetaByNode.set(meta.node_id, {
      ...previous,
      ...meta,
    });
  }

  setStatus("disconnected");
  resetView("等待数据...");

  if (elBtnClear) {
    elBtnClear.addEventListener("click", () => {
      resetView();
      renderMessage(getCurrentMessage());
    });
  }

  if (elNodeFilter) {
    elNodeFilter.addEventListener("change", (event) => {
      applyNodeSelection(String(event.target.value || allNodesToken));
    });
  }

  if (typeof window.io !== "function") {
    setStatus("socket_io_missing");
    if (elParsed) {
      elParsed.textContent =
        "未加载 Socket.IO 客户端库。\n\n请确认可访问：\nhttps://cdn.socket.io/4.7.5/socket.io.min.js";
    }
    return;
  }

  const socket = window.io({
    transports: ["websocket", "polling"],
  });

  socket.on("connect", () => {
    setStatus("connected");
    socket.emit("subscribe_all");
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

  socket.on("node_registry", (payload) => {
    const nodes = Array.isArray(payload && payload.nodes) ? payload.nodes : [];
    nodes.forEach((node) => rememberNode(node));
    renderNodeOptions();
    renderNodeSummary();
    renderMessage(getCurrentMessage());
  });

  socket.on("snapshot", (payload) => {
    const messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
    messages.forEach((msg) => {
      if (!msg || !msg.node_id) return;
      latestByNode.set(msg.node_id, msg);
      rememberNode({
        node_id: msg.node_id,
        received_at: msg.received_at,
      });
    });
    renderNodeOptions();
    renderNodeSummary();
    renderMessage(getCurrentMessage());
  });

  socket.on("mini_update", (msg) => {
    if (!msg || !msg.node_id) return;

    recvCount += 1;
    if (elRecvCount) elRecvCount.textContent = String(recvCount);

    latestByNode.set(msg.node_id, msg);
    rememberNode({
      node_id: msg.node_id,
      received_at: msg.received_at,
    });

    renderNodeOptions();
    renderNodeSummary();

    if (currentNodeId === allNodesToken || currentNodeId === msg.node_id) {
      renderMessage(msg);
    }
  });

  socket.on("error", (err) => {
    setStatus("connect_error");
    if (elParsed) {
      elParsed.textContent = JSON.stringify(err || { error: "unknown" }, null, 2);
    }
  });

  applyNodeSelection(initialNodeId, false);
})();
