(() => {
  const params = new URLSearchParams(window.location.search);
  const defaultNodeId = String(window.MINI_DEFAULT_NODE_ID || "WIND_001");
  const nodeId = (params.get("node_id") || defaultNodeId).trim() || defaultNodeId;

  const elNodeId = document.getElementById("node-id");
  const elStatusBadge = document.getElementById("status-badge");
  const elStatusText = document.getElementById("status-text");
  const elRecvCount = document.getElementById("recv-count");
  const elLast = document.getElementById("last-received");
  const elParsed = document.getElementById("parsed");
  const elRaw = document.getElementById("raw-json");
  const elBtnClear = document.getElementById("btnClearView");

  if (elNodeId) elNodeId.textContent = nodeId;

  let recvCount = 0;

  function resetView() {
    recvCount = 0;
    if (elRecvCount) elRecvCount.textContent = "0";
    if (elLast) elLast.textContent = "--";
    if (elParsed) elParsed.textContent = "已清空，等待数据...";
    if (elRaw) elRaw.textContent = "已清空，等待数据...";
  }

  if (elBtnClear) {
    elBtnClear.addEventListener("click", () => {
      resetView();
    });
  }

  function setStatus(state) {
    const s = String(state || "disconnected");
    if (elStatusBadge) {
      elStatusBadge.textContent = s;
      elStatusBadge.classList.remove("bg-success", "bg-secondary", "bg-danger", "bg-warning");
      if (s === "connected") elStatusBadge.classList.add("bg-success");
      else if (s === "connect_error") elStatusBadge.classList.add("bg-danger");
      else if (s === "socket.io_missing") elStatusBadge.classList.add("bg-warning");
      else elStatusBadge.classList.add("bg-secondary");
    }
    if (elStatusText) {
      if (s === "connected") elStatusText.textContent = "已连接";
      else if (s === "connect_error") elStatusText.textContent = "连接失败";
      else if (s === "socket.io_missing") elStatusText.textContent = "依赖缺失";
      else elStatusText.textContent = "未连接";
    }
  }

  setStatus("disconnected");

  if (typeof window.io !== "function") {
    setStatus("socket.io_missing");
    if (elParsed) {
      elParsed.textContent =
        "未加载 Socket.IO 客户端库。\n\n" +
        "请确认可访问：\n" +
        "https://cdn.socket.io/4.7.5/socket.io.min.js\n\n" +
        "若内网/离线环境，请改为本地引入 socket.io.min.js。";
    }
    return;
  }

  const socket = window.io({
    transports: ["websocket", "polling"],
  });

  socket.on("connect", () => {
    setStatus("connected");
    socket.emit("subscribe_node", { node_id: nodeId });
  });

  socket.on("disconnect", () => {
    setStatus("disconnected");
  });

  socket.on("connect_error", (err) => {
    setStatus("connect_error");
    if (elParsed) {
      const out = { message: err && err.message ? err.message : String(err || "unknown") };
      elParsed.textContent = JSON.stringify(out, null, 2);
    }
  });

  socket.on("mini_update", (msg) => {
    if (!msg || msg.node_id !== nodeId) return;
    recvCount += 1;
    if (elRecvCount) elRecvCount.textContent = String(recvCount);
    if (elLast) elLast.textContent = msg.received_at || "-";

    const raw = typeof msg.raw === "object" ? msg.raw : msg;
    if (elRaw) elRaw.textContent = JSON.stringify(raw, null, 2);

    if (elParsed) {
      elParsed.textContent = JSON.stringify(msg.parsed || {}, null, 2);
    }
  });

  socket.on("error", (err) => {
    setStatus("connect_error");
    if (elParsed) {
      elParsed.textContent = JSON.stringify(err || { error: "unknown" }, null, 2);
    }
  });
})();

