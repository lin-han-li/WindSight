/* global echarts, io */
(function () {
    'use strict';

    const root = document.getElementById('genericDashboard');
    if (!root) return;

    const pageMode = root.dataset.pageMode === 'history' ? 'history' : 'realtime';
    // 实时工作台沿用四宫格监测视图；历史页保留更宽的默认字段选择。
    const DEFAULT_FIELD_COUNT = pageMode === 'realtime' ? 4 : 6;
    const REALTIME_VISIBLE_FIELD_COUNT = 4;
    const MAX_RECORD_ROWS = 80;
    const PALETTE = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#64748b'];
    const STRUCTURAL_KEYS = new Set([
        'id', 'record_id', 'node_id', 'source_id', 'timestamp', 'time', 'created_at', 'updated_at',
        'metrics', 'payload', 'data', 'raw_data', 'values', 'meta', 'metadata', 'status'
    ]);

    const $ = (id) => document.getElementById(id);
    const elements = {
        sourceSelect: $('telemetrySourceSelect'),
        refreshSources: $('refreshTelemetrySources'),
        sourceEmpty: $('telemetrySourceEmpty'),
        sourceId: $('telemetrySourceId'),
        sourceLastSeen: $('telemetrySourceLastSeen'),
        fieldCount: $('telemetryFieldCount'),
        modeSource: $('telemetryModeSource'),
        modeLinks: Array.from(document.querySelectorAll('[data-telemetry-mode-link]')),
        monitorSource: $('telemetryMonitorSource'),
        monitorFieldContext: $('telemetryMonitorFieldContext'),
        monitorStatus: $('telemetryMonitorStatus'),
        monitorFieldCount: $('telemetryMonitorFieldCount'),
        monitorLastDataTime: $('telemetryMonitorLastDataTime'),
        fieldList: $('telemetryFieldList'),
        selectAllFields: $('selectAllTelemetryFields'),
        clearFields: $('clearTelemetryFields'),
        connection: $('telemetryConnectionStatus'),
        recordState: $('telemetryRecordState'),
        recordCount: $('telemetryRecordCount'),
        chartRecordCount: $('telemetryChartRecordCount'),
        latestTimestamp: $('telemetryLatestTimestamp'),
        metricGrid: $('telemetryMetricGrid'),
        chart: $('telemetryChart'),
        chartGrid: $('telemetryChartGrid'),
        chartEmpty: $('telemetryChartEmpty'),
        chartHint: $('telemetryChartHint'),
        jsonViewer: $('telemetryJsonViewer'),
        jsonRecordId: $('telemetryJsonRecordId'),
        jsonTimestamp: $('telemetryJsonTimestamp'),
        jsonHint: $('telemetryJsonHint'),
        copyJson: $('copyTelemetryJson'),
        recordList: $('telemetryRecordList'),
        reload: $('reloadTelemetryData'),
        realtimeLimit: $('telemetryRealtimeLimit'),
        historyStart: $('telemetryHistoryStart'),
        historyEnd: $('telemetryHistoryEnd'),
        historyLimit: $('telemetryHistoryLimit'),
        clearRange: $('clearTelemetryRange')
    };

    const state = {
        sources: [],
        source: null,
        sourceId: '',
        fields: [],
        selectedFields: new Set(),
        records: [],
        selectedRecord: null,
        followLatest: true,
        socket: null,
        subscription: '',
        chart: null,
        realtimeCharts: new Map(),
        realtimeChartSignature: '',
        sourceToken: 0,
        recordToken: 0,
        initialized: false,
        loadingRecords: false
    };

    function normalizeId(value) {
        return String(value == null ? '' : value).trim();
    }

    function isPlainObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    function asArray(value) {
        if (Array.isArray(value)) return value;
        if (!isPlainObject(value)) return [];
        return Object.entries(value).map(([key, item]) => {
            if (isPlainObject(item)) return Object.assign({ node_id: item.node_id || key }, item);
            return { node_id: key, value: item };
        });
    }

    function responseArray(payload, keys) {
        if (Array.isArray(payload)) return payload;
        const candidates = [payload, payload && payload.data, payload && payload.result];
        for (const candidate of candidates) {
            if (Array.isArray(candidate)) return candidate;
            if (!isPlainObject(candidate)) continue;
            for (const key of keys) {
                if (Array.isArray(candidate[key])) return candidate[key];
            }
        }
        for (const candidate of candidates) {
            if (!isPlainObject(candidate)) continue;
            for (const key of keys) {
                const nested = candidate[key];
                if (!isPlainObject(nested)) continue;
                for (const nestedKey of keys) {
                    if (Array.isArray(nested[nestedKey])) return nested[nestedKey];
                }
                return asArray(nested);
            }
        }
        return [];
    }

    function extractError(payload, fallback) {
        if (typeof payload === 'string') return payload;
        if (isPlainObject(payload)) return payload.message || payload.error || payload.detail || payload.reason || fallback;
        return fallback;
    }

    async function requestJson(url) {
        const response = await fetch(url, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        });
        const text = await response.text();
        let payload = null;
        try {
            payload = text ? JSON.parse(text) : {};
        } catch (error) {
            throw new Error(response.ok ? '服务返回了无法识别的数据。' : `请求失败（${response.status}）`);
        }
        if (!response.ok || (isPlainObject(payload) && payload.success === false)) {
            throw new Error(extractError(payload, `请求失败（${response.status}）`));
        }
        return payload;
    }

    function notify(message, type) {
        if (typeof window.showToast === 'function') window.showToast(message, type || 'info');
        else console.warn('[万物数驱]', message);
    }

    function readInitialSourceId() {
        const params = new URLSearchParams(window.location.search);
        const queried = params.get('node_id') || params.get('source_id') || params.get('select');
        if (queried) return normalizeId(queried);
        try {
            return normalizeId(localStorage.getItem('genericTelemetrySourceId') || localStorage.getItem('selectedNodeId'));
        } catch (error) {
            return '';
        }
    }

    function persistSourceId(sourceId) {
        try { localStorage.setItem('genericTelemetrySourceId', sourceId); } catch (error) { /* storage is optional */ }
        const url = new URL(window.location.href);
        if (sourceId) {
            url.searchParams.set('node_id', sourceId);
            url.searchParams.delete('select');
            url.searchParams.delete('turbine');
            url.searchParams.delete('generator');
        } else {
            url.searchParams.delete('node_id');
        }
        window.history.replaceState({}, '', url);
    }

    function buildModeUrl(mode, sourceId) {
        const path = mode === 'history' ? '/overview' : '/monitor';
        const params = new URLSearchParams();
        if (sourceId) params.set('node_id', sourceId);
        return params.toString() ? (path + '?' + params.toString()) : path;
    }

    function renderModeNavigation() {
        const label = state.source
            ? (state.source.__label || state.source.__id || state.sourceId)
            : (state.sourceId || '尚未选择');
        setText(elements.modeSource, label);
        elements.modeLinks.forEach((link) => {
            const mode = link.dataset.telemetryModeLink;
            link.href = buildModeUrl(mode, state.sourceId);
            const current = mode === pageMode;
            link.classList.toggle('is-active', current);
            if (current) link.setAttribute('aria-current', 'page');
            else link.removeAttribute('aria-current');
        });
    }

    function sourceIdentifier(source) {
        if (typeof source === 'string' || typeof source === 'number') return normalizeId(source);
        if (!isPlainObject(source)) return '';
        return normalizeId(source.node_id || source.source_id || source.id || source.value || source.key);
    }

    function sourceLabel(source) {
        if (!isPlainObject(source)) return sourceIdentifier(source);
        return normalizeId(source.name || source.display_name || source.title || source.node_name || source.label) || sourceIdentifier(source);
    }

    function sourceLastSeen(source) {
        if (!isPlainObject(source)) return '';
        return source.last_seen || source.last_upload || source.latest_timestamp || source.timestamp || source.updated_at || '';
    }

    function normalizeSources(payload) {
        const rows = responseArray(payload, ['sources', 'items', 'nodes', 'data_sources']);
        const seen = new Set();
        return rows.map((item) => {
            const source = isPlainObject(item) ? item : { node_id: item };
            const id = sourceIdentifier(source);
            return Object.assign({}, source, { __id: id, __label: sourceLabel(source) });
        }).filter((source) => {
            if (!source.__id || seen.has(source.__id)) return false;
            seen.add(source.__id);
            return true;
        });
    }

    function fieldKey(item) {
        if (typeof item === 'string' || typeof item === 'number') return normalizeId(item);
        if (!isPlainObject(item)) return '';
        return normalizeId(item.key || item.field || item.name || item.path || item.id || item.value);
    }

    function looksNumericField(item) {
        if (!isPlainObject(item)) return true;
        if (item.numeric === false || item.is_numeric === false) return false;
        const fieldType = String(item.type || item.data_type || item.kind || '').toLowerCase();
        if (!fieldType) return true;
        return /(number|numeric|float|double|decimal|int|long|short|integer|real)/.test(fieldType);
    }

    function normalizeFields(payload) {
        const rows = responseArray(payload, ['fields', 'metrics', 'items', 'data']);
        const seen = new Set();
        return rows.map((item) => {
            const key = fieldKey(item);
            const source = isPlainObject(item) ? item : {};
            return {
                key,
                label: normalizeId(source.label || source.display_name || source.title) || key,
                unit: normalizeId(source.unit || source.symbol),
                numeric: looksNumericField(source)
            };
        }).filter((field) => {
            if (!field.key || !field.numeric || seen.has(field.key)) return false;
            seen.add(field.key);
            return true;
        });
    }

    function safeParseJson(value) {
        if (typeof value !== 'string') return value;
        try { return JSON.parse(value); } catch (error) { return value; }
    }

    function extractPayload(raw) {
        const data = isPlainObject(raw && raw.data) ? raw.data : {};
        const value = raw && (raw.payload !== undefined ? raw.payload : raw.raw_data !== undefined ? raw.raw_data : data.payload !== undefined ? data.payload : data.raw_data);
        return value === undefined ? null : safeParseJson(value);
    }

    function extractMetrics(raw, payload) {
        const data = isPlainObject(raw && raw.data) ? raw.data : {};
        const candidates = [raw && raw.metrics, data.metrics, raw && raw.values, data.values, isPlainObject(payload) && payload.metrics, isPlainObject(payload) && payload.values];
        for (const candidate of candidates) {
            if (isPlainObject(candidate)) return candidate;
        }
        const fallback = isPlainObject(raw) ? raw : (isPlainObject(payload) ? payload : {});
        const metrics = {};
        Object.entries(fallback).forEach(([key, value]) => {
            if (!STRUCTURAL_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value)) metrics[key] = value;
        });
        if (Object.keys(metrics).length) return metrics;
        if (isPlainObject(payload)) {
            Object.entries(payload).forEach(([key, value]) => {
                if (!STRUCTURAL_KEYS.has(key) && typeof value === 'number' && Number.isFinite(value)) metrics[key] = value;
            });
        }
        return metrics;
    }

    function extractTimestamp(raw, payload) {
        const data = isPlainObject(raw && raw.data) ? raw.data : {};
        const payloadObject = isPlainObject(payload) ? payload : {};
        return raw && (raw.timestamp || raw.time || raw.created_at || raw.received_at) || data.timestamp || data.time || data.created_at || payloadObject.timestamp || payloadObject.time || payloadObject.created_at || null;
    }

    function normalizeRecord(raw) {
        const base = isPlainObject(raw) ? raw : { payload: raw };
        const payload = extractPayload(base);
        const metrics = extractMetrics(base, payload);
        const data = isPlainObject(base.data) ? base.data : {};
        const id = normalizeId(base.record_id || base.id || data.record_id || data.id || '');
        const timestamp = extractTimestamp(base, payload);
        const nodeId = normalizeId(base.node_id || base.source_id || data.node_id || data.source_id || (isPlainObject(payload) && (payload.node_id || payload.source_id)) || '');
        let json = payload;
        if (json === null || json === undefined) json = Object.keys(base).length ? Object.assign({}, base) : { metrics };
        return { id, timestamp, nodeId, metrics: isPlainObject(metrics) ? metrics : {}, payload: json, raw: base };
    }

    function recordIdentity(record) {
        if (record.id) return `id:${record.id}`;
        return `at:${String(record.timestamp || '')}|${JSON.stringify(record.metrics || {})}`;
    }

    function timestampMs(value) {
        if (value === null || value === undefined || value === '') return NaN;
        if (typeof value === 'number') return value < 100000000000 ? value * 1000 : value;
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : NaN;
    }

    function sortRecords(records) {
        return records.slice().sort((a, b) => {
            const aTime = timestampMs(a.timestamp);
            const bTime = timestampMs(b.timestamp);
            if (Number.isNaN(aTime) && Number.isNaN(bTime)) return 0;
            if (Number.isNaN(aTime)) return -1;
            if (Number.isNaN(bTime)) return 1;
            return aTime - bTime;
        });
    }

    function recordsFromResponse(payload) {
        return sortRecords(responseArray(payload, ['records', 'data', 'items', 'history', 'rows']).map(normalizeRecord));
    }

    function discoverFields(records) {
        const discovered = [];
        const seen = new Set(state.fields.map((field) => field.key));
        records.forEach((record) => {
            Object.entries(record.metrics || {}).forEach(([key, value]) => {
                if (!seen.has(key) && typeof value === 'number' && Number.isFinite(value)) {
                    seen.add(key);
                    discovered.push({ key, label: key, unit: '', numeric: true });
                }
            });
        });
        return discovered;
    }

    function getMetric(record, key) {
        if (!record || !record.metrics) return null;
        if (Object.prototype.hasOwnProperty.call(record.metrics, key)) return record.metrics[key];
        return key.split('.').reduce((value, part) => isPlainObject(value) ? value[part] : undefined, record.metrics);
    }

    function numericValue(record, key) {
        const value = getMetric(record, key);
        const number = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
        return Number.isFinite(number) ? number : null;
    }

    function latestRecord() {
        return state.records.length ? state.records[state.records.length - 1] : null;
    }

    function selectedFieldList() {
        return state.fields.filter((field) => state.selectedFields.has(field.key));
    }

    function displayedFieldList() {
        const selected = selectedFieldList();
        return pageMode === 'realtime'
            ? selected.slice(0, REALTIME_VISIBLE_FIELD_COUNT)
            : selected;
    }

    function selectionStorageKey() {
        return state.sourceId ? `genericTelemetryFields:${state.sourceId}` : '';
    }

    function persistFields() {
        const key = selectionStorageKey();
        if (!key) return;
        try { localStorage.setItem(key, JSON.stringify(Array.from(state.selectedFields))); } catch (error) { /* storage is optional */ }
    }

    function restoreFields() {
        const available = new Set(state.fields.map((field) => field.key));
        let stored = [];
        try { stored = JSON.parse(localStorage.getItem(selectionStorageKey()) || '[]'); } catch (error) { stored = []; }
        const restored = stored.filter((key) => available.has(key));
        state.selectedFields = new Set(restored.length ? restored : state.fields.slice(0, DEFAULT_FIELD_COUNT).map((field) => field.key));
        persistFields();
    }

    function setConnection(text, kind) {
        if (!elements.connection) return;
        const dot = elements.connection.querySelector('.generic-status-dot');
        const label = elements.connection.querySelector('span:last-child');
        if (dot) dot.className = `generic-status-dot ${kind === 'live' ? 'is-live' : kind === 'error' ? 'is-error' : 'is-pending'}`;
        if (label) label.textContent = text;
    }

    function setRecordState(text) {
        if (elements.recordState) elements.recordState.textContent = text;
    }

    function setText(element, value) {
        if (element) element.textContent = value || '--';
    }

    function formatDate(value, withSeconds) {
        const milliseconds = timestampMs(value);
        if (Number.isNaN(milliseconds)) return value ? String(value) : '--';
        const options = { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
        if (withSeconds !== false) options.second = '2-digit';
        return new Intl.DateTimeFormat('zh-CN', options).format(new Date(milliseconds));
    }

    function formatNumber(value) {
        if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--';
        return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 }).format(Number(value));
    }

    function toLocalDateTimeInput(date) {
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function localInputToIso(value) {
        if (!value) return '';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toISOString();
    }

    function renderSources() {
        const select = elements.sourceSelect;
        if (!select) return;
        select.replaceChildren();
        const noSources = state.sources.length === 0;
        if (noSources) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = '暂无可用数据源';
            select.appendChild(option);
            select.disabled = true;
        } else {
            state.sources.forEach((source) => {
                const option = document.createElement('option');
                option.value = source.__id;
                option.textContent = source.__label === source.__id ? source.__id : `${source.__label} · ${source.__id}`;
                select.appendChild(option);
            });
            select.disabled = false;
            select.value = state.sourceId || state.sources[0].__id;
        }
        if (elements.sourceEmpty) elements.sourceEmpty.hidden = !noSources;
    }

    function renderSourceDetails() {
        const newest = latestRecord();
        setText(elements.sourceId, state.source ? state.source.__label || state.source.__id : '未选择');
        setText(elements.sourceLastSeen, newest ? formatDate(newest.timestamp) : formatDate(sourceLastSeen(state.source)));
        setText(elements.fieldCount, String(state.fields.length));
        renderModeNavigation();
        renderMonitorContext();
    }

    function renderMonitorContext() {
        if (pageMode !== 'realtime') return;
        const selected = selectedFieldList();
        const displayed = displayedFieldList();
        const latest = latestRecord();
        const sourceLabel = state.source
            ? (state.source.__label || state.source.__id || state.sourceId)
            : (state.sourceId || '未选择数据源');
        const fieldLabel = !selected.length
            ? '请选择数值字段'
            : selected.length > REALTIME_VISIBLE_FIELD_COUNT
                ? '显示前 ' + displayed.length + ' 项 / 已选 ' + selected.length + ' 项'
                : '已选 ' + displayed.length + ' 项';
        setText(elements.monitorSource, sourceLabel);
        setText(elements.monitorFieldContext, fieldLabel);
        setText(
            elements.monitorStatus,
            !state.sourceId
                ? '等待接入'
                : latest
                    ? '数据流在线'
                    : '等待数据'
        );
        setText(elements.monitorFieldCount, '已选 ' + selected.length + ' 项');
        setText(elements.monitorLastDataTime, latest ? formatDate(latest.timestamp) : '--');
    }

    function renderFields() {
        const holder = elements.fieldList;
        if (!holder) return;
        holder.replaceChildren();
        if (!state.sourceId) {
            holder.innerHTML = '<div class="generic-fields-placeholder"><i class="bi bi-sliders"></i> 选择数据源后加载可视字段</div>';
            return;
        }
        if (!state.fields.length) {
            holder.innerHTML = '<div class="generic-fields-placeholder"><i class="bi bi-info-circle"></i> 该数据源尚未识别到数值字段</div>';
            return;
        }
        state.fields.forEach((field) => {
            const button = document.createElement('button');
            const selected = state.selectedFields.has(field.key);
            button.type = 'button';
            button.className = `generic-field-chip${selected ? ' is-selected' : ''}`;
            button.dataset.fieldKey = field.key;
            button.setAttribute('role', 'checkbox');
            button.setAttribute('aria-checked', selected ? 'true' : 'false');
            button.title = field.key;
            const indicator = document.createElement('span');
            indicator.className = 'generic-field-indicator';
            indicator.setAttribute('aria-hidden', 'true');
            const label = document.createElement('span');
            label.className = 'generic-field-key';
            label.textContent = field.label;
            button.append(indicator, label);
            if (field.unit) {
                const unit = document.createElement('small');
                unit.textContent = field.unit;
                button.append(unit);
            }
            button.addEventListener('click', () => {
                if (state.selectedFields.has(field.key)) state.selectedFields.delete(field.key);
                else state.selectedFields.add(field.key);
                persistFields();
                renderFields();
                renderData();
                scheduleReload();
            });
            holder.appendChild(button);
        });
    }

    function renderMetricGrid() {
        const holder = elements.metricGrid;
        if (!holder) return;
        holder.replaceChildren();
        const selected = displayedFieldList();
        const record = latestRecord();
        if (!selected.length) {
            holder.innerHTML = '<div class="generic-metrics-placeholder">请至少选择一个数值字段。</div>';
            return;
        }
        if (!record) {
            holder.innerHTML = '<div class="generic-metrics-placeholder">暂无数据，接收到数据后会显示最新值。</div>';
            return;
        }
        selected.forEach((field, index) => {
            const card = document.createElement('article');
            card.className = 'generic-metric-card card dashboard-card metric-summary-card';
            card.style.setProperty('--metric-color', PALETTE[index % PALETTE.length]);
            const name = document.createElement('div');
            name.className = 'generic-metric-name metric-meta';
            const dot = document.createElement('span');
            dot.className = 'generic-metric-dot metric-dot';
            dot.setAttribute('aria-hidden', 'true');
            const label = document.createElement('span');
            label.textContent = field.label;
            name.append(dot, label);
            const value = document.createElement('div');
            value.className = 'generic-metric-value metric-value';
            value.textContent = formatNumber(numericValue(record, field.key));
            const meta = document.createElement('div');
            meta.className = 'generic-metric-meta metric-hint';
            const sourceLabel = state.source ? (state.source.__label || state.source.__id) : state.sourceId;
            meta.textContent = field.unit
                ? String(sourceLabel || '当前数据源') + ' · ' + field.unit
                : String(sourceLabel || '当前数据源') + ' · ' + field.key;
            card.append(name, value, meta);
            holder.appendChild(card);
        });
    }

    function chartTheme() {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark' || document.body.getAttribute('data-theme') === 'dark';
        return {
            dark,
            text: dark ? '#dbe7f5' : '#334155',
            muted: dark ? '#98a8bd' : '#64748b',
            split: dark ? 'rgba(148,163,184,.18)' : 'rgba(148,163,184,.23)',
            tooltip: dark ? '#162033' : '#ffffff'
        };
    }

    function ensureChart() {
        if (!elements.chart || !window.echarts) return null;
        if (!state.chart) state.chart = window.echarts.init(elements.chart, null, { renderer: 'canvas' });
        return state.chart;
    }

    function showChartEmpty(visible, title, detail) {
        if (!elements.chartEmpty) return;
        elements.chartEmpty.classList.toggle('is-visible', Boolean(visible));
        if (title) {
            const strong = elements.chartEmpty.querySelector('strong');
            if (strong) strong.textContent = title;
        }
        if (detail) {
            const span = elements.chartEmpty.querySelector('span');
            if (span) span.textContent = detail;
        }
    }

    function disposeRealtimeCharts() {
        state.realtimeCharts.forEach((entry) => {
            if (entry.chart) {
                try {
                    entry.chart.dispose();
                } catch (error) {
                    // The DOM node may already have been removed during a resize.
                }
            }
        });
        state.realtimeCharts.clear();
        state.realtimeChartSignature = '';
    }

    function setRealtimeChartEmpty(title, detail) {
        const grid = elements.chartGrid;
        if (!grid) return;
        disposeRealtimeCharts();
        grid.replaceChildren();
        const empty = elements.chartEmpty;
        if (!empty) return;
        empty.classList.add('is-visible');
        const strong = empty.querySelector('strong');
        const span = empty.querySelector('span');
        if (strong) strong.textContent = title;
        if (span) span.textContent = detail;
        grid.appendChild(empty);
    }

    function createRealtimeChartCard(field, index) {
        const card = document.createElement('article');
        card.className = 'generic-monitor-chart-card card dashboard-card detail-chart-card';
        card.style.setProperty('--chart-color', PALETTE[index % PALETTE.length]);

        const head = document.createElement('header');
        head.className = 'generic-monitor-chart-card-head chart-card-head';
        const dot = document.createElement('span');
        dot.className = 'generic-monitor-chart-dot chart-badge';
        dot.setAttribute('aria-hidden', 'true');
        const label = document.createElement('span');
        label.className = 'generic-monitor-chart-label';
        label.textContent = field.label + ' 波形' + (field.unit ? '（' + field.unit + '）' : '');
        label.title = field.key;
        head.append(dot, label);

        const canvasWrap = document.createElement('div');
        canvasWrap.className = 'generic-monitor-chart-canvas-wrap';
        const canvas = document.createElement('div');
        canvas.className = 'generic-monitor-chart-canvas chart-canvas';
        canvas.setAttribute('role', 'img');
        canvas.setAttribute('aria-label', field.label + ' 实时曲线');
        const empty = document.createElement('div');
        empty.className = 'generic-monitor-chart-card-empty';
        empty.textContent = '等待该字段的数值数据';
        canvasWrap.append(canvas, empty);
        card.append(head, canvasWrap);

        let chart = null;
        if (window.echarts) {
            chart = window.echarts.init(canvas, null, { renderer: 'canvas' });
        } else {
            empty.textContent = '图表组件未加载';
            empty.classList.add('is-visible');
        }
        return { card, chart, empty };
    }

    function renderRealtimeChartGrid() {
        const grid = elements.chartGrid;
        if (!grid) return;
        const selected = selectedFieldList();
        const displayed = displayedFieldList();
        if (elements.chartRecordCount) elements.chartRecordCount.textContent = String(state.records.length) + ' 条';
        if (elements.chartHint) {
            if (!state.sourceId) {
                elements.chartHint.textContent = '选择数据源后开始查看。';
            } else if (!selected.length) {
                elements.chartHint.textContent = '请选择至少一个数值字段。';
            } else if (!state.records.length) {
                elements.chartHint.textContent = '暂无数据，等待新的上报。';
            } else if (selected.length > REALTIME_VISIBLE_FIELD_COUNT) {
                elements.chartHint.textContent = '已选择 ' + selected.length + ' 个字段，实时面板显示前 ' + REALTIME_VISIBLE_FIELD_COUNT + ' 项。';
            } else {
                elements.chartHint.textContent = '实时展示 ' + displayed.length + ' 个字段的独立曲线。';
            }
        }
        if (!displayed.length) {
            setRealtimeChartEmpty('请选择数值字段', '实时页最多并列展示四项；可在上方自由切换字段。');
            return;
        }
        if (!state.records.length) {
            setRealtimeChartEmpty('暂无可绘制数据', '数据到达后会在这里形成独立的实时曲线。');
            return;
        }

        const signature = displayed.map((field) => field.key).join('\u001f');
        if (signature !== state.realtimeChartSignature) {
            disposeRealtimeCharts();
            grid.replaceChildren();
            displayed.forEach((field, index) => {
                const entry = createRealtimeChartCard(field, index);
                state.realtimeCharts.set(field.key, entry);
                grid.appendChild(entry.card);
            });
            state.realtimeChartSignature = signature;
        }
        if (elements.chartEmpty) elements.chartEmpty.classList.remove('is-visible');

        const theme = chartTheme();
        const newest = latestRecord();
        displayed.forEach((field, index) => {
            const entry = state.realtimeCharts.get(field.key);
            if (!entry) return;
            const points = state.records.map((record) => {
                const time = timestampMs(record.timestamp);
                return [Number.isNaN(time) ? record.timestamp : time, numericValue(record, field.key)];
            });
            const hasValue = points.some((point) => point[1] !== null);
            entry.empty.classList.toggle('is-visible', !hasValue);
            if (!entry.chart || !hasValue) {
                if (entry.chart) entry.chart.clear();
                return;
            }
            entry.chart.setOption({
                animation: state.records.length < 1000,
                color: [PALETTE[index % PALETTE.length]],
                backgroundColor: 'transparent',
                grid: { top: 18, right: 17, bottom: 31, left: 53 },
                tooltip: {
                    trigger: 'axis',
                    backgroundColor: theme.tooltip,
                    borderColor: theme.split,
                    textStyle: { color: theme.text },
                    valueFormatter: (chartValue) => formatNumber(chartValue) + (field.unit ? ' ' + field.unit : '')
                },
                xAxis: {
                    type: 'time',
                    axisLine: { lineStyle: { color: theme.split } },
                    axisLabel: { color: theme.muted, fontSize: 10, hideOverlap: true },
                    splitLine: { show: false }
                },
                yAxis: {
                    type: 'value',
                    scale: true,
                    axisLine: { show: false },
                    axisLabel: { color: theme.muted, fontSize: 10 },
                    splitLine: { lineStyle: { color: theme.split, type: 'dashed' } }
                },
                series: [{
                    name: field.label,
                    type: 'line',
                    data: points,
                    showSymbol: false,
                    smooth: false,
                    connectNulls: false,
                    lineStyle: { width: 2 },
                    areaStyle: { color: PALETTE[index % PALETTE.length], opacity: .08 },
                    emphasis: { focus: 'series' }
                }]
            }, { notMerge: true, lazyUpdate: true });
            entry.chart.resize();
        });
    }

    function renderChart() {
        if (pageMode === 'realtime' && elements.chartGrid) {
            renderRealtimeChartGrid();
            return;
        }
        const chart = ensureChart();
        const selected = selectedFieldList();
        const usable = selected.filter((field) => state.records.some((record) => numericValue(record, field.key) !== null));
        if (elements.chartRecordCount) elements.chartRecordCount.textContent = `${state.records.length} 条`;
        if (elements.chartHint) {
            elements.chartHint.textContent = !state.sourceId
                ? '选择数据源后开始查看。'
                : !selected.length
                    ? '请选择至少一个数值字段。'
                    : !state.records.length
                        ? '暂无数据，等待新的上报或调整查询条件。'
                        : `展示 ${usable.length || 0} 个字段的时间趋势。`;
        }
        if (!chart) {
            showChartEmpty(true, '图表组件未加载', '仍可通过下方记录和 JSON 查看数据。');
            return;
        }
        if (!selected.length || !state.records.length || !usable.length) {
            chart.clear();
            showChartEmpty(
                true,
                !selected.length ? '请选择数值字段' : '暂无可绘制数据',
                !selected.length ? '选择字段后会在这里形成趋势曲线。' : '当前条件下没有数值记录。'
            );
            return;
        }
        showChartEmpty(false);
        const theme = chartTheme();
        const series = usable.map((field) => ({
            name: field.label,
            type: 'line',
            smooth: false,
            showSymbol: false,
            connectNulls: false,
            symbol: 'circle',
            lineStyle: { width: 2 },
            emphasis: { focus: 'series' },
            data: state.records.map((record) => {
                const value = numericValue(record, field.key);
                const time = timestampMs(record.timestamp);
                return [Number.isNaN(time) ? record.timestamp : time, value];
            })
        }));
        chart.setOption({
            animation: state.records.length < 1000,
            color: usable.map((field, index) => PALETTE[index % PALETTE.length]),
            backgroundColor: 'transparent',
            grid: { top: 46, right: 20, bottom: 32, left: 58, containLabel: false },
            tooltip: {
                trigger: 'axis',
                backgroundColor: theme.tooltip,
                borderColor: theme.split,
                textStyle: { color: theme.text },
                valueFormatter: (value) => formatNumber(value)
            },
            legend: { type: 'scroll', top: 6, left: 12, right: 12, textStyle: { color: theme.muted, fontSize: 11 } },
            xAxis: {
                type: 'time',
                axisLine: { lineStyle: { color: theme.split } },
                axisLabel: { color: theme.muted, fontSize: 10, hideOverlap: true },
                splitLine: { show: false }
            },
            yAxis: {
                type: 'value',
                scale: true,
                axisLine: { show: false },
                axisLabel: { color: theme.muted, fontSize: 10 },
                splitLine: { lineStyle: { color: theme.split, type: 'dashed' } }
            },
            series
        }, { notMerge: true, lazyUpdate: true });
        chart.resize();
    }

    function jsonForRecord(record) {
        if (!record) return pageMode === 'history' ? { message: '等待查询' } : { message: '等待数据' };
        return record.payload !== null && record.payload !== undefined ? record.payload : record.raw;
    }

    function stringifyJson(value) {
        if (typeof value === 'string') {
            const parsed = safeParseJson(value);
            return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
        }
        try { return JSON.stringify(value, null, 2); } catch (error) { return String(value); }
    }

    function renderJson() {
        const record = state.selectedRecord || latestRecord();
        if (elements.jsonViewer) elements.jsonViewer.textContent = stringifyJson(jsonForRecord(record));
        setText(elements.jsonRecordId, record && record.id ? `记录 ${record.id}` : '记录 --');
        setText(elements.jsonTimestamp, record ? formatDate(record.timestamp) : '--');
        if (elements.jsonHint) {
            elements.jsonHint.textContent = record
                ? '当前显示所选数据帧的完整原始 JSON。'
                : (pageMode === 'history' ? '显示所选记录的原始数据。' : '显示最新一帧的原始数据。');
        }
    }

    function renderRecords() {
        const holder = elements.recordList;
        if (!holder) return;
        holder.replaceChildren();
        if (!state.records.length) {
            const placeholder = document.createElement('div');
            placeholder.className = 'generic-records-placeholder';
            placeholder.textContent = state.sourceId
                ? (pageMode === 'history' ? '当前条件没有历史记录' : '等待数据到达')
                : '请先选择数据源';
            holder.appendChild(placeholder);
            return;
        }
        const fields = selectedFieldList().slice(0, 3);
        state.records.slice(-MAX_RECORD_ROWS).reverse().forEach((record) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = `generic-record-row${state.selectedRecord && recordIdentity(state.selectedRecord) === recordIdentity(record) ? ' is-active' : ''}`;
            const time = document.createElement('span');
            time.className = 'generic-record-time';
            time.textContent = formatDate(record.timestamp);
            const values = document.createElement('span');
            values.className = 'generic-record-values';
            if (fields.length) {
                fields.forEach((field) => {
                    const token = document.createElement('span');
                    token.className = 'generic-record-value';
                    const label = document.createElement('span');
                    label.textContent = field.label;
                    const value = document.createElement('b');
                    value.textContent = formatNumber(numericValue(record, field.key));
                    token.append(label, value);
                    values.appendChild(token);
                });
            } else {
                values.textContent = '未选择数值字段';
            }
            const id = document.createElement('span');
            id.className = 'generic-record-id';
            id.textContent = record.id ? `#${record.id}` : '查看 JSON';
            row.append(time, values, id);
            row.addEventListener('click', () => {
                state.selectedRecord = record;
                state.followLatest = false;
                renderRecords();
                renderJson();
            });
            holder.appendChild(row);
        });
    }

    function renderData() {
        const latest = latestRecord();
        const count = state.records.length;
        if (elements.recordCount) elements.recordCount.textContent = `缓存 ${count} 条`;
        if (elements.latestTimestamp) elements.latestTimestamp.textContent = latest ? formatDate(latest.timestamp) : '--';
        if (!state.loadingRecords) {
            if (pageMode === 'history') setRecordState(count ? `查询到 ${count} 条记录` : '暂无查询结果');
            else setRecordState(latest ? '正在接收数据' : '等待数据');
        }
        renderSourceDetails();
        renderMetricGrid();
        renderChart();
        renderJson();
        renderRecords();
    }

    function queryLimit() {
        const input = pageMode === 'history' ? elements.historyLimit : elements.realtimeLimit;
        const fallback = pageMode === 'history' ? 1000 : 300;
        const value = Number(input && input.value);
        const maximum = pageMode === 'history' ? 20000 : 5000;
        return Math.max(1, Math.min(maximum, Number.isFinite(value) ? Math.floor(value) : fallback));
    }

    function buildHistoryUrl() {
        const params = new URLSearchParams({ node_id: state.sourceId, limit: String(queryLimit()) });
        const fields = Array.from(state.selectedFields);
        // Field paths returned by the API already escape commas with a
        // backslash. Preserve that spelling verbatim before URL encoding.
        if (fields.length) params.set('fields', fields.join(','));
        if (pageMode === 'history') {
            const start = localInputToIso(elements.historyStart && elements.historyStart.value);
            const end = localInputToIso(elements.historyEnd && elements.historyEnd.value);
            if (start) params.set('start', start);
            if (end) params.set('end', end);
        }
        return `/api/telemetry/history?${params.toString()}`;
    }

    function setFieldsFromRecords(records) {
        const additions = discoverFields(records);
        if (!additions.length) return false;
        const wasEmpty = state.fields.length === 0;
        state.fields = state.fields.concat(additions);
        if (wasEmpty || state.selectedFields.size === 0) {
            additions.slice(0, Math.max(0, DEFAULT_FIELD_COUNT - state.selectedFields.size)).forEach((field) => state.selectedFields.add(field.key));
            persistFields();
        }
        renderFields();
        return true;
    }

    async function loadRecords(options) {
        const opts = Object.assign({ silent: false }, options || {});
        if (!state.sourceId) {
            state.records = [];
            state.selectedRecord = null;
            renderData();
            return;
        }
        const token = ++state.recordToken;
        state.loadingRecords = true;
        if (!opts.silent) setRecordState(pageMode === 'history' ? '正在查询…' : '正在刷新…');
        try {
            const payload = await requestJson(buildHistoryUrl());
            if (token !== state.recordToken) return;
            state.records = recordsFromResponse(payload);
            if (state.selectedRecord && !state.records.some((record) => recordIdentity(record) === recordIdentity(state.selectedRecord))) {
                state.followLatest = true;
            }
            if (state.followLatest || !state.selectedRecord) state.selectedRecord = latestRecord();
            setFieldsFromRecords(state.records);
        } catch (error) {
            if (token !== state.recordToken) return;
            if (!opts.silent) notify(`读取数据失败：${error.message}`, 'error');
            setRecordState('读取失败');
        } finally {
            if (token === state.recordToken) {
                state.loadingRecords = false;
                renderData();
            }
        }
    }

    let reloadTimer = null;
    function scheduleReload() {
        if (!state.sourceId) return;
        if (reloadTimer) window.clearTimeout(reloadTimer);
        reloadTimer = window.setTimeout(
            () => loadRecords({ silent: pageMode === 'realtime' }),
            pageMode === 'history' ? 250 : 80
        );
    }

    function resetSourceData() {
        state.fields = [];
        state.selectedFields = new Set();
        state.records = [];
        state.selectedRecord = null;
        state.followLatest = true;
        renderFields();
        renderData();
    }

    async function loadFields() {
        if (!state.sourceId) return;
        const sourceId = state.sourceId;
        if (elements.fieldList) {
            elements.fieldList.innerHTML = '<div class="generic-fields-placeholder"><i class="bi bi-arrow-repeat"></i> 正在识别数值字段…</div>';
        }
        try {
            const params = new URLSearchParams({ node_id: sourceId });
            const payload = await requestJson(`/api/telemetry/fields?${params.toString()}`);
            if (sourceId !== state.sourceId) return;
            state.fields = normalizeFields(payload);
            restoreFields();
            renderFields();
            renderSourceDetails();
        } catch (error) {
            if (sourceId !== state.sourceId) return;
            state.fields = [];
            state.selectedFields = new Set();
            renderFields();
            renderSourceDetails();
            notify(`读取字段失败：${error.message}`, 'error');
        }
    }

    function unsubscribe() {
        if (state.socket && state.socket.connected && state.subscription) {
            state.socket.emit('unsubscribe_node', { node_id: state.subscription });
        }
        state.subscription = '';
    }

    function subscribe() {
        if (!state.socket || !state.socket.connected || !state.sourceId) return;
        if (state.subscription && state.subscription !== state.sourceId) unsubscribe();
        state.socket.emit('subscribe_node', { node_id: state.sourceId });
        state.subscription = state.sourceId;
    }

    async function chooseSource(sourceId, options) {
        const opts = Object.assign({ persist: true, force: false }, options || {});
        sourceId = normalizeId(sourceId);
        if (!sourceId) {
            unsubscribe();
            state.sourceId = '';
            state.source = null;
            resetSourceData();
            renderSources();
            renderSourceDetails();
            return;
        }
        if (!opts.force && sourceId === state.sourceId && state.initialized) return;
        unsubscribe();
        state.sourceId = sourceId;
        state.source = state.sources.find((source) => source.__id === sourceId) || { __id: sourceId, __label: sourceId };
        state.initialized = true;
        if (opts.persist) persistSourceId(sourceId);
        renderSources();
        resetSourceData();
        renderSourceDetails();
        subscribe();
        await loadFields();
        await loadRecords();
    }

    async function loadSources(options) {
        const opts = Object.assign({ silent: false }, options || {});
        const token = ++state.sourceToken;
        if (elements.sourceSelect && !opts.silent) {
            elements.sourceSelect.disabled = true;
            elements.sourceSelect.innerHTML = '<option value="">正在加载数据源…</option>';
        }
        try {
            const payload = await requestJson('/api/telemetry/sources');
            if (token !== state.sourceToken) return;
            state.sources = normalizeSources(payload);
            const preferred = state.sourceId || readInitialSourceId();
            const exists = state.sources.some((source) => source.__id === preferred);
            const next = exists ? preferred : (state.sources[0] && state.sources[0].__id) || '';
            if (!next) {
                unsubscribe();
                state.sourceId = '';
                state.source = null;
                resetSourceData();
                renderSources();
                renderSourceDetails();
                return;
            }
            if (next !== state.sourceId || !state.initialized) {
                await chooseSource(next, { persist: false, force: true });
            } else {
                state.source = state.sources.find((source) => source.__id === next) || state.source;
                renderSources();
                renderSourceDetails();
            }
        } catch (error) {
            if (token !== state.sourceToken) return;
            state.sources = [];
            renderSources();
            resetSourceData();
            renderSourceDetails();
            if (!opts.silent) notify(`读取数据源失败：${error.message}`, 'error');
        }
    }

    function appendRealtimeRecord(raw) {
        const record = normalizeRecord(raw);
        if (!record.nodeId) record.nodeId = state.sourceId;
        if (normalizeId(record.nodeId) !== normalizeId(state.sourceId)) return;
        const identity = recordIdentity(record);
        const index = state.records.findIndex((item) => recordIdentity(item) === identity);
        if (index >= 0) state.records.splice(index, 1, record);
        else state.records.push(record);
        state.records = sortRecords(state.records).slice(-queryLimit());
        setFieldsFromRecords([record]);
        if (state.followLatest || !state.selectedRecord) state.selectedRecord = latestRecord();
        renderData();
    }

    function connectSocket() {
        if (typeof window.io !== 'function') {
            setConnection('实时通道未加载，使用手动刷新', 'error');
            return;
        }
        try {
            const socket = window.io({ transports: ['websocket', 'polling'] });
            state.socket = socket;
            socket.on('connect', () => {
                setConnection('实时通道已连接', 'live');
                subscribe();
            });
            socket.on('disconnect', () => setConnection('实时通道已断开，正在重连', 'pending'));
            socket.on('connect_error', () => setConnection('实时通道连接失败，可手动刷新', 'error'));
            socket.on('telemetry_update', (packet) => {
                const data = isPlainObject(packet) && packet.data !== undefined ? packet.data : packet;
                const packetNode = normalizeId(
                    (packet && (packet.node_id || packet.source_id))
                    || (isPlainObject(data) && (data.node_id || data.source_id))
                    || ''
                );
                if (!state.sourceId || (packetNode && packetNode !== normalizeId(state.sourceId))) return;
                if (pageMode === 'realtime') {
                    appendRealtimeRecord(data);
                } else {
                    const record = normalizeRecord(data);
                    if (normalizeId(record.nodeId) === normalizeId(state.sourceId)) {
                        state.source = Object.assign({}, state.source || {}, { last_seen: record.timestamp });
                        renderSourceDetails();
                        setConnection('实时通道已连接 · 有新数据到达', 'live');
                    }
                }
            });
        } catch (error) {
            setConnection('实时通道不可用，可手动刷新', 'error');
        }
    }

    function bindEvents() {
        if (elements.sourceSelect) elements.sourceSelect.addEventListener('change', (event) => chooseSource(event.target.value));
        if (elements.refreshSources) elements.refreshSources.addEventListener('click', () => loadSources());
        if (elements.selectAllFields) elements.selectAllFields.addEventListener('click', () => {
            state.selectedFields = new Set(state.fields.map((field) => field.key));
            persistFields();
            renderFields();
            renderData();
            scheduleReload();
        });
        if (elements.clearFields) elements.clearFields.addEventListener('click', () => {
            state.selectedFields.clear();
            persistFields();
            renderFields();
            renderData();
            scheduleReload();
        });
        if (elements.reload) elements.reload.addEventListener('click', () => loadRecords());
        if (elements.realtimeLimit) elements.realtimeLimit.addEventListener('change', () => loadRecords());
        if (elements.historyLimit) elements.historyLimit.addEventListener('change', () => loadRecords());
        [elements.historyStart, elements.historyEnd].filter(Boolean).forEach((input) => {
            input.addEventListener('change', () => {
                if (pageMode === 'history') loadRecords({ silent: true });
            });
        });
        root.querySelectorAll('[data-telemetry-range]').forEach((button) => {
            button.addEventListener('click', () => {
                const minutes = Number(button.dataset.telemetryRange);
                const end = new Date();
                const start = new Date(end.getTime() - minutes * 60 * 1000);
                if (elements.historyStart) elements.historyStart.value = toLocalDateTimeInput(start);
                if (elements.historyEnd) elements.historyEnd.value = toLocalDateTimeInput(end);
                loadRecords();
            });
        });
        if (elements.clearRange) elements.clearRange.addEventListener('click', () => {
            if (elements.historyStart) elements.historyStart.value = '';
            if (elements.historyEnd) elements.historyEnd.value = '';
            loadRecords();
        });
        if (elements.copyJson) elements.copyJson.addEventListener('click', async () => {
            const text = elements.jsonViewer ? elements.jsonViewer.textContent : '';
            try {
                await navigator.clipboard.writeText(text);
                notify('原始 JSON 已复制', 'success');
            } catch (error) {
                notify('复制失败，请在 JSON 查看器中手动复制。', 'warning');
            }
        });
        window.addEventListener('resize', () => {
            if (state.chart) state.chart.resize();
            state.realtimeCharts.forEach((entry) => {
                if (entry.chart) entry.chart.resize();
            });
        });
        window.addEventListener('windsight:themechange', () => renderChart());
        window.addEventListener('beforeunload', () => {
            unsubscribe();
            disposeRealtimeCharts();
        });
    }

    function init() {
        bindEvents();
        setConnection('正在连接实时通道', 'pending');
        connectSocket();
        loadSources();
        if (pageMode === 'realtime') {
            window.setInterval(() => loadRecords({ silent: true }), 30000);
        }
    }

    init();
}());
