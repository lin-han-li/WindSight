(function () {
    const root = document.querySelector('.settings-console[data-scope="user"]');
    if (!root) return;

    const els = {
        pollInterval: document.getElementById("userPollInterval"),
        pollVal: document.getElementById("userPollVal"),
        autoRefresh: document.getElementById("userAutoRefresh"),
        showDebugLog: document.getElementById("userShowDebugLog"),
        logRetention: document.getElementById("userLogRetention"),
        btnSave: document.getElementById("btnSaveUserSettings"),
        btnCleanupOld: document.getElementById("btnCleanupMyOld"),
        btnClearAll: document.getElementById("btnClearMyAll"),
        btnClearNode: document.getElementById("btnClearMyNodeData"),
        btnDeleteNode: document.getElementById("btnDeleteMyNode"),
        dataNodeSelect: document.getElementById("myDataNodeSelect"),
        deleteNodeSelect: document.getElementById("myDeleteNodeSelect"),
        totalNodes: document.getElementById("myTotalNodes"),
        activeNodes: document.getElementById("myActiveNodes"),
        uploads: document.getElementById("myUploads"),
        measurements: document.getElementById("myMeasurements"),
        latestUpload: document.getElementById("myLatestUpload"),
    };

    function toast(message, type = "info") {
        if (typeof window.showToast === "function") {
            window.showToast(message, type);
        } else {
            console.log(`[${type}] ${message}`);
        }
    }

    async function fetchJson(url, options = {}) {
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

    function setText(element, value, fallback = "--") {
        if (!element) return;
        element.textContent = value === undefined || value === null || value === "" ? fallback : String(value);
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

    function updatePollLabel() {
        if (els.pollVal && els.pollInterval) {
            els.pollVal.textContent = `${els.pollInterval.value}ms`;
        }
    }

    function currentConfigPayload() {
        return {
            poll_interval: Number(els.pollInterval?.value || 3000),
            auto_refresh: !!els.autoRefresh?.checked,
            show_debug_log: !!els.showDebugLog?.checked,
            log_retention: Number(els.logRetention?.value || 30),
        };
    }

    function fillSelect(select, nodes, placeholder) {
        if (!select) return;
        if (!nodes.length) {
            select.innerHTML = `<option value="">暂无节点</option>`;
            select.disabled = true;
            return;
        }
        select.disabled = false;
        select.innerHTML = [
            `<option value="">${placeholder}</option>`,
            ...nodes.map((node) => {
                const name = node.display_name || node.node_id;
                return `<option value="${escapeHtml(node.node_id)}">${escapeHtml(name)} (${escapeHtml(node.node_id)})</option>`;
            }),
        ].join("");
    }

    function escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, (char) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;",
        }[char]));
    }

    async function loadConfig() {
        const result = await fetchJson("/api/my/config");
        const data = result.data || {};
        if (els.pollInterval) els.pollInterval.value = String(data.poll_interval ?? 3000);
        if (els.autoRefresh) els.autoRefresh.checked = data.auto_refresh !== false;
        if (els.showDebugLog) els.showDebugLog.checked = !!data.show_debug_log;
        if (els.logRetention) els.logRetention.value = String(data.log_retention ?? 30);
        updatePollLabel();
    }

    async function saveConfig(button) {
        const restore = setButtonBusy(button, '<i class="bi bi-arrow-repeat settings-spin-icon me-2"></i>保存中');
        try {
            await fetchJson("/api/my/config", {
                method: "POST",
                body: JSON.stringify(currentConfigPayload()),
            });
            toast("个人设置已保存", "success");
        } catch (error) {
            toast(error.message || "个人设置保存失败", "error");
        } finally {
            restore();
        }
    }

    async function loadSystemInfo() {
        try {
            const result = await fetchJson("/api/my/system_info");
            const data = result.data || {};
            setText(els.totalNodes, data.total_nodes);
            setText(els.activeNodes, data.active_nodes);
            setText(els.uploads, data.node_uploads);
            setText(els.measurements, data.turbine_measurements);
            setText(els.latestUpload, data.latest_upload);
        } catch (error) {
            console.warn("[user-settings] load system info failed", error);
        }
    }

    async function loadNodes() {
        try {
            const result = await fetchJson("/api/my/registered_nodes");
            const nodes = result.nodes || [];
            fillSelect(els.dataNodeSelect, nodes, "选择要清理数据的节点");
            fillSelect(els.deleteNodeSelect, nodes, "选择要删除的节点");
        } catch (error) {
            fillSelect(els.dataNodeSelect, [], "暂无节点");
            fillSelect(els.deleteNodeSelect, [], "暂无节点");
            toast(error.message || "节点列表加载失败", "error");
        }
    }

    async function cleanupOld(button) {
        const retention = Number(els.logRetention?.value || 30);
        if (retention === -1) {
            toast("当前设置为永久保存，无需清理过期数据", "info");
            return;
        }
        if (!window.confirm(`确认删除自己名下节点 ${retention} 天前的历史数据？`)) return;
        const restore = setButtonBusy(button, '<i class="bi bi-arrow-repeat settings-spin-icon me-1"></i>清理中');
        try {
            const result = await fetchJson("/api/my/cleanup_old_data", {
                method: "POST",
                body: JSON.stringify({ retention_days: retention }),
            });
            const details = result.details || {};
            toast(`清理完成：上传帧 ${details.node_uploads_deleted || 0} 条，风机明细 ${details.turbine_measurements_deleted || 0} 条`, "success");
            await loadSystemInfo();
        } catch (error) {
            toast(error.message || "清理过期数据失败", "error");
        } finally {
            restore();
        }
    }

    async function clearData(button, nodeId = "") {
        const message = nodeId
            ? `确认清空节点 ${nodeId} 的全部历史数据？`
            : "确认清空自己名下所有节点的历史数据？";
        if (!window.confirm(message)) return;
        const restore = setButtonBusy(button, '<i class="bi bi-arrow-repeat settings-spin-icon me-1"></i>清理中');
        try {
            const result = await fetchJson("/api/my/clear_data", {
                method: "POST",
                body: JSON.stringify(nodeId ? { node_id: nodeId } : {}),
            });
            const details = result.details || {};
            toast(`清理完成：上传帧 ${details.node_uploads_deleted || 0} 条，风机明细 ${details.turbine_measurements_deleted || 0} 条`, "success");
            await loadSystemInfo();
        } catch (error) {
            toast(error.message || "清理数据失败", "error");
        } finally {
            restore();
        }
    }

    async function deleteNode(button) {
        const nodeId = els.deleteNodeSelect?.value || "";
        if (!nodeId) {
            toast("请选择要删除的节点", "warning");
            return;
        }
        if (!window.confirm(`确认删除节点 ${nodeId}？\n\n该节点密钥会失效，历史上传数据也会一起删除。`)) return;
        const restore = setButtonBusy(button, '<i class="bi bi-arrow-repeat settings-spin-icon me-1"></i>删除中');
        try {
            const result = await fetchJson(`/api/my/registered_nodes/${encodeURIComponent(nodeId)}`, {
                method: "DELETE",
            });
            const details = result.details || {};
            toast(`节点 ${result.deleted_node_id || nodeId} 已删除，清理上传帧 ${details.node_uploads_deleted || 0} 条`, "success");
            await Promise.all([loadNodes(), loadSystemInfo()]);
        } catch (error) {
            toast(error.message || "删除节点失败", "error");
        } finally {
            restore();
        }
    }

    function bindEvents() {
        els.pollInterval?.addEventListener("input", updatePollLabel);
        els.btnSave?.addEventListener("click", () => saveConfig(els.btnSave));
        els.btnCleanupOld?.addEventListener("click", () => cleanupOld(els.btnCleanupOld));
        els.btnClearAll?.addEventListener("click", () => clearData(els.btnClearAll));
        els.btnClearNode?.addEventListener("click", () => {
            const nodeId = els.dataNodeSelect?.value || "";
            if (!nodeId) {
                toast("请选择要清理数据的节点", "warning");
                return;
            }
            clearData(els.btnClearNode, nodeId);
        });
        els.btnDeleteNode?.addEventListener("click", () => deleteNode(els.btnDeleteNode));
    }

    async function init() {
        bindEvents();
        updatePollLabel();
        await Promise.all([loadConfig(), loadNodes(), loadSystemInfo()]);
    }

    document.addEventListener("DOMContentLoaded", () => {
        init().catch((error) => {
            console.error("[user-settings] init failed", error);
            toast("个人设置加载失败", "error");
        });
    });
})();
