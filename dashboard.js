import { getContext, extension_settings } from '../../../../scripts/extensions.js';
import {
    loadHbsState,
    saveHbsState,
    isUserAssistant,
    ensureBucketsUpToDate,
    computeTokenStats,
    resetHbsState,
    checkDirty,
    rebuildBuckets,
    formatMessagesForLeaf,
} from './bucket-manager.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

const MODULE_NAME = 'hbs';

function getSettings() {
    return extension_settings[MODULE_NAME];
}

function debugLog(...args) {
    if (getSettings().debugOutput) {
        console.log('[HBS-Dashboard]', ...args);
    }
}

export function openHbsDashboard() {
    const context = getContext();
    const settings = getSettings();
    const state = loadHbsState(context.chatMetadata);

    // Create overlay
    const overlay = document.createElement('div');
    overlay.className = 'hbs-dashboard-overlay';
    overlay.innerHTML = `
        <div class="hbs-dashboard-container">
            <div class="hbs-dashboard-header">
                <h2>HBS Dashboard</h2>
                <div class="hbs-header-controls">
                    <label class="hbs-toggle">
                        <input type="checkbox" id="hbs_dash_global_enabled">
                        <span class="hbs-slider"></span>
                        <span class="hbs-label">Global Enable</span>
                    </label>
                    <button id="hbs_dash_close" class="menu_button fa-solid fa-times"></button>
                </div>
            </div>
            
            <div class="hbs-dashboard-content">
                <!-- Top Section: Visualization -->
                <div class="hbs-section hbs-viz-section">
                    <div class="hbs-section-header">
                        <h3><i class="fa-solid fa-chart-bar"></i> Timeline Visualization</h3>
                        <div class="hbs-legend">
                            <span class="legend-item"><span class="dot bucket"></span> Bucket</span>
                            <span class="legend-item"><span class="dot remainder"></span> Unprocessed</span>
                            <span class="legend-item"><span class="dot live"></span> Live Window</span>
                        </div>
                    </div>
                    <div class="hbs-viz-container">
                        <canvas id="hbs_timeline_canvas" height="80"></canvas>
                        <div id="hbs_viz_tooltip" class="hbs-tooltip" style="display: none;"></div>
                    </div>
                </div>

                <!-- Middle Section: Stats & Quick Actions -->
                <div class="hbs-grid-row">
                    <!-- Stats Card -->
                    <div class="hbs-card hbs-stats-card">
                        <h3><i class="fa-solid fa-chart-pie"></i> Statistics</h3>
                        <div class="hbs-stats-grid">
                            <div class="stat-item">
                                <span class="stat-label">Total Messages</span>
                                <span class="stat-value" id="hbs_dash_total_msgs">-</span>
                            </div>
                            <div class="stat-item">
                                <span class="stat-label">Processed</span>
                                <span class="stat-value" id="hbs_dash_processed">-</span>
                            </div>
                            <div class="stat-item">
                                <span class="stat-label">Live Window</span>
                                <span class="stat-value" id="hbs_dash_live_window">-</span>
                            </div>
                            <div class="stat-item">
                                <span class="stat-label">Bucket Tokens</span>
                                <span class="stat-value" id="hbs_dash_bucket_tokens">-</span>
                            </div>
                            <div class="stat-item">
                                <span class="stat-label">Total Virtual Tokens</span>
                                <span class="stat-value" id="hbs_dash_virtual_tokens">-</span>
                            </div>
                             <div class="stat-item">
                                <span class="stat-label">Buckets Count</span>
                                <span class="stat-value" id="hbs_dash_buckets_count">-</span>
                            </div>
                        </div>
                    </div>

                    <!-- Actions Card -->
                    <div class="hbs-card hbs-actions-card">
                        <h3><i class="fa-solid fa-bolt"></i> Actions</h3>
                        <div class="hbs-actions-list">
                            <button id="hbs_dash_force_build" class="menu_button">
                                <i class="fa-solid fa-hammer"></i> Force Build Buckets
                            </button>
                            <button id="hbs_dash_rebuild" class="menu_button warning">
                                <i class="fa-solid fa-rotate-right"></i> Rebuild All
                            </button>
                            <button id="hbs_dash_reset" class="menu_button danger">
                                <i class="fa-solid fa-trash"></i> Reset State
                            </button>
                        </div>
                        <div id="hbs_dash_dirty_alert" class="hbs-alert warning" style="display: none;">
                            <i class="fa-solid fa-triangle-exclamation"></i> History modified. Buckets may be outdated.
                        </div>
                    </div>
                </div>

                <!-- Bottom Section: Settings & Inspector -->
                <div class="hbs-grid-row">
                    <!-- Settings Accordion -->
                    <div class="hbs-card hbs-settings-card">
                        <h3><i class="fa-solid fa-sliders"></i> Configuration</h3>
                        
                        <div class="hbs-accordion">
                            <div class="hbs-accordion-item">
                                <div class="hbs-accordion-header">
                                    <span>Profile & General</span>
                                    <i class="fa-solid fa-chevron-down"></i>
                                </div>
                                <div class="hbs-accordion-content">
                                    <div class="setting-row">
                                        <label>Summarization Profile</label>
                                        <select id="hbs_dash_profile" class="text_pole"></select>
                                    </div>
                                    <div class="setting-row">
                                        <label>
                                            <input type="checkbox" id="hbs_dash_debug"> Debug Output
                                        </label>
                                    </div>
                                </div>
                            </div>

                            <div class="hbs-accordion-item">
                                <div class="hbs-accordion-header">
                                    <span>Chat Parameters</span>
                                    <i class="fa-solid fa-chevron-down"></i>
                                </div>
                                <div class="hbs-accordion-content">
                                    <div class="setting-row">
                                        <label>
                                            <input type="checkbox" id="hbs_dash_chat_enabled"> Enable for this chat
                                        </label>
                                    </div>
                                    <div class="setting-row">
                                        <label>Live Window Size (msgs)</label>
                                        <input type="number" id="hbs_dash_keep_n" class="text_pole" min="1" max="200">
                                    </div>
                                    <div class="setting-row">
                                        <label>Max Summary Words</label>
                                        <input type="number" id="hbs_dash_max_words" class="text_pole" min="10" max="1000">
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Bucket Inspector -->
                    <div class="hbs-card hbs-inspector-card">
                        <h3><i class="fa-solid fa-list-check"></i> Bucket Inspector</h3>
                        <div id="hbs_dash_bucket_list" class="hbs-bucket-list">
                            <!-- Populated dynamically -->
                            <div class="placeholder">Select a chat to see buckets.</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // Initialize UI Logic
    initDashboardLogic(overlay, context, settings, state);
}

function initDashboardLogic(overlay, context, settings, state) {
    // --- Close Handlers ---
    const closeBtn = overlay.querySelector('#hbs_dash_close');
    const close = () => {
        overlay.remove();
        eventSource.off(event_types.CHAT_CHANGED, onChatChange);
    };
    closeBtn.addEventListener('click', close);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close();
    });

    // --- Inputs & Settings ---
    const globalEnabled = overlay.querySelector('#hbs_dash_global_enabled');
    globalEnabled.checked = settings.enabledGlobally;
    globalEnabled.addEventListener('change', (e) => {
        settings.enabledGlobally = e.target.checked;
        saveSettingsDebounced();
    });

    const debugCheck = overlay.querySelector('#hbs_dash_debug');
    debugCheck.checked = settings.debugOutput;
    debugCheck.addEventListener('change', (e) => {
        settings.debugOutput = e.target.checked;
        saveSettingsDebounced();
    });

    const chatEnabled = overlay.querySelector('#hbs_dash_chat_enabled');
    const keepN = overlay.querySelector('#hbs_dash_keep_n');
    const maxWords = overlay.querySelector('#hbs_dash_max_words');

    if (state) {
        chatEnabled.checked = state.enabled;
        keepN.value = state.keepLastN;
        maxWords.value = state.maxSummaryWords;
    } else {
        // Defaults if no chat loaded/state
        chatEnabled.disabled = true;
        keepN.value = settings.defaultKeepLastN;
        maxWords.value = settings.defaultMaxSummaryWords;
    }

    const saveChatSettings = async () => {
        if (!state) return;
        state.enabled = chatEnabled.checked;
        state.keepLastN = parseInt(keepN.value) || 12;
        state.maxSummaryWords = parseInt(maxWords.value) || 120;
        saveHbsState(state, context.chatMetadata);
        await context.saveMetadata();
        refreshAll();
    };

    chatEnabled.addEventListener('change', saveChatSettings);
    keepN.addEventListener('change', saveChatSettings);
    maxWords.addEventListener('change', saveChatSettings);

    // --- Profile Dropdown ---
    const profileSelect = overlay.querySelector('#hbs_dash_profile');
    try {
        context.ConnectionManagerRequestService.handleDropdown(
            profileSelect,
            settings.selectedProfileId,
            async (profile) => {
                if (profile) {
                    settings.selectedProfileId = profile.id;
                } else {
                    settings.selectedProfileId = null;
                }
                saveSettingsDebounced();
            }
        );
    } catch (e) {
        console.error('Failed to init profile dropdown', e);
    }

    // --- Accordion Logic ---
    overlay.querySelectorAll('.hbs-accordion-header').forEach(header => {
        header.addEventListener('click', () => {
            const item = header.parentElement;
            item.classList.toggle('active');
        });
    });

    // --- Actions ---
    const btnForce = overlay.querySelector('#hbs_dash_force_build');
    const btnRebuild = overlay.querySelector('#hbs_dash_rebuild');
    const btnReset = overlay.querySelector('#hbs_dash_reset');

    const withLoading = async (fn) => {
        try {
            document.body.style.cursor = 'wait';
            await fn();
        } catch (e) {
            toastr.error(e.message);
        } finally {
            document.body.style.cursor = 'default';
        }
    };

    btnForce.addEventListener('click', () => withLoading(async () => {
        if (!state) return;
        const uaMessages = context.chat.filter(isUserAssistant);
        const chatId = context.chatId || 'unknown';
        await ensureBucketsUpToDate(state, uaMessages, chatId);
        saveHbsState(state, context.chatMetadata);
        await context.saveMetadata();
        await refreshAll();
        toastr.success('Buckets built.');
    }));

    btnRebuild.addEventListener('click', () => withLoading(async () => {
        if (!state || !confirm('Rebuild entire history?')) return;
        const uaMessages = context.chat.filter(isUserAssistant);
        const chatId = context.chatId || 'unknown';
        await rebuildBuckets(state, uaMessages, chatId);
        saveHbsState(state, context.chatMetadata);
        await context.saveMetadata();
        await refreshAll();
        toastr.success('Rebuild complete.');
    }));

    btnReset.addEventListener('click', () => withLoading(async () => {
        if (!state || !confirm('Reset state?')) return;
        resetHbsState(state);
        saveHbsState(state, context.chatMetadata);
        await context.saveMetadata();
        await refreshAll();
        toastr.success('State reset.');
    }));


    // --- Visualization & Stats ---
    const refreshAll = async () => {
        if (!context.chat || context.chat.length === 0) {
             updateStats(overlay, { totalMessages: 0, processedUntil: 0, historyEnd: 0, bucketTokens: 0, remainderTokens: 0, liveTokens: 0, totalVirtual: 0, bucketsCount: 0 }, false);
            updateBucketList(overlay, { buckets: [] });
            drawTimeline(overlay, { buckets: [], keepLastN: 12 }, []);
            return;
        }
        
        // Reload state to be safe
        const freshState = loadHbsState(context.chatMetadata);
        if(!freshState) return;
        
        // Update inputs to match new state
        if (freshState) {
            state = freshState;
            chatEnabled.checked = state.enabled;
            keepN.value = state.keepLastN;
            maxWords.value = state.maxSummaryWords;
        }

        const uaMessages = context.chat.filter(isUserAssistant);
        const stats = await computeTokenStats(freshState, uaMessages);
        const isDirty = checkDirty(freshState, uaMessages, Math.max(0, uaMessages.length - freshState.keepLastN));

        updateStats(overlay, stats, isDirty);
        updateBucketList(overlay, freshState);
        drawTimeline(overlay, freshState, uaMessages);
    };

    const onChatChange = () => {
        refreshAll();
    };
    eventSource.on(event_types.CHAT_CHANGED, onChatChange);

    // Initial load
    refreshAll();
}

function updateStats(overlay, stats, isDirty) {
    overlay.querySelector('#hbs_dash_total_msgs').textContent = stats.totalMessages;
    overlay.querySelector('#hbs_dash_processed').textContent = stats.processedUntil;
    overlay.querySelector('#hbs_dash_live_window').textContent = stats.totalMessages - stats.historyEnd;
    overlay.querySelector('#hbs_dash_bucket_tokens').textContent = stats.bucketTokens;
    overlay.querySelector('#hbs_dash_virtual_tokens').textContent = stats.totalVirtual;
    overlay.querySelector('#hbs_dash_buckets_count').textContent = stats.bucketsCount;

    const dirtyAlert = overlay.querySelector('#hbs_dash_dirty_alert');
    dirtyAlert.style.display = isDirty ? 'block' : 'none';
}

function updateBucketList(overlay, state) {
    const list = overlay.querySelector('#hbs_dash_bucket_list');
    list.innerHTML = '';

    if (!state.buckets || state.buckets.length === 0) {
        list.innerHTML = '<div class="placeholder">No buckets generated yet.</div>';
        return;
    }

    state.buckets.slice().sort((a,b) => a.start - b.start).forEach((b, idx) => {
        const div = document.createElement('div');
        div.className = 'hbs-bucket-row';
        div.innerHTML = `
            <div class="bucket-header">
                <div class="bucket-meta">
                    <i class="fa-solid fa-chevron-right expand-icon"></i>
                    <span class="badge level">L${b.level}</span>
                    <span class="range">[${b.start}-${b.end}]</span>
                    <span class="tokens">${b.summaryTokens}t</span>
                </div>
                <div class="bucket-preview">${b.summary.slice(0, 50).replace(/\n/g, ' ')}...</div>
            </div>
            <div class="bucket-full-text" style="display: none;">${b.summary}</div>
        `;
        
        div.querySelector('.bucket-header').addEventListener('click', () => {
            const fullText = div.querySelector('.bucket-full-text');
            const icon = div.querySelector('.expand-icon');
            const isHidden = fullText.style.display === 'none';
            
            fullText.style.display = isHidden ? 'block' : 'none';
            icon.style.transform = isHidden ? 'rotate(90deg)' : 'rotate(0deg)';
            div.classList.toggle('expanded', isHidden);
        });

        list.appendChild(div);
    });
}

function drawTimeline(overlay, state, uaMessages) {
    const canvas = overlay.querySelector('#hbs_timeline_canvas');
    if (!canvas) return;
    
    // Resize canvas to parent width
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = 80;

    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const total = uaMessages.length;

    if (total === 0) return;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Helper: Map message index to X coordinate
    const getX = (idx) => (idx / total) * w;
    const getW = (start, end) => Math.max(1, ((end - start) / total) * w);

    // 1. Background (Unprocessed/Remainder)
    ctx.fillStyle = 'rgba(125, 125, 125, 0.1)';
    ctx.fillRect(0, 0, w, h);

    // 2. Buckets
    state.buckets.forEach(b => {
        const x = getX(b.start);
        const bw = getW(b.start, b.end);
        
        // Gradient for bucket
        const grad = ctx.createLinearGradient(x, 0, x, h);
        grad.addColorStop(0, '#4caf50');
        grad.addColorStop(1, '#2e7d32');
        
        ctx.fillStyle = grad;
        ctx.fillRect(x, 10, bw - 1, h - 20); // -1 for gap

        // Label L{level}
        if (bw > 20) {
            ctx.fillStyle = 'white';
            ctx.font = '10px sans-serif';
            ctx.fillText(`L${b.level}`, x + 2, h / 2 + 4);
        }
    });

    // 3. Live Window
    const historyEnd = Math.max(0, total - state.keepLastN);
    const liveX = getX(historyEnd);
    const liveW = w - liveX;

    ctx.fillStyle = 'rgba(33, 150, 243, 0.2)';
    ctx.fillRect(liveX, 0, liveW, h);
    ctx.strokeStyle = '#2196f3';
    ctx.lineWidth = 2;
    ctx.strokeRect(liveX, 0, liveW, h);

    // Add tooltip interaction
    const tooltip = overlay.querySelector('#hbs_viz_tooltip');
    
    const onMove = (e) => {
        const r = canvas.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const total = uaMessages.length;
        // Clamp index to valid range 0..total-1
        const msgIdx = Math.max(0, Math.min(total - 1, Math.floor((mx / w) * total)));

        // Find bucket or zone
        let foundBucket = state.buckets.find(b => msgIdx >= b.start && msgIdx < b.end);
        
        if (foundBucket) {
            tooltip.style.display = 'block';
            tooltip.style.left = (e.clientX + 10) + 'px';
            tooltip.style.top = (e.clientY + 10) + 'px';
            tooltip.innerHTML = `
                <strong>Bucket L${foundBucket.level}</strong><br>
                Range: ${foundBucket.start} - ${foundBucket.end}<br>
                Tokens: ${foundBucket.summaryTokens}
            `;
        } else if (msgIdx >= historyEnd) {
            tooltip.style.display = 'block';
            tooltip.style.left = (e.clientX + 10) + 'px';
            tooltip.style.top = (e.clientY + 10) + 'px';
            tooltip.innerHTML = `<strong>Live Window</strong><br>Msg: ${msgIdx}`;
        } else {
            tooltip.style.display = 'none';
        }
    };

    canvas.removeEventListener('mousemove', canvas._onMove);
    canvas._onMove = onMove;
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', () => tooltip.style.display = 'none');
}