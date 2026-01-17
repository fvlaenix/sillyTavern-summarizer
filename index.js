import { getContext, extension_settings } from '../../../../scripts/extensions.js';
import { eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';
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
    countTokensForMessages,
    setDebug,
} from './bucket-manager.js';
import { openHbsDashboard } from './dashboard.js';

const MODULE_NAME = 'hbs';
const DEFAULT_SETTINGS = {
    enabledGlobally: true,
    defaultBase: 8,
    defaultKeepLastN: 12,
    defaultMaxSummaryWords: 120,
    injectionTemplate: '[Summary of earlier conversation:]\n{{summary}}',
    injectionRole: 'system',
    showDebugPanel: true,
    selectedProfileId: null,
    debugOutput: false,
};

let isProcessing = false;

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
        saveSettingsDebounced();
    }
    return extension_settings[MODULE_NAME];
}

function debugLog(...args) {
    if (getSettings().debugOutput) {
        console.log('[HBS-UI]', ...args);
    }
}

async function withLock(fn) {
    if (isProcessing) {
        debugLog('Summarization already in progress, skipping');
        return null;
    }

    isProcessing = true;
    try {
        return await fn();
    } finally {
        isProcessing = false;
    }
}

async function onChatChanged() {
    const context = getContext();
    const settings = getSettings();

    if (!context.chat || context.chat.length === 0) {
        updateStatusDisplay('No chat loaded', 'grey');
        return;
    }

    let state = loadHbsState(context.chatMetadata);
    if (!state) {
        state = initHbsState(context.chatMetadata, settings);
        saveHbsState(state, context.chatMetadata);
        await context.saveMetadata();
    }

    const uaMessages = context.chat.filter(isUserAssistant);
    const stats = await computeTokenStats(state, uaMessages);
    
    // Update the mini-status in the extensions list
    updateStatusDisplay(`${stats.bucketsCount} buckets | ${stats.bucketTokens}t`, 'green');

    // Also check dirty state
    const isDirty = checkDirty(state, uaMessages, Math.max(0, uaMessages.length - state.keepLastN));
    if (isDirty) {
        updateStatusDisplay('History modified (Dirty)', 'orange');
    }
}

function updateStatusDisplay(text, color) {
    const el = document.getElementById('hbs_extension_status');
    if (el) {
        el.textContent = text;
        el.style.color = color === 'green' ? 'var(--SmartThemeQuoteColor)' :
                         color === 'orange' ? '#ff9800' :
                         'var(--SmartThemeBodyColor)';
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

    await withLock(async () => {
        try {
            const uaMessages = chat.filter(isUserAssistant);
            const chatId = context.chatId || 'unknown';

            debugLog(`Generate interceptor: ${uaMessages.length} UA messages`);

            const historyEnd = Math.max(0, uaMessages.length - state.keepLastN);
            const liveMessages = uaMessages.slice(historyEnd);
            const liveTokens = await countTokensForMessages(liveMessages);

            if (liveTokens > contextSize) {
                toastr.error(`HBS: Live window (${liveTokens}t) > Context (${contextSize}).`);
                abort(true);
                return;
            }

            await ensureBucketsUpToDate(state, uaMessages, chatId);

            saveHbsState(state, context.chatMetadata);
            context.saveMetadataDebounced();

            const virtualChat = buildVirtualChat(state, uaMessages, settings);
            chat.splice(0, chat.length, ...virtualChat);

            const stats = await computeTokenStats(state, uaMessages);
            if (stats.totalVirtual > contextSize) {
                toastr.error(`HBS: Total virtual (${stats.totalVirtual}t) > Context (${contextSize}).`);
                abort(true);
            }
        } catch (error) {
            console.error('[HBS] Generate interceptor error:', error);
            toastr.warning(`HBS: ${error.message}.`);
        }
    });
}

window.hbs_generate_interceptor = hbs_generate_interceptor;

function loadSettingsHtml() {
    // Clean UI - Just a button and status
    const html = `
        <div id="hbs_settings_container">
            <div class="hbs-mini-status">
                <strong>Status:</strong> <span id="hbs_extension_status">Initializing...</span>
            </div>
            <button id="hbs_open_dashboard" class="menu_button" style="width: 100%; margin-top: 10px; padding: 10px;">
                <i class="fa-solid fa-gauge-high"></i> Open HBS Dashboard
            </button>
            <div style="margin-top: 10px; font-size: 0.8em; opacity: 0.7;">
                HBS automates context summarization using hierarchical buckets.
                Configure profiles and view timeline in the dashboard.
            </div>
        </div>
    `;

    $('#extensions_settings2').append(html);
    
    document.getElementById('hbs_open_dashboard').addEventListener('click', openHbsDashboard);
}

jQuery(async () => {
    loadSettingsHtml();
    const settings = getSettings();
    setDebug(settings.debugOutput);

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    
    // Initial check
    setTimeout(onChatChanged, 1000); // Small delay to ensure chat loaded
    debugLog('Extension initialized (New UI)');
});
