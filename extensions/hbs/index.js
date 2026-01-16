import { getContext, extension_settings, saveSettingsDebounced } from '../../../scripts/extensions.js';
import { eventSource, event_types } from '../../../../script.js';
import {
    loadHbsState,
    initHbsState,
    saveHbsState,
    isUserAssistant,
    ensureBucketsUpToDate,
    buildVirtualChat,
    computeTokenStats,
    resetHbsState,
    checkDirty,
} from './bucket-manager.js';

const MODULE_NAME = 'hbs';
const DEFAULT_SETTINGS = {
    enabledGlobally: true,
    defaultBase: 8,
    defaultKeepLastN: 12,
    defaultMaxSummaryWords: 120,
    injectionTemplate: '[Summary of earlier conversation:]\n{{summary}}',
    showDebugPanel: true,
};

let isProcessing = false;
let currentStats = null;

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
        saveSettingsDebounced();
    }
    return extension_settings[MODULE_NAME];
}

async function withLock(fn) {
    if (isProcessing) {
        console.debug('[HBS] Summarization already in progress, skipping');
        return null;
    }

    isProcessing = true;
    try {
        return await fn();
    } finally {
        isProcessing = false;
    }
}

async function checkServerHealth() {
    try {
        const response = await fetch('/api/plugins/hbs/health');
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('[HBS] Health check failed:', error);
        return { ok: false, configured: false, message: error.message };
    }
}

async function updateHealthStatus() {
    const health = await checkServerHealth();
    const statusEl = document.getElementById('hbs_server_status');

    if (statusEl) {
        if (health.ok && health.configured) {
            statusEl.textContent = `● Connected (${health.model || 'unknown'})`;
            statusEl.style.color = '#4caf50';
        } else if (health.ok && !health.configured) {
            statusEl.textContent = '○ Not Configured';
            statusEl.style.color = '#ff9800';
            statusEl.title = health.message || 'Server plugin not configured';
        } else {
            statusEl.textContent = '✕ Offline';
            statusEl.style.color = '#f44336';
        }
    }
}

function updateTokenStats(stats) {
    currentStats = stats;

    const elements = {
        total_messages: document.getElementById('hbs_total_messages'),
        processed_until: document.getElementById('hbs_processed_until'),
        history_end: document.getElementById('hbs_history_end'),
        live_window: document.getElementById('hbs_live_window'),
        bucket_tokens: document.getElementById('hbs_bucket_tokens'),
        remainder_tokens: document.getElementById('hbs_remainder_tokens'),
        live_tokens: document.getElementById('hbs_live_tokens'),
        total_virtual: document.getElementById('hbs_total_virtual'),
        buckets_count: document.getElementById('hbs_buckets_count'),
    };

    if (stats) {
        const liveWindowSize = stats.totalMessages - stats.historyEnd;
        if (elements.total_messages) elements.total_messages.textContent = stats.totalMessages;
        if (elements.processed_until) elements.processed_until.textContent = stats.processedUntil;
        if (elements.history_end) elements.history_end.textContent = stats.historyEnd;
        if (elements.live_window) elements.live_window.textContent = liveWindowSize;
        if (elements.bucket_tokens) elements.bucket_tokens.textContent = stats.bucketTokens.toLocaleString();
        if (elements.remainder_tokens) elements.remainder_tokens.textContent = stats.remainderTokens.toLocaleString();
        if (elements.live_tokens) elements.live_tokens.textContent = stats.liveTokens.toLocaleString();
        if (elements.total_virtual) elements.total_virtual.textContent = stats.totalVirtual.toLocaleString();
        if (elements.buckets_count) elements.buckets_count.textContent = stats.bucketsCount;
    } else {
        Object.values(elements).forEach(el => {
            if (el) el.textContent = '0';
        });
    }
}

function updateBucketsList(state) {
    const container = document.getElementById('hbs_buckets_list');
    if (!container) return;

    if (!state || !state.buckets || state.buckets.length === 0) {
        container.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">No buckets yet</p>';
        return;
    }

    const sortedBuckets = state.buckets.slice().sort((a, b) => a.start - b.start);

    let html = '';
    sortedBuckets.forEach((bucket, idx) => {
        const size = bucket.end - bucket.start;
        const timeAgo = formatTimeAgo(bucket.createdAt);

        html += `
            <div class="hbs-bucket-item" data-bucket-index="${idx}">
                <div class="hbs-bucket-header" onclick="toggleBucketExpand(${idx})">
                    <span class="hbs-bucket-expand">▶</span>
                    <span class="hbs-bucket-info">
                        L${bucket.level} [${bucket.start}-${bucket.end}) ${size} msgs |
                        ${bucket.summaryTokens} tokens | ${timeAgo}
                    </span>
                </div>
                <div class="hbs-bucket-summary" id="hbs_bucket_summary_${idx}" style="display: none;">
                    ${escapeHtml(bucket.summary)}
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function formatTimeAgo(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return 'just now';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

window.toggleBucketExpand = function (index) {
    const summaryEl = document.getElementById(`hbs_bucket_summary_${index}`);
    const expandEl = document.querySelector(`[data-bucket-index="${index}"] .hbs-bucket-expand`);

    if (summaryEl && expandEl) {
        const isExpanded = summaryEl.style.display !== 'none';
        summaryEl.style.display = isExpanded ? 'none' : 'block';
        expandEl.textContent = isExpanded ? '▶' : '▼';
    }
};

async function forceBuildBuckets() {
    const context = getContext();
    const settings = getSettings();

    if (!context.chat || context.chat.length === 0) {
        toastr.info('No chat loaded');
        return;
    }

    let state = loadHbsState(context.chatMetadata);
    if (!state) {
        state = initHbsState(context.chatMetadata, settings);
    }

    if (!state.enabled) {
        toastr.warning('HBS is disabled for this chat');
        return;
    }

    const result = await withLock(async () => {
        try {
            toastr.info('Building buckets...');

            const uaMessages = context.chat.filter(isUserAssistant);
            const chatId = context.chatId || 'unknown';

            await ensureBucketsUpToDate(state, uaMessages, chatId);

            saveHbsState(state, context.chatMetadata);
            await context.saveMetadata();

            const stats = await computeTokenStats(state, uaMessages);
            updateTokenStats(stats);
            updateBucketsList(state);

            toastr.success('Buckets built successfully');
        } catch (error) {
            console.error('[HBS] Force build error:', error);
            toastr.error(`Failed to build buckets: ${error.message}`);
            throw error;
        }
    });
}

async function resetState() {
    const context = getContext();

    if (!context.chat || context.chat.length === 0) {
        toastr.info('No chat loaded');
        return;
    }

    const state = loadHbsState(context.chatMetadata);
    if (!state) {
        toastr.info('No HBS state to reset');
        return;
    }

    if (!confirm('Reset HBS state for this chat? All buckets will be deleted.')) {
        return;
    }

    resetHbsState(state);
    saveHbsState(state, context.chatMetadata);
    await context.saveMetadata();

    updateTokenStats(null);
    updateBucketsList(state);

    toastr.success('HBS state reset');
}

async function onChatChanged() {
    const context = getContext();
    const settings = getSettings();

    if (!context.chat || context.chat.length === 0) {
        updateTokenStats(null);
        updateBucketsList(null);
        return;
    }

    let state = loadHbsState(context.chatMetadata);
    if (!state) {
        state = initHbsState(context.chatMetadata, settings);
        saveHbsState(state, context.chatMetadata);
        await context.saveMetadata();
    }

    const chatEnabledCheckbox = document.getElementById('hbs_chat_enabled');
    if (chatEnabledCheckbox) {
        chatEnabledCheckbox.checked = state.enabled;
    }

    const uaMessages = context.chat.filter(isUserAssistant);
    const stats = await computeTokenStats(state, uaMessages);
    updateTokenStats(stats);
    updateBucketsList(state);

    const isDirty = checkDirty(state, uaMessages, Math.max(0, uaMessages.length - state.keepLastN));
    const dirtyIndicator = document.getElementById('hbs_dirty_indicator');
    if (dirtyIndicator) {
        dirtyIndicator.style.display = isDirty ? 'block' : 'none';
    }
}

async function hbs_generate_interceptor(chat, contextSize, abort, type) {
    if (type === 'quiet') {
        return;
    }

    const context = getContext();
    const settings = getSettings();

    if (!settings.enabledGlobally) {
        return;
    }

    const state = loadHbsState(context.chatMetadata);
    if (!state || !state.enabled) {
        return;
    }

    const result = await withLock(async () => {
        try {
            const uaMessages = chat.filter(isUserAssistant);
            const chatId = context.chatId || 'unknown';

            console.log(`[HBS] Generate interceptor: ${uaMessages.length} UA messages, contextSize=${contextSize}`);

            await ensureBucketsUpToDate(state, uaMessages, chatId);

            saveHbsState(state, context.chatMetadata);
            context.saveMetadataDebounced();

            const virtualChat = buildVirtualChat(state, uaMessages, settings);

            console.log(`[HBS] Virtual chat: ${virtualChat.length} messages (original: ${chat.length})`);

            chat.splice(0, chat.length, ...virtualChat);

            const stats = await computeTokenStats(state, uaMessages);
            updateTokenStats(stats);
            updateBucketsList(state);

            if (stats.totalVirtual > contextSize) {
                toastr.error('HBS: Virtual prompt exceeds context. Reduce keepLastN or message size.');
                abort(true);
            }
        } catch (error) {
            console.error('[HBS] Generate interceptor error:', error);
            toastr.warning(`HBS: ${error.message}. Continuing without new summaries.`);
        }
    });
}

window.hbs_generate_interceptor = hbs_generate_interceptor;

function setupEventListeners() {
    const globalEnableCheckbox = document.getElementById('hbs_global_enabled');
    if (globalEnableCheckbox) {
        globalEnableCheckbox.addEventListener('change', (e) => {
            const settings = getSettings();
            settings.enabledGlobally = e.target.checked;
            saveSettingsDebounced();
        });
    }

    const chatEnableCheckbox = document.getElementById('hbs_chat_enabled');
    if (chatEnableCheckbox) {
        chatEnableCheckbox.addEventListener('change', async (e) => {
            const context = getContext();
            let state = loadHbsState(context.chatMetadata);

            if (!state) {
                const settings = getSettings();
                state = initHbsState(context.chatMetadata, settings);
            }

            state.enabled = e.target.checked;
            saveHbsState(state, context.chatMetadata);
            await context.saveMetadata();
        });
    }

    const keepLastNInput = document.getElementById('hbs_keep_last_n');
    if (keepLastNInput) {
        keepLastNInput.addEventListener('change', async (e) => {
            const context = getContext();
            const settings = getSettings();
            let state = loadHbsState(context.chatMetadata);

            if (!state) {
                state = initHbsState(context.chatMetadata, settings);
            }

            const value = parseInt(e.target.value, 10);
            if (!isNaN(value) && value > 0) {
                state.keepLastN = value;
                saveHbsState(state, context.chatMetadata);
                await context.saveMetadata();
            }
        });
    }

    const maxSummaryWordsInput = document.getElementById('hbs_max_summary_words');
    if (maxSummaryWordsInput) {
        maxSummaryWordsInput.addEventListener('change', async (e) => {
            const context = getContext();
            const settings = getSettings();
            let state = loadHbsState(context.chatMetadata);

            if (!state) {
                state = initHbsState(context.chatMetadata, settings);
            }

            const value = parseInt(e.target.value, 10);
            if (!isNaN(value) && value > 0) {
                state.maxSummaryWords = value;
                saveHbsState(state, context.chatMetadata);
                await context.saveMetadata();
            }
        });
    }

    const forceBuildButton = document.getElementById('hbs_force_build');
    if (forceBuildButton) {
        forceBuildButton.addEventListener('click', forceBuildBuckets);
    }

    const resetButton = document.getElementById('hbs_reset');
    if (resetButton) {
        resetButton.addEventListener('click', resetState);
    }

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
}

function loadSettingsHtml() {
    const settingsHtml = `
        <div id="hbs_settings">
            <h3>HBS - Hierarchical Bucket Summarizer</h3>

            <div class="hbs-section">
                <h4>Global Settings</h4>
                <label>
                    <input type="checkbox" id="hbs_global_enabled" />
                    Enable globally
                </label>
                <div>
                    <span id="hbs_server_status" style="font-weight: bold;">Checking...</span>
                </div>
            </div>

            <div class="hbs-section">
                <h4>Chat Settings</h4>
                <label>
                    <input type="checkbox" id="hbs_chat_enabled" />
                    Enable for this chat
                </label>
                <div id="hbs_dirty_indicator" style="display: none; color: #ff9800; margin-top: 5px;">
                    ⚠ Chat history modified. Consider resetting buckets.
                </div>
                <div style="margin-top: 10px;">
                    <label>
                        Live window (messages):
                        <input type="number" id="hbs_keep_last_n" min="1" max="100" value="12" style="width: 60px;" />
                    </label>
                </div>
                <div style="margin-top: 10px;">
                    <label>
                        Max summary words:
                        <input type="number" id="hbs_max_summary_words" min="50" max="500" value="120" style="width: 60px;" />
                    </label>
                </div>
                <div style="margin-top: 10px;">
                    <button id="hbs_force_build" class="menu_button">Force Build Buckets</button>
                    <button id="hbs_reset" class="menu_button">Reset HBS State</button>
                </div>
            </div>

            <div class="hbs-section">
                <h4>Statistics</h4>
                <div class="hbs-stats-grid">
                    <div>Total messages: <span id="hbs_total_messages">0</span></div>
                    <div>Processed until: <span id="hbs_processed_until">0</span></div>
                    <div>History end: <span id="hbs_history_end">0</span></div>
                    <div>Live window: <span id="hbs_live_window">0</span></div>
                    <div>Bucket tokens: <span id="hbs_bucket_tokens">0</span></div>
                    <div>Remainder tokens: <span id="hbs_remainder_tokens">0</span></div>
                    <div>Live tokens: <span id="hbs_live_tokens">0</span></div>
                    <div>Total virtual: <span id="hbs_total_virtual">0</span></div>
                </div>
            </div>

            <div class="hbs-section">
                <h4>Buckets (<span id="hbs_buckets_count">0</span>)</h4>
                <div id="hbs_buckets_list"></div>
            </div>
        </div>
    `;

    $('#extensions_settings2').append(settingsHtml);
}

jQuery(async () => {
    loadSettingsHtml();

    const settings = getSettings();
    const globalEnableCheckbox = document.getElementById('hbs_global_enabled');
    if (globalEnableCheckbox) {
        globalEnableCheckbox.checked = settings.enabledGlobally;
    }

    setupEventListeners();
    await updateHealthStatus();
    await onChatChanged();

    console.log('[HBS] Extension initialized');
});
