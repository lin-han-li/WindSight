(function () {
    const app = document.getElementById("deviceTreeApp");
    if (!app) return;

    const mode = app.dataset.mode || "my";
    const els = {
        pageStatus: document.getElementById("pageStatusText"),
        registerForm: document.getElementById("nodeRegisterForm"),
        nodeIdInput: document.getElementById("nodeIdInput"),
        nodeNameInput: document.getElementById("nodeNameInput"),
        nodeKeyPanel: document.getElementById("nodeKeyPanel"),
        nodeKeyText: document.getElementById("nodeKeyText"),
        copyNodeKeyBtn: document.getElementById("copyNodeKeyBtn"),
        refreshNodesBtn: document.getElementById("refreshNodesBtn"),
        refreshUsersBtn: document.getElementById("refreshUsersBtn"),
        adminUserList: document.getElementById("adminUserList"),
        adminNodeTitle: document.getElementById("adminNodeTitle"),
        adminNodeHint: document.getElementById("adminNodeHint"),
        nodeTreeList: document.getElementById("nodeTreeList"),
        selectedNodeTitle: document.getElementById("selectedNodeTitle"),
        selectedNodeMeta: document.getElementById("selectedNodeMeta"),
        editNodeNameBtn: document.getElementById("editNodeNameBtn"),
        nodeNameEditForm: document.getElementById("nodeNameEditForm"),
        nodeNameEditInput: document.getElementById("nodeNameEditInput"),
        saveNodeNameBtn: document.getElementById("saveNodeNameBtn"),
        cancelNodeNameEditBtn: document.getElementById("cancelNodeNameEditBtn"),
        selectedNodeKeyPanel: document.getElementById("selectedNodeKeyPanel"),
        selectedNodeKeyText: document.getElementById("selectedNodeKeyText"),
        selectedCredentialKeyId: document.getElementById("selectedCredentialKeyId"),
        selectedCredentialStatus: document.getElementById("selectedCredentialStatus"),
        copySelectedNodeKeyBtn: document.getElementById("copySelectedNodeKeyBtn"),
        rotateNodeKeyBtn: document.getElementById("rotateNodeKeyBtn"),
        forceRevokeCredentialBtn: document.getElementById("forceRevokeCredentialBtn"),
        turbineCountText: document.getElementById("turbineCountText"),
        turbineList: document.getElementById("turbineList"),
        adminTurbineActions: document.getElementById("adminTurbineActions"),
        selectedTurbineText: document.getElementById("selectedTurbineText"),
        monitorActionLink: document.getElementById("monitorActionLink"),
        overviewActionLink: document.getElementById("overviewActionLink"),
        adminUserDangerPanel: document.getElementById("adminUserDangerPanel"),
        adminDangerUserText: document.getElementById("adminDangerUserText"),
        adminDeleteSelectedUserBtn: document.getElementById("adminDeleteSelectedUserBtn"),
        waveTitle: document.getElementById("waveTitle"),
        openInviteManagerBtn: document.getElementById("openInviteManagerBtn"),
        inviteManagerModal: document.getElementById("inviteManagerModal"),
        inviteBatchCount: document.getElementById("inviteBatchCount"),
        btnGenerateInvites: document.getElementById("btnGenerateInvites"),
        btnRefreshInvites: document.getElementById("btnRefreshInvites"),
        inviteList: document.getElementById("inviteList"),
    };

    const metrics = [
        { key: "voltage", title: "电压波形（V）", unit: "V", min: 0, max: 250, color: "#2f6fed", chartId: "treeVoltageChart" },
        { key: "current", title: "电流波形（A）", unit: "A", min: 0, max: 5, color: "#13b8d0", chartId: "treeCurrentChart" },
        { key: "speed", title: "转速波形（r/min）", unit: "r/min", min: 0, max: 2500, color: "#f59f00", chartId: "treeSpeedChart" },
        { key: "temperature", title: "温度波形（℃）", unit: "℃", min: 0, max: 100, color: "#ff5663", chartId: "treeTempChart" },
    ];

    const state = {
        users: [],
        selectedUser: null,
        nodes: [],
        selectedNode: null,
        selectedTurbine: null,
        nodeNameEditing: false,
        charts: {},
        chartPoints: [],
    };

    function escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, (char) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
        }[char]));
    }

    function toast(message, type = "info") {
        if (typeof window.showToast === "function") {
            window.showToast(message, type);
        } else {
            console.log(`[${type}] ${message}`);
        }
    }

    function setStatus(text) {
        if (els.pageStatus) els.pageStatus.textContent = text;
    }

    function displayNameForNode(node) {
        return node?.display_name || node?.node_id || "";
    }

    function setButtonBusy(button, busyHtml) {
        if (!button) return () => {};
        const original = button.innerHTML;
        button.innerHTML = busyHtml;
        button.disabled = true;
        return (nextHtml) => {
            button.innerHTML = nextHtml || original;
            button.disabled = false;
        };
    }

    async function copyText(text) {
        const value = String(text || "");
        if (!value) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(value);
            return;
        }
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "readonly");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
    }

    function credentialStatusText(status) {
        const map = {
            active: "启用中",
            grace: "过渡期",
            revoked: "已吊销",
        };
        return map[status] || status || "未生成";
    }

    function buildCredentialConfig(node) {
        const credential = node?.credential || null;
        const lines = [
            "auth_mode=hmac",
            `node_id=${node?.node_id || ""}`,
            `key_id=${credential?.key_id || ""}`,
            `secret=${credential?.secret || ""}`,
            "algorithm=HMAC-SHA256",
            "signature_version=v1",
            "upload_path=/api/upload",
        ];
        if (node?.node_key) {
            lines.push("", "# legacy compatibility", `legacy_node_key=${node.node_key}`);
        }
        return lines.join("\n");
    }

    function renderSelectedNodeKey(node) {
        if (!els.selectedNodeKeyPanel || !els.selectedNodeKeyText) return;
        const credential = node?.credential || null;
        const hasCredential = !!credential;
        const hasSecret = !!credential?.secret;
        if (els.selectedCredentialKeyId) {
            els.selectedCredentialKeyId.textContent = `key_id：${credential?.key_id || "--"}`;
        }
        if (els.selectedCredentialStatus) {
            const failure = credential?.last_failure_reason ? `，最近失败：${credential.last_failure_reason}` : "";
            els.selectedCredentialStatus.textContent = `状态：${credentialStatusText(credential?.status)}${failure}`;
        }
        if (mode === "admin") {
            const canRevoke = hasCredential && ["active", "grace"].includes(credential.status);
            els.selectedNodeKeyText.value = hasCredential
                ? [
                    `认证版本：hmac-v1`,
                    `算法：${credential.algorithm || "HMAC-SHA256"}`,
                    `最近成功：${credential.last_used_at || "--"}`,
                    `最近失败：${credential.last_failure_reason || "--"}`,
                    "secret：仅节点所属用户可见",
            ].join("\n")
                : "该节点还没有 HMAC 签名凭证";
            els.selectedNodeKeyPanel.classList.toggle("is-hidden", !node);
            if (els.copySelectedNodeKeyBtn) els.copySelectedNodeKeyBtn.classList.add("is-hidden");
            if (els.forceRevokeCredentialBtn) els.forceRevokeCredentialBtn.classList.toggle("is-hidden", !canRevoke);
            return;
        }

        const legacyKey = String(node?.node_key || "");
        const text = hasSecret ? buildCredentialConfig(node) : legacyKey;
        els.selectedNodeKeyText.value = text;
        els.selectedNodeKeyPanel.classList.toggle("is-hidden", !text);
        if (els.copySelectedNodeKeyBtn) els.copySelectedNodeKeyBtn.classList.remove("is-hidden");
        if (els.forceRevokeCredentialBtn) els.forceRevokeCredentialBtn.classList.add("is-hidden");
    }

    async function copySelectedNodeKey() {
        const key = els.selectedNodeKeyText?.value || "";
        if (!key) return;
        try {
            await copyText(key);
            toast("节点认证配置已复制", "success");
        } catch (error) {
            els.selectedNodeKeyText.select();
            toast("已选中认证配置，请手动复制", "warning");
        }
    }

    async function requestJson(url, options = {}) {
        const response = await fetch(url, {
            credentials: "same-origin",
            headers: {
                "Content-Type": "application/json",
                ...(options.headers || {}),
            },
            ...options,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.success === false || data.status === "error") {
            throw new Error(data.error || data.message || `请求失败：${response.status}`);
        }
        return data;
    }

    function normalizeTurbineCode(code) {
        const text = String(code ?? "").trim();
        if (!text) return "";
        if (/^\d+$/.test(text)) return text.padStart(3, "0");
        return text;
    }

    function buildTurbineCodes(node) {
        const codes = Array.isArray(node?.turbines)
            ? node.turbines.map(normalizeTurbineCode).filter(Boolean)
            : [];
        const uniqueCodes = Array.from(new Set(codes)).sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }));
        if (uniqueCodes.length > 0) return uniqueCodes;

        const count = Math.max(0, Number(node?.turbine_count || 0));
        return Array.from({ length: count }, (_, index) => String(index + 1).padStart(3, "0"));
    }

    function buildGroupLabels(codes) {
        if (!codes.length) return [];
        const labels = [];
        for (let index = 0; index < codes.length; index += 8) {
            const group = codes.slice(index, index + 8);
            labels.push(`${group[0]}-${group[group.length - 1]}`);
        }
        return labels;
    }

    function renderGroupChips(node) {
        const groups = buildGroupLabels(buildTurbineCodes(node));
        if (!groups.length) return '<div class="node-group-chip">暂无发电机</div>';
        return groups.map((label) => `<span class="node-group-chip">${escapeHtml(label)}</span>`).join("");
    }

    function renderUsers() {
        if (!els.adminUserList) return;
        if (!state.users.length) {
            els.adminUserList.innerHTML = '<div class="empty-state">暂无用户。</div>';
            renderAdminUserDanger();
            return;
        }
        const rows = state.users.map((user) => {
            const active = state.selectedUser && state.selectedUser.id === user.id ? " is-active" : "";
            const roleText = user.role === "admin" ? "管理员" : "普通用户";
            return `
                <div class="admin-user-item admin-user-row${active}">
                    <button class="admin-user-select" type="button" data-user-id="${escapeHtml(user.id)}">
                        <span class="admin-user-name">${escapeHtml(user.username)}</span>
                        <span class="admin-user-role">${escapeHtml(roleText)}</span>
                        <span class="admin-user-count">${Number(user.node_count || 0)} 个节点</span>
                        <span class="admin-user-seen">${escapeHtml(user.last_seen_at || "--")}</span>
                    </button>
                </div>
            `;
        }).join("");
        els.adminUserList.innerHTML = `
            <div class="admin-user-table">
                <div class="admin-table-head admin-user-row">
                    <span>账号</span>
                    <span>角色</span>
                    <span>节点</span>
                    <span>最近上报</span>
                </div>
                ${rows}
            </div>
        `;
        els.adminUserList.querySelectorAll("[data-user-id]").forEach((button) => {
            button.addEventListener("click", () => {
                const user = state.users.find((item) => String(item.id) === button.dataset.userId);
                if (user) selectUser(user);
            });
        });
        renderAdminUserDanger();
    }

    function renderAdminUserDanger() {
        if (mode !== "admin" || !els.adminUserDangerPanel) return;
        const user = state.selectedUser;
        const canDelete = !!user && user.role !== "admin";
        els.adminUserDangerPanel.classList.toggle("is-hidden", !canDelete);
        if (!canDelete) {
            els.adminUserDangerPanel.open = false;
        }
        if (els.adminDangerUserText) {
            els.adminDangerUserText.textContent = canDelete
                ? `${user.username} · ${Number(user.node_count || 0)} 个节点`
                : "未选择可注销的普通用户";
        }
        if (els.adminDeleteSelectedUserBtn) {
            els.adminDeleteSelectedUserBtn.disabled = !canDelete;
        }
    }

    function renderNodeList() {
        if (!els.nodeTreeList) return;
        if (mode === "admin" && !state.selectedUser) {
            els.nodeTreeList.innerHTML = '<div class="empty-state">先在本页选择一个用户。</div>';
            return;
        }
        if (!state.nodes.length) {
            els.nodeTreeList.innerHTML = '<div class="empty-state">暂无已注册节点。</div>';
            return;
        }
        const nodeRows = state.nodes.map((node) => {
            const active = state.selectedNode && state.selectedNode.node_id === node.node_id ? " is-active" : "";
            const onlineClass = node.online ? " is-online" : "";
            const statusText = node.online ? "在线" : "离线";
            const name = displayNameForNode(node);
            if (mode === "admin") {
                return `
                    <button class="device-node-item admin-node-row${active}" type="button" data-node-id="${escapeHtml(node.node_id)}">
                        <span class="admin-node-name">${escapeHtml(name)}</span>
                        <span class="admin-node-id">${escapeHtml(node.node_id)}</span>
                        <span class="admin-node-status${onlineClass}">${escapeHtml(statusText)}</span>
                        <span>${Number(node.turbine_count || 0)} 台</span>
                        <span>${escapeHtml(node.last_seen_at || node.last_upload || "--")}</span>
                    </button>
                `;
            }
            return `
                <button class="device-node-item my-node-row${active}" type="button" data-node-id="${escapeHtml(node.node_id)}">
                    <span class="node-status-dot${onlineClass}" aria-hidden="true"></span>
                    <span class="my-node-name">${escapeHtml(name)}</span>
                    <span class="my-node-id">${escapeHtml(node.node_id)}</span>
                    <span class="my-node-status${onlineClass}">${escapeHtml(statusText)}</span>
                    <span class="my-node-count">${Number(node.turbine_count || 0)} 台</span>
                    <span class="my-node-last">${escapeHtml(node.last_seen_at || node.last_upload || "--")}</span>
                </button>
            `;
        }).join("");
        if (mode === "admin") {
            els.nodeTreeList.innerHTML = `
                <div class="admin-node-table">
                    <div class="admin-table-head admin-node-row">
                        <span>节点名称</span>
                        <span>节点 ID</span>
                        <span>状态</span>
                        <span>发电机</span>
                        <span>最近上报</span>
                    </div>
                    ${nodeRows}
                </div>
            `;
        } else {
            els.nodeTreeList.innerHTML = nodeRows;
        }
        els.nodeTreeList.querySelectorAll("[data-node-id]").forEach((button) => {
            button.addEventListener("click", () => {
                const node = state.nodes.find((item) => item.node_id === button.dataset.nodeId);
                if (node) selectNode(node);
            });
        });
    }

    function renderSelectedNode() {
        const node = state.selectedNode;
        if (!node) {
            state.nodeNameEditing = false;
            if (els.selectedNodeTitle) els.selectedNodeTitle.textContent = "请选择节点";
            if (els.selectedNodeMeta) els.selectedNodeMeta.textContent = "点击节点后查看所属发电机。";
            if (els.editNodeNameBtn) els.editNodeNameBtn.classList.add("is-hidden");
            if (els.nodeNameEditForm) els.nodeNameEditForm.classList.add("is-hidden");
            if (els.rotateNodeKeyBtn) els.rotateNodeKeyBtn.classList.add("is-hidden");
            if (els.forceRevokeCredentialBtn) els.forceRevokeCredentialBtn.classList.add("is-hidden");
            renderSelectedNodeKey(null);
            renderTurbineList([]);
            paintCharts([]);
            return;
        }

        const name = displayNameForNode(node);
        const statusText = node.online ? "在线" : "离线";
        if (els.selectedNodeTitle) els.selectedNodeTitle.textContent = name;
        if (els.selectedNodeMeta) {
            els.selectedNodeMeta.textContent = `${statusText} · ID: ${node.node_id} · ${Number(node.turbine_count || 0)} 台发电机 · 最近上报 ${node.last_seen_at || node.last_upload || "--"}`;
        }
        if (els.editNodeNameBtn) {
            els.editNodeNameBtn.classList.toggle("is-hidden", state.nodeNameEditing);
        }
        if (els.nodeNameEditForm) {
            els.nodeNameEditForm.classList.toggle("is-hidden", !state.nodeNameEditing);
        }
        if (state.nodeNameEditing && els.nodeNameEditInput && document.activeElement !== els.nodeNameEditInput) {
            els.nodeNameEditInput.value = node.display_name || "";
        }
        if (els.rotateNodeKeyBtn && mode === "my") {
            els.rotateNodeKeyBtn.classList.remove("is-hidden");
        }
        renderSelectedNodeKey(node);
        renderTurbineList(buildTurbineCodes(node));
        paintCharts([]);
    }

    function renderTurbineList(codes) {
        if (els.turbineCountText) els.turbineCountText.textContent = `${codes.length} 台`;
        if (!els.turbineList) return;
        if (!codes.length) {
            els.turbineList.innerHTML = '<div class="empty-state">该节点还没有发电机上报记录。</div>';
            renderAdminTurbineActions();
            return;
        }
        const dataCodes = new Set((state.selectedNode?.turbines || []).map(normalizeTurbineCode));
        els.turbineList.innerHTML = codes.map((code) => {
            const hasData = dataCodes.has(code) || dataCodes.size === 0;
            const active = state.selectedTurbine === code ? " is-active" : "";
            const actionText = mode === "admin"
                ? (active ? "已选择" : "点击选择")
                : (hasData ? "点击进入波形" : "无数据");
            if (mode === "admin") {
                return `
                    <button class="turbine-item${active}${hasData ? " has-data" : ""}" type="button" data-turbine-code="${escapeHtml(code)}">
                        <span>发电机 ${escapeHtml(code)}</span>
                        <small>${escapeHtml(actionText)}</small>
                    </button>
                `;
            }
            return `
                <button class="turbine-item my-turbine-cell${active}${hasData ? " has-data" : ""}" type="button" data-turbine-code="${escapeHtml(code)}">
                    <strong>${escapeHtml(code)}</strong>
                    <span>${escapeHtml(actionText)}</span>
                </button>
            `;
        }).join("");
        els.turbineList.querySelectorAll("[data-turbine-code]").forEach((button) => {
            button.addEventListener("click", () => selectTurbine(button.dataset.turbineCode));
        });
        renderAdminTurbineActions();
    }

    function buildBusinessUrl(path) {
        if (!state.selectedNode || !state.selectedTurbine) return "#";
        const params = new URLSearchParams({
            select: state.selectedNode.node_id,
            turbine: state.selectedTurbine,
            view: "chart",
        });
        if (mode === "admin" && state.selectedUser?.id) {
            params.set("user_id", String(state.selectedUser.id));
        }
        return `${path}?${params.toString()}`;
    }

    function renderAdminTurbineActions() {
        if (mode !== "admin" || !els.adminTurbineActions) return;
        if (!state.selectedNode || !state.selectedTurbine) {
            els.adminTurbineActions.classList.add("is-hidden");
            return;
        }
        els.adminTurbineActions.classList.remove("is-hidden");
        if (els.selectedTurbineText) {
            const nodeName = displayNameForNode(state.selectedNode);
            els.selectedTurbineText.textContent = `${nodeName} · 发电机 ${state.selectedTurbine}`;
        }
        if (els.monitorActionLink) {
            els.monitorActionLink.href = buildBusinessUrl("/monitor");
        }
        if (els.overviewActionLink) {
            els.overviewActionLink.href = buildBusinessUrl("/overview");
        }
    }

    function selectNode(node) {
        state.selectedNode = node;
        state.selectedTurbine = null;
        state.nodeNameEditing = false;
        state.chartPoints = [];
        renderNodeList();
        renderSelectedNode();
        renderAdminTurbineActions();
    }

    async function selectTurbine(code) {
        if (!state.selectedNode) return;
        state.selectedTurbine = normalizeTurbineCode(code);
        renderTurbineList(buildTurbineCodes(state.selectedNode));
        if (mode === "admin") {
            renderAdminTurbineActions();
            return;
        }
        window.localStorage.setItem("selectedNodeId", state.selectedNode.node_id);
        window.localStorage.setItem("selectedTurbineCode", state.selectedTurbine);
        window.localStorage.setItem("windsightDrillView:monitor", "chart");
        const params = new URLSearchParams({
            select: state.selectedNode.node_id,
            turbine: state.selectedTurbine,
            view: "chart",
        });
        if (mode === "admin" && state.selectedUser?.id) {
            params.set("user_id", String(state.selectedUser.id));
        }
        window.location.href = `/monitor?${params.toString()}`;
    }

    async function selectUser(user) {
        state.selectedUser = user;
        state.selectedNode = null;
        state.selectedTurbine = null;
        state.nodeNameEditing = false;
        state.nodes = [];
        renderUsers();
        renderNodeList();
        renderSelectedNode();
        if (els.adminNodeTitle) els.adminNodeTitle.textContent = `${user.username} 的节点列表`;
        if (els.adminNodeHint) els.adminNodeHint.textContent = "这里的选择只作用于用户管理页，不联动设备工作区";
        setStatus(`当前用户：${user.username}`);
        await loadAdminUserNodes(user.id);
    }

    function openNodeNameEditor() {
        if (!state.selectedNode || !els.nodeNameEditForm || !els.nodeNameEditInput) return;
        state.nodeNameEditing = true;
        els.nodeNameEditInput.value = state.selectedNode.display_name || "";
        renderSelectedNode();
        window.setTimeout(() => {
            els.nodeNameEditInput?.focus();
            els.nodeNameEditInput?.select();
        }, 0);
    }

    function closeNodeNameEditor() {
        state.nodeNameEditing = false;
        renderSelectedNode();
    }

    function nodeNameUpdateEndpoint() {
        if (!state.selectedNode) return "";
        const nodeId = encodeURIComponent(state.selectedNode.node_id);
        if (mode === "admin") {
            if (!state.selectedUser?.id) return "";
            return `/api/admin/users/${encodeURIComponent(state.selectedUser.id)}/registered_nodes/${nodeId}`;
        }
        return `/api/my/registered_nodes/${nodeId}`;
    }

    function applyUpdatedNode(updatedNode) {
        if (!updatedNode?.node_id) return;
        state.nodes = state.nodes.map((node) => (
            node.node_id === updatedNode.node_id ? updatedNode : node
        ));
        if (state.selectedNode && state.selectedNode.node_id === updatedNode.node_id) {
            state.selectedNode = updatedNode;
        }
        state.nodeNameEditing = false;
        renderNodeList();
        renderSelectedNode();
        renderAdminTurbineActions();
        window.dispatchEvent(new CustomEvent("windsight:nodes-renamed", {
            detail: {
                mode,
                node_id: updatedNode.node_id,
                display_name: displayNameForNode(updatedNode),
            },
        }));
    }

    async function saveNodeName(event) {
        event.preventDefault();
        if (!state.selectedNode || !els.nodeNameEditInput) return;
        const endpoint = nodeNameUpdateEndpoint();
        if (!endpoint) return;
        const restore = setButtonBusy(els.saveNodeNameBtn, '<i class="bi bi-arrow-repeat"></i>保存中');
        try {
            const data = await requestJson(endpoint, {
                method: "PATCH",
                body: JSON.stringify({ display_name: els.nodeNameEditInput.value }),
            });
            applyUpdatedNode(data.node);
            restore('<i class="bi bi-check2"></i>保存');
            toast("节点显示名称已保存", "success");
        } catch (error) {
            restore('<i class="bi bi-check2"></i>保存');
            toast(error.message || "节点显示名称保存失败", "error");
        }
    }

    function showNodeKey(nodeOrKey) {
        if (!els.nodeKeyPanel || !els.nodeKeyText) return;
        if (nodeOrKey && typeof nodeOrKey === "object") {
            els.nodeKeyText.value = buildCredentialConfig(nodeOrKey);
        } else {
            els.nodeKeyText.value = nodeOrKey || "";
        }
        els.nodeKeyPanel.classList.remove("is-hidden");
    }

    async function copyNodeKey() {
        if (!els.nodeKeyText?.value) return;
        try {
            await copyText(els.nodeKeyText.value);
            toast("节点认证配置已复制", "success");
        } catch (error) {
            els.nodeKeyText.select();
            toast("已选中认证配置，请手动复制", "warning");
        }
    }

    async function registerNode(event) {
        event.preventDefault();
        const nodeId = els.nodeIdInput?.value.trim();
        if (!nodeId) {
            toast("请填写节点 ID", "warning");
            return;
        }
        try {
            const data = await requestJson("/api/my/registered_nodes", {
                method: "POST",
                body: JSON.stringify({
                    node_id: nodeId,
                    display_name: els.nodeNameInput?.value.trim() || "",
                }),
            });
            showNodeKey(data.node || data.node_key);
            if (data.node) {
                state.nodes = state.nodes.map((node) => (
                    node.node_id === data.node.node_id ? data.node : node
                ));
                state.selectedNode = data.node;
                renderNodeList();
                renderSelectedNode();
            }
            toast("节点注册成功", "success");
            els.registerForm.reset();
            await loadMyNodes(data.node?.node_id);
        } catch (error) {
            toast(error.message || "节点注册失败", "error");
        }
    }

    async function rotateNodeKey() {
        if (!state.selectedNode) return;
        const confirmed = window.confirm(`确定重置 ${state.selectedNode.node_id} 的签名凭证吗？`);
        if (!confirmed) return;
        const keepOld = window.confirm("是否保留旧 HMAC 凭证 24 小时作为过渡？\n\n确定：旧凭证 24 小时内仍可上报。\n取消：旧凭证立即失效。");
        try {
            const data = await requestJson(`/api/my/registered_nodes/${encodeURIComponent(state.selectedNode.node_id)}/rotate_key`, {
                method: "POST",
                body: JSON.stringify({ transition: keepOld ? "keep_old_24h" : "immediate" }),
            });
            showNodeKey(data.node || data.node_key);
            if (data.node) {
                state.nodes = state.nodes.map((node) => (
                    node.node_id === data.node.node_id ? data.node : node
                ));
                state.selectedNode = data.node;
                renderNodeList();
                renderSelectedNode();
            }
            toast(keepOld ? "签名凭证已重置，旧凭证保留 24 小时" : "签名凭证已重置，旧凭证已失效", "success");
        } catch (error) {
            toast(error.message || "签名凭证重置失败", "error");
        }
    }

    async function forceRevokeCredential() {
        if (mode !== "admin" || !state.selectedUser || !state.selectedNode) return;
        const confirmed = window.confirm(
            `确认强制吊销 ${state.selectedNode.node_id} 的当前签名凭证？\n\n吊销后该节点需要所属用户重新生成凭证才能继续使用 HMAC 上报。`
        );
        if (!confirmed) return;
        const restore = setButtonBusy(els.forceRevokeCredentialBtn, '<i class="bi bi-arrow-repeat"></i>吊销中...');
        try {
            const data = await requestJson(
                `/api/admin/users/${encodeURIComponent(state.selectedUser.id)}/registered_nodes/${encodeURIComponent(state.selectedNode.node_id)}/credentials/revoke`,
                {
                    method: "POST",
                    body: JSON.stringify({}),
                }
            );
            if (data.node) {
                state.nodes = state.nodes.map((node) => (
                    node.node_id === data.node.node_id ? data.node : node
                ));
                state.selectedNode = data.node;
                renderNodeList();
                renderSelectedNode();
            }
            restore('<i class="bi bi-shield-x"></i>强制吊销凭证');
            toast("签名凭证已吊销", "success");
        } catch (error) {
            restore('<i class="bi bi-shield-x"></i>强制吊销凭证');
            toast(error.message || "吊销凭证失败", "error");
        }
    }

    async function loadMyNodes(preferredNodeId = null) {
        setStatus("正在加载节点");
        try {
            const data = await requestJson("/api/my/registered_nodes");
            state.nodes = data.nodes || [];
            const nextNode = preferredNodeId
                ? state.nodes.find((node) => node.node_id === preferredNodeId)
                : state.nodes.find((node) => state.selectedNode && node.node_id === state.selectedNode.node_id);
            state.selectedNode = nextNode || state.nodes[0] || null;
            state.selectedTurbine = null;
            state.nodeNameEditing = false;
            renderNodeList();
            renderSelectedNode();
            setStatus(`${state.nodes.length} 个已注册节点`);
        } catch (error) {
            setStatus("节点加载失败");
            toast(error.message || "节点加载失败", "error");
        }
    }

    async function loadAdminUsers() {
        setStatus("正在加载用户");
        try {
            const data = await requestJson("/api/admin/users");
            state.users = data.users || [];
            renderUsers();
            setStatus(`${state.users.length} 个用户`);
            if (!state.selectedUser && state.users.length > 0) {
                const nextUser = state.users[0];
                if (nextUser) await selectUser(nextUser);
            } else if (state.selectedUser) {
                const currentUser = state.users.find((user) => user.id === state.selectedUser.id);
                if (currentUser) {
                    await selectUser(currentUser);
                } else {
                    state.selectedUser = null;
                    state.nodes = [];
                    state.selectedNode = null;
                    state.selectedTurbine = null;
                    renderUsers();
                    renderNodeList();
                    renderSelectedNode();
                }
            }
        } catch (error) {
            setStatus("用户加载失败");
            toast(error.message || "用户加载失败", "error");
        }
    }

    async function loadAdminUserNodes(userId) {
        try {
            const data = await requestJson(`/api/admin/users/${encodeURIComponent(userId)}/registered_nodes`);
            state.nodes = data.nodes || [];
            state.selectedNode = state.nodes[0] || null;
            state.selectedTurbine = null;
            state.nodeNameEditing = false;
            renderNodeList();
            renderSelectedNode();
        } catch (error) {
            toast(error.message || "用户设备树加载失败", "error");
        }
    }

    async function deleteUser(userId, button) {
        const id = String(userId || "").trim();
        if (!id) return;
        const user = state.users.find((item) => String(item.id) === id);
        if (!user) return;
        if (user.role === "admin") {
            toast("管理员账号不能在这里删除", "warning");
            return;
        }

        const nodeCount = Number(user.node_count || 0);
        const confirmed = window.confirm(
            `确认直接删除用户 ${user.username}？\n\n` +
            `该账号将无法登录，系统也会删除他注册的 ${nodeCount} 个节点关系。此操作不可撤销。`
        );
        if (!confirmed) return;

        const restore = setButtonBusy(button, '<i class="bi bi-arrow-repeat"></i> 注销中...');
        try {
            const data = await requestJson(`/api/admin/users/${encodeURIComponent(id)}`, {
                method: "DELETE",
                body: JSON.stringify({}),
            });
            toast(`用户 ${data.deleted_username || user.username} 已删除`, "success");
            if (state.selectedUser && String(state.selectedUser.id) === id) {
                state.selectedUser = null;
                state.nodes = [];
                state.selectedNode = null;
                state.selectedTurbine = null;
            }
            await loadAdminUsers();
        } catch (error) {
            restore();
            toast(error.message || "删除用户失败", "error");
        }
    }

    function openInviteManager() {
        if (mode !== "admin" || !els.inviteManagerModal) return;
        els.inviteManagerModal.hidden = false;
        els.inviteManagerModal.setAttribute("aria-hidden", "false");
        els.inviteManagerModal.classList.add("is-open");
        window.setTimeout(() => els.inviteBatchCount?.focus(), 0);
        loadInvitations();
    }

    function closeInviteManager() {
        if (!els.inviteManagerModal) return;
        els.inviteManagerModal.classList.remove("is-open");
        els.inviteManagerModal.setAttribute("aria-hidden", "true");
        els.inviteManagerModal.hidden = true;
    }

    function renderInvitationList(invitations) {
        if (!els.inviteList) return;
        const rows = Array.isArray(invitations) ? invitations : [];
        if (!rows.length) {
            els.inviteList.innerHTML = '<div class="invite-empty-state">暂无邀请码。生成后复制给需要注册的普通用户。</div>';
            return;
        }

        els.inviteList.innerHTML = `
            <div class="invite-table-wrap">
                <table class="invite-table">
                    <thead>
                        <tr>
                            <th>邀请码</th>
                            <th>状态</th>
                            <th>过期时间</th>
                            <th>使用者</th>
                            <th>创建者</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map((invite) => {
                            const status = invite.status || "unknown";
                            const canRevoke = status === "available";
                            const userText = invite.used_by_username || "--";
                            const copyButton = `<button class="invite-table-action" type="button" data-invite-copy="${escapeHtml(invite.code)}">复制</button>`;
                            const revokeButton = canRevoke
                                ? `<button class="invite-table-action is-danger" type="button" data-invite-revoke="${escapeHtml(invite.id)}">删除</button>`
                                : "";
                            return `
                                <tr>
                                    <td><code>${escapeHtml(invite.code)}</code></td>
                                    <td><span class="invite-status status-${escapeHtml(status)}">${escapeHtml(invite.status_label || status)}</span></td>
                                    <td>${escapeHtml(invite.expires_at || "--")}</td>
                                    <td>${escapeHtml(userText)}</td>
                                    <td>${escapeHtml(invite.created_by_username || "--")}</td>
                                    <td><div class="invite-row-actions">${copyButton}${revokeButton}</div></td>
                                </tr>
                            `;
                        }).join("")}
                    </tbody>
                </table>
            </div>
        `;

        els.inviteList.querySelectorAll("[data-invite-copy]").forEach((button) => {
            button.addEventListener("click", async () => {
                const original = button.textContent;
                try {
                    await copyText(button.dataset.inviteCopy || "");
                    button.textContent = "已复制";
                    toast("邀请码已复制", "success");
                    window.setTimeout(() => {
                        button.textContent = original || "复制";
                    }, 1000);
                } catch (error) {
                    toast("复制失败，请手动选择邀请码", "warning");
                }
            });
        });

        els.inviteList.querySelectorAll("[data-invite-revoke]").forEach((button) => {
            button.addEventListener("click", () => revokeInvitation(button.dataset.inviteRevoke, button));
        });
    }

    async function loadInvitations() {
        if (mode !== "admin" || !els.inviteList) return;
        els.inviteList.innerHTML = '<div class="invite-empty-state">正在加载邀请码...</div>';
        try {
            const data = await requestJson("/api/admin/invitations");
            renderInvitationList(data.invitations || []);
        } catch (error) {
            console.error("[user_tree] load invitations failed", error);
            els.inviteList.innerHTML = '<div class="invite-empty-state">邀请码加载失败。</div>';
            toast(error.message || "邀请码加载失败", "error");
        }
    }

    async function generateInvitations(button) {
        if (mode !== "admin") return;
        const count = Math.min(50, Math.max(1, parseInt(String(els.inviteBatchCount ? els.inviteBatchCount.value : "1"), 10) || 1));
        if (els.inviteBatchCount) els.inviteBatchCount.value = String(count);
        const restore = setButtonBusy(button, '<i class="bi bi-arrow-repeat"></i>生成中...');
        try {
            const data = await requestJson("/api/admin/invitations", {
                method: "POST",
                body: JSON.stringify({ count }),
            });
            const codes = (data.invitations || []).map((invite) => invite.code).filter(Boolean);
            restore('<i class="bi bi-check-circle"></i>已生成');
            if (codes.length) {
                try {
                    await copyText(codes.join("\n"));
                    toast(codes.length === 1 ? `邀请码已生成并复制：${codes[0]}` : `已生成 ${codes.length} 个邀请码，已复制到剪贴板`, "success");
                } catch (error) {
                    toast(`已生成 ${codes.length} 个邀请码，请在列表中复制`, "success");
                }
            }
            await loadInvitations();
            window.setTimeout(() => {
                if (button) {
                    button.innerHTML = '<i class="bi bi-plus-circle"></i>生成邀请码';
                    button.disabled = false;
                }
            }, 1200);
        } catch (error) {
            restore('<i class="bi bi-plus-circle"></i>生成邀请码');
            toast(error.message || "生成邀请码失败", "error");
        }
    }

    async function revokeInvitation(inviteId, button) {
        const id = String(inviteId || "").trim();
        if (!id) return;
        if (!window.confirm("确认删除该邀请码？\n\n删除后，该码将不能再用于注册，也不会继续显示在列表中。")) return;
        const restore = setButtonBusy(button, "删除中...");
        try {
            await requestJson(`/api/admin/invitations/${encodeURIComponent(id)}/revoke`, {
                method: "POST",
                body: JSON.stringify({}),
            });
            restore("已删除");
            toast("邀请码已删除", "success");
            await loadInvitations();
        } catch (error) {
            restore("删除");
            toast(error.message || "删除邀请码失败", "error");
        }
    }

    function chartPalette() {
        const light = document.body.dataset.theme === "light";
        return {
            text: light ? "#18324f" : "#edf7ff",
            muted: light ? "#61748b" : "#9ab0c7",
            grid: light ? "rgba(98, 121, 151, 0.20)" : "rgba(154, 176, 199, 0.18)",
            split: light ? "rgba(98, 121, 151, 0.16)" : "rgba(154, 176, 199, 0.14)",
            slider: light ? "rgba(47, 111, 237, 0.18)" : "rgba(19, 216, 255, 0.18)",
        };
    }

    function initCharts() {
        if (typeof echarts === "undefined") return;
        metrics.forEach((metric) => {
            const el = document.getElementById(metric.chartId);
            if (!el) return;
            state.charts[metric.key] = echarts.init(el);
        });
        paintCharts([]);
    }

    function makeChartOption(metric, points) {
        const palette = chartPalette();
        const labels = points.map((point) => point.timestamp);
        const values = points.map((point) => point[metric.key]);
        return {
            backgroundColor: "transparent",
            title: {
                text: metric.title,
                left: 14,
                top: 10,
                textStyle: { color: palette.text, fontSize: 15, fontWeight: 800 },
            },
            tooltip: {
                trigger: "axis",
                valueFormatter: (value) => `${Number(value).toFixed(metric.key === "current" ? 2 : 1)} ${metric.unit}`,
            },
            grid: { left: 54, right: 18, top: 52, bottom: 46 },
            xAxis: {
                type: "category",
                data: labels,
                axisLine: { lineStyle: { color: palette.grid } },
                axisLabel: { color: palette.muted, hideOverlap: true },
                axisTick: { show: false },
            },
            yAxis: {
                type: "value",
                min: metric.min,
                max: metric.max,
                splitLine: { lineStyle: { color: palette.split } },
                axisLabel: { color: palette.muted },
            },
            dataZoom: [
                { type: "inside", filterMode: "none" },
                {
                    type: "slider",
                    height: 18,
                    bottom: 8,
                    borderColor: "transparent",
                    backgroundColor: palette.slider,
                    dataBackground: { lineStyle: { color: metric.color }, areaStyle: { color: palette.slider } },
                    selectedDataBackground: { lineStyle: { color: metric.color }, areaStyle: { color: palette.slider } },
                    textStyle: { color: palette.muted },
                    filterMode: "none",
                },
            ],
            graphic: points.length
                ? []
                : [{
                    type: "text",
                    left: "center",
                    top: "middle",
                    style: { text: state.selectedTurbine ? "暂无该发电机数据" : "请选择发电机", fill: palette.muted, fontSize: 14 },
                }],
            series: [{
                type: "line",
                smooth: true,
                symbol: "circle",
                symbolSize: 5,
                data: values,
                lineStyle: { color: metric.color, width: 2 },
                itemStyle: { color: metric.color },
                areaStyle: { color: `${metric.color}22` },
            }],
        };
    }

    function paintCharts(points) {
        state.chartPoints = points || [];
        metrics.forEach((metric) => {
            const chart = state.charts[metric.key];
            if (!chart) return;
            chart.setOption(makeChartOption(metric, state.chartPoints), true);
        });
    }

    function sampleForCode(row, code) {
        const turbines = row?.turbines || {};
        const candidates = [code, String(Number(code)), normalizeTurbineCode(code)];
        for (const candidate of candidates) {
            if (candidate && turbines[candidate]) return turbines[candidate];
        }
        return null;
    }

    async function loadWaveData() {
        if (!state.selectedNode || !state.selectedTurbine) return;
        try {
            const data = await requestJson(`/api/data?node_id=${encodeURIComponent(state.selectedNode.node_id)}&limit=1200`);
            const rows = data.data || [];
            const points = rows.map((row) => {
                const sample = sampleForCode(row, state.selectedTurbine);
                if (!sample) return null;
                return {
                    timestamp: row.timestamp,
                    voltage: Number(sample.voltage || 0),
                    current: Number(sample.current || 0),
                    speed: Number(sample.speed || 0),
                    temperature: Number(sample.temperature || 0),
                };
            }).filter(Boolean);
            paintCharts(points);
            if (!points.length) toast("该发电机暂无可显示数据", "warning");
        } catch (error) {
            paintCharts([]);
            toast(error.message || "波形数据加载失败", "error");
        }
    }

    function bindEvents() {
        els.registerForm?.addEventListener("submit", registerNode);
        els.copyNodeKeyBtn?.addEventListener("click", copyNodeKey);
        els.copySelectedNodeKeyBtn?.addEventListener("click", copySelectedNodeKey);
        els.rotateNodeKeyBtn?.addEventListener("click", rotateNodeKey);
        els.forceRevokeCredentialBtn?.addEventListener("click", forceRevokeCredential);
        els.editNodeNameBtn?.addEventListener("click", openNodeNameEditor);
        els.nodeNameEditForm?.addEventListener("submit", saveNodeName);
        els.cancelNodeNameEditBtn?.addEventListener("click", closeNodeNameEditor);
        els.refreshNodesBtn?.addEventListener("click", () => loadMyNodes());
        els.refreshUsersBtn?.addEventListener("click", () => loadAdminUsers());
        els.adminDeleteSelectedUserBtn?.addEventListener("click", () => {
            if (state.selectedUser) deleteUser(state.selectedUser.id, els.adminDeleteSelectedUserBtn);
        });
        els.openInviteManagerBtn?.addEventListener("click", openInviteManager);
        els.btnGenerateInvites?.addEventListener("click", () => generateInvitations(els.btnGenerateInvites));
        els.btnRefreshInvites?.addEventListener("click", () => loadInvitations());
        document.querySelectorAll("[data-invite-close]").forEach((button) => {
            button.addEventListener("click", closeInviteManager);
        });
        document.addEventListener("keydown", (event) => {
            if (event.key === "Escape" && els.inviteManagerModal?.classList.contains("is-open")) {
                closeInviteManager();
            } else if (event.key === "Escape" && state.nodeNameEditing) {
                closeNodeNameEditor();
            }
        });
        window.addEventListener("resize", () => {
            Object.values(state.charts).forEach((chart) => chart.resize());
        });
        window.addEventListener("windsight:themechange", () => {
            paintCharts(state.chartPoints);
        });
    }

    function init() {
        initCharts();
        bindEvents();
        if (mode === "admin") {
            renderNodeList();
            loadAdminUsers();
        } else {
            loadMyNodes();
        }
    }

    document.addEventListener("DOMContentLoaded", init);
})();
