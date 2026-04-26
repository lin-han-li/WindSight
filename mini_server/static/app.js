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
  const elBtnShowAll = document.getElementById("btnShowAll");
  const elViewModeBadge = document.getElementById("view-mode-badge");
  const elLatestNodeId = document.getElementById("latest-node-id");
  const elLatestNodeSummary = document.getElementById("latest-node-summary");
  const elNodeWall = document.getElementById("node-wall");
  const elNodeWallEmpty = document.getElementById("node-wall-empty");
  const elSummaryNodeId = document.getElementById("summary-node-id");
  const elSummaryTime = document.getElementById("summary-time");
  const elSummaryNote = document.getElementById("summary-note");
  const elSummaryCount = document.getElementById("summary-count");
  const elSummaryLengths = document.getElementById("summary-lengths");
  const elSummarySample = document.getElementById("summary-sample");

  const latestByNode = new Map();
  const nodeMetaByNode = new Map();
  let currentNodeId = initialNodeId;
  let recvCount = 0;

  function formatBeijingTime(value) {
    if (!value) return "--";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);

    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);

    const map = Object.fromEntries(
      parts
        .filter((item) => item.type !== "literal")
        .map((item) => [item.type, item.value])
    );

    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
  }

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
      return (
        String(b.received_at || "").localeCompare(String(a.received_at || "")) ||
        left.localeCompare(right)
      );
    });
  }

  function getLatestMessageOverall() {
    for (const nodeId of getSortedNodeIds()) {
      const msg = latestByNode.get(nodeId);
      if (msg) return msg;
    }
    return null;
  }

  function getCurrentMessage() {
    if (currentNodeId !== allNodesToken) {
      return latestByNode.get(currentNodeId) || null;
    }
    return getLatestMessageOverall();
  }

  function extractSummary(msg) {
    if (!msg) return "等待数据";

    const raw = msg.raw && typeof msg.raw === "object" ? msg.raw : {};
    const parsed = msg.parsed && typeof msg.parsed === "object" ? msg.parsed : {};
    const parts = [];

    if (typeof raw.note === "string" && raw.note.trim()) {
      parts.push(raw.note.trim());
    }

    if (parsed.lengths) {
      parts.push(
        `V/C/S ${parsed.lengths.voltages || 0}/${parsed.lengths.currents || 0}/${parsed.lengths.speeds || 0}`
      );
    } else {
      parts.push("仅文本状态上报");
    }

    return parts.join(" · ");
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

    elNodeFilter.value =
      ids.includes(currentValue) || currentValue === allNodesToken
        ? currentValue
        : allNodesToken;
  }

  function renderNodeSummary() {
    const ids = getSortedNodeIds();
    if (elNodeCount) elNodeCount.textContent = String(ids.length);
    if (elKnownNodes) {
      const preview = ids.slice(0, 6).join("、");
      elKnownNodes.textContent =
        ids.length === 0 ? "暂无" : ids.length > 6 ? `${preview} 等 ${ids.length} 个` : preview;
    }
  }

  function renderViewMode() {
    if (!elViewModeBadge) return;
    if (currentNodeId === allNodesToken) {
      elViewModeBadge.textContent = "全部节点模式";
      elViewModeBadge.className = "badge bg-primary-subtle text-primary-emphasis";
    } else {
      elViewModeBadge.textContent = `单节点：${currentNodeId}`;
      elViewModeBadge.className = "badge bg-warning-subtle text-warning-emphasis";
    }
  }

  function renderLatestOverview() {
    const latest = getLatestMessageOverall();
    if (elLatestNodeId) {
      elLatestNodeId.textContent = latest ? latest.node_id : "--";
    }
    if (elLatestNodeSummary) {
      elLatestNodeSummary.textContent = latest ? extractSummary(latest) : "等待节点上报";
    }
  }

  function renderNodeWall() {
    if (!elNodeWall || !elNodeWallEmpty) return;

    const ids = getSortedNodeIds();
    elNodeWall.innerHTML = "";

    if (ids.length === 0) {
      elNodeWallEmpty.classList.remove("d-none");
      return;
    }

    elNodeWallEmpty.classList.add("d-none");

    ids.forEach((nodeId) => {
      const meta = nodeMetaByNode.get(nodeId) || {};
      const msg = latestByNode.get(nodeId) || null;
      const isActive = currentNodeId === nodeId;
      const isLatestOverall = currentNodeId === allNodesToken && getLatestMessageOverall()?.node_id === nodeId;

      const button = document.createElement("button");
      button.type = "button";
      button.className = `node-card-mini${isActive ? " active" : ""}${isLatestOverall ? " latest" : ""}`;
      button.innerHTML = `
        <div class="node-card-head">
          <div>
            <div class="node-card-id">${nodeId}</div>
            <div class="node-card-time">${formatBeijingTime(meta.received_at)}</div>
          </div>
          <span class="badge ${isActive ? "bg-primary" : "bg-light text-dark"}">${meta.message_count || 0} 条</span>
        </div>
        <div class="node-card-note">${extractSummary(msg)}</div>
      `;
      button.addEventListener("click", () => applyNodeSelection(nodeId));
      elNodeWall.appendChild(button);
    });
  }

  function renderMessage(msg) {
    if (!msg) {
      if (elNodeId) {
        elNodeId.textContent = currentNodeId === allNodesToken ? "全部节点" : currentNodeId;
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
    if (elLast) elLast.textContent = formatBeijingTime(msg.received_at);
    if (elParsed) {
      const parsedView = {
        ...(msg.parsed || {}),
        received_at_beijing: formatBeijingTime(msg.received_at),
      };
      elParsed.textContent = JSON.stringify(parsedView, null, 2);
    }
    if (elRaw) {
      const raw = typeof msg.raw === "object" ? msg.raw : msg;
      elRaw.textContent = JSON.stringify(raw, null, 2);
    }
  }

  function renderDetailSummary(msg) {
    const meta = msg && msg.node_id ? nodeMetaByNode.get(msg.node_id) || {} : {};
    const parsed = msg && typeof msg.parsed === "object" ? msg.parsed || {} : {};
    const raw = msg && typeof msg.raw === "object" ? msg.raw || {} : {};
    const lengths = parsed.lengths || {};
    const sample = parsed.sample || {};

    if (elSummaryNodeId) {
      elSummaryNodeId.textContent = msg ? msg.node_id : "--";
    }
    if (elSummaryTime) {
      elSummaryTime.textContent = msg ? formatBeijingTime(msg.received_at) : "--";
    }
    if (elSummaryNote) {
      elSummaryNote.textContent = extractSummary(msg);
    }
    if (elSummaryCount) {
      elSummaryCount.textContent = msg ? String(meta.message_count || 0) : "0";
    }
    if (elSummaryLengths) {
      elSummaryLengths.textContent = msg
        ? lengths.voltages || lengths.currents || lengths.speeds
          ? `V/C/S ${lengths.voltages || 0}/${lengths.currents || 0}/${lengths.speeds || 0}`
          : "无数组数据"
        : "--";
    }
    if (elSummarySample) {
      elSummarySample.textContent = msg
        ? sample.v0 !== undefined || sample.c0 !== undefined || sample.s0 !== undefined
          ? `v0=${sample.v0 ?? "-"} · c0=${sample.c0 ?? "-"} · s0=${sample.s0 ?? "-"}`
          : typeof raw.note === "string" && raw.note.trim()
            ? raw.note.trim()
            : "无采样摘要"
        : "--";
    }
  }

  function applyNodeSelection(nextNodeId, syncUrl = true) {
    currentNodeId = nextNodeId || allNodesToken;
    if (syncUrl) updateUrl();
    renderNodeOptions();
    renderNodeSummary();
    renderViewMode();
    renderLatestOverview();
    renderNodeWall();
    renderMessage(getCurrentMessage());
    renderDetailSummary(getCurrentMessage());
  }

  function rememberNode(meta) {
    if (!meta || !meta.node_id) return;
    const previous = nodeMetaByNode.get(meta.node_id) || {};
    nodeMetaByNode.set(meta.node_id, {
      ...previous,
      ...meta,
    });
  }

  function rememberMessage(msg) {
    if (!msg || !msg.node_id) return;
    latestByNode.set(msg.node_id, msg);
    const previous = nodeMetaByNode.get(msg.node_id) || {};
    nodeMetaByNode.set(msg.node_id, {
      ...previous,
      node_id: msg.node_id,
      received_at: msg.received_at,
      message_count: Number(previous.message_count || 0) + 1,
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

  if (elBtnShowAll) {
    elBtnShowAll.addEventListener("click", () => {
      applyNodeSelection(allNodesToken);
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
    renderViewMode();
    renderLatestOverview();
    renderNodeWall();
    renderMessage(getCurrentMessage());
    renderDetailSummary(getCurrentMessage());
  });

  socket.on("snapshot", (payload) => {
    const messages = Array.isArray(payload && payload.messages) ? payload.messages : [];
    messages.forEach((msg) => {
      if (!msg || !msg.node_id) return;
      latestByNode.set(msg.node_id, msg);
      const previous = nodeMetaByNode.get(msg.node_id) || {};
      nodeMetaByNode.set(msg.node_id, {
        ...previous,
        node_id: msg.node_id,
        received_at: msg.received_at,
      });
    });
    renderNodeOptions();
    renderNodeSummary();
    renderViewMode();
    renderLatestOverview();
    renderNodeWall();
    renderMessage(getCurrentMessage());
    renderDetailSummary(getCurrentMessage());
  });

  socket.on("mini_update", (msg) => {
    if (!msg || !msg.node_id) return;

    recvCount += 1;
    if (elRecvCount) elRecvCount.textContent = String(recvCount);

    rememberMessage(msg);
    renderNodeOptions();
    renderNodeSummary();
    renderViewMode();
    renderLatestOverview();
    renderNodeWall();

    if (currentNodeId === allNodesToken || currentNodeId === msg.node_id) {
      renderMessage(msg);
      renderDetailSummary(msg);
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
