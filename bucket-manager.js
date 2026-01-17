import { getContext } from '../../../../scripts/extensions.js';
import { getStringHash } from '../../../../scripts/utils.js';

let debugEnabled = false;

export function setDebug(enabled) {
    debugEnabled = enabled;
    console.log(`[HBS] Debug mode set to: ${enabled}`);
}

function debugLog(...args) {
    if (debugEnabled) {
        console.log('[HBS]', ...args);
    }
}

const DEFAULT_STATE = {
    version: 1,
    enabled: true,
    base: 8,
    keepLastN: 12,
    maxSummaryWords: 120,
    processedUntil: 0,
    buckets: [],
    dirty: false,
    fingerprint: '',
};

export function isUserAssistant(msg) {
    if (!msg) return false;
    if (msg.is_system) return false;
    return msg.is_user === true || msg.is_user === false;
}

export function loadHbsState(chatMetadata) {
    // debugLog('Loading HBS state');
    if (!chatMetadata || !chatMetadata.hbs) {
        return null;
    }
    return chatMetadata.hbs;
}

export function initHbsState(chatMetadata, defaultSettings) {
    debugLog('Initializing new HBS state', defaultSettings);
    const state = {
        ...DEFAULT_STATE,
        base: defaultSettings.defaultBase || DEFAULT_STATE.base,
        keepLastN: defaultSettings.defaultKeepLastN || DEFAULT_STATE.keepLastN,
        maxSummaryWords: defaultSettings.defaultMaxSummaryWords || DEFAULT_STATE.maxSummaryWords,
    };

    chatMetadata.hbs = state;
    return state;
}

export function saveHbsState(state, chatMetadata) {
    chatMetadata.hbs = state;
}

export function computeFingerprint(uaMessages, historyEnd) {
    if (historyEnd <= 0 || !uaMessages.length) {
        return '';
    }

    const relevantMessages = uaMessages.slice(0, historyEnd);
    const messagesText = relevantMessages.map(m => m.mes || '').join('|||');
    return getStringHash(messagesText).toString();
}

export function checkDirty(state, uaMessages, historyEnd) {
    const currentFingerprint = computeFingerprint(uaMessages, historyEnd);

    if (!state.fingerprint) {
        debugLog('No fingerprint found, setting initial fingerprint');
        state.fingerprint = currentFingerprint;
        return false;
    }

    if (state.processedUntil > 0 && currentFingerprint !== state.fingerprint) {
        debugLog('Fingerprint mismatch! History has changed.');
        state.dirty = true;
        return true;
    }

    return state.dirty;
}

export function formatMessagesForLeaf(messages) {
    return messages
        .map(msg => {
            const role = msg.is_user ? 'U' : 'A';
            const text = (msg.mes || '').trim();
            return `${role}: ${text}`;
        })
        .join('\n\n');
}

export function formatMessagesForMerge(summary1, summary2) {
    return `S1: ${summary1}\n\nS2: ${summary2}`;
}

const LEAF_SYSTEM_PROMPT = `You are a precise summarizer. Summarize the following conversation excerpt.
Focus on: key facts, character actions, plot developments, emotional states.
Output only the summary, no preamble or meta-commentary.`;

const MERGE_SYSTEM_PROMPT = `You are a precise summarizer. Merge these two consecutive summaries into one cohesive summary.
Preserve chronological order and key information from both.
Output only the merged summary, no preamble or meta-commentary.`;

export async function callSummarize(mode, text, maxWords, meta = {}, profileId = null) {
    debugLog(`callSummarize invoked: mode=${mode}, maxWords=${maxWords}, textLength=${text.length}, meta=`, meta);
    try {
        const context = getContext();

        if (!profileId) {
            const ext_settings = context.extensionSettings;
            profileId = ext_settings?.hbs?.selectedProfileId;
        }

        if (!profileId) {
            throw new Error('No connection profile selected. Please select a profile in HBS settings.');
        }

        const systemPrompt = mode === 'leaf' ? LEAF_SYSTEM_PROMPT : MERGE_SYSTEM_PROMPT;
        const userPrompt = mode === 'leaf'
            ? `Summarize the following conversation in under ${maxWords} words:\n\n${text}`
            : `Merge these summaries into one summary under ${maxWords} words:\n\n${text}`;

        const messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ];

        debugLog(`[HBS] Calling summarize: mode=${mode}, profile=${profileId}, maxWords=${maxWords}`);
        debugLog(`[HBS] PAYLOAD (Messages):`, JSON.stringify(messages, null, 2));

        let useRawResponse = false;
        if (context.ConnectionManagerRequestService?.getProfile && context.CONNECT_API_MAP) {
            try {
                const profile = context.ConnectionManagerRequestService.getProfile(profileId);
                const apiMap = context.CONNECT_API_MAP?.[profile?.api];
                useRawResponse = apiMap?.selected === 'textgenerationwebui' && apiMap?.type === 'openrouter';
            } catch (error) {
                debugLog('[HBS] Failed to resolve profile info for summarization:', error);
            }
        }

        const result = await context.ConnectionManagerRequestService.sendRequest(
            profileId,
            messages,
            undefined,
            {
                stream: false,
                extractData: !useRawResponse,
                includePreset: true,
                includeInstruct: false,
            }
        );

        const extractedContent = useRawResponse && context.extractMessageFromData && result
            ? context.extractMessageFromData(result, 'textgenerationwebui')
            : result?.content;

        if (!extractedContent) {
            throw new Error('Empty response from Connection Manager');
        }

        const summaryText = extractedContent.trim();

        debugLog(`Summarization successful. Result length: ${summaryText.length}`);
        debugLog(`[HBS] RESPONSE (Content):`, summaryText);

        return {
            text: summaryText,
            tokens: 0,
            usage: null,
        };
    } catch (error) {
        console.error('[HBS] Summarization error:', error);
        throw new Error(`Summarization failed: ${error.message}`);
    }
}

export async function performMergeCarry(state, chatId) {
    debugLog(`Checking for merge opportunities. Buckets count: ${state.buckets.length}`);
    while (state.buckets.length >= 2) {
        const b2 = state.buckets[state.buckets.length - 1];
        const b1 = state.buckets[state.buckets.length - 2];

        debugLog(`Comparing last two buckets: L${b1.level} [${b1.start}-${b1.end}) and L${b2.level} [${b2.start}-${b2.end})`);

        if (b1.level !== b2.level || b1.end !== b2.start) {
            debugLog('No merge needed (level mismatch or gap).');
            break;
        }

        debugLog(`[HBS] Merging buckets: L${b1.level} [${b1.start}-${b1.end}) + [${b2.start}-${b2.end})`);

        state.buckets.pop();
        state.buckets.pop();

        const mergeText = formatMessagesForMerge(b1.summary, b2.summary);
        debugLog(`[HBS] Merge Content:\n${mergeText}`);

        const result = await callSummarize('merge', mergeText, state.maxSummaryWords, {
            chatId,
            range: [b1.start, b2.end],
        });

        const context = getContext();
        const summaryTokens = await context.getTokenCountAsync(result.text, 0);

        const newBucket = {
            level: b1.level + 1,
            start: b1.start,
            end: b2.end,
            summary: result.text,
            summaryTokens: summaryTokens,
            createdAt: Date.now(),
        };

        state.buckets.push(newBucket);
        debugLog(`[HBS] Merged to: L${b1.level + 1} [${b1.start}-${b2.end})`, newBucket);
    }
}

export async function ensureBucketsUpToDate(state, uaMessages, chatId) {
    const historyEnd = Math.max(0, uaMessages.length - state.keepLastN);

    debugLog(`[HBS] Bucket check: processedUntil=${state.processedUntil}, historyEnd=${historyEnd}, total=${uaMessages.length}, base=${state.base}`);

    while (state.processedUntil + state.base <= historyEnd) {
        const start = state.processedUntil;
        const end = start + state.base;
        debugLog(`Processing chunk: [${start}-${end})`);
        const chunk = uaMessages.slice(start, end);

        debugLog(`[HBS] Creating leaf bucket: [${start}-${end})`);

        const text = formatMessagesForLeaf(chunk);
        debugLog(`[HBS] Leaf Chunk Content:\n${text}`);

        const result = await callSummarize('leaf', text, state.maxSummaryWords, {
            chatId,
            range: [start, end],
        });

        const context = getContext();
        const summaryTokens = await context.getTokenCountAsync(result.text, 0);

        const newBucket = {
            level: 0,
            start,
            end,
            summary: result.text,
            summaryTokens: summaryTokens,
            createdAt: Date.now(),
        };

        state.buckets.push(newBucket);
        debugLog('Created new leaf bucket:', newBucket);

        state.processedUntil = end;

        await performMergeCarry(state, chatId);
    }

    state.fingerprint = computeFingerprint(uaMessages, historyEnd);
    state.dirty = false;
    debugLog('ensureBucketsUpToDate complete. State:', state);
}

export function clampStateToHistoryEnd(state, historyEnd) {
    if (state.processedUntil <= historyEnd) {
        return;
    }

    debugLog(`[HBS] History end moved backwards: processedUntil=${state.processedUntil} -> ${historyEnd}`);

    state.buckets = state.buckets.filter(bucket => bucket.end <= historyEnd);

    state.processedUntil = historyEnd;

    if (state.buckets.length > 0) {
        const lastBucket = state.buckets[state.buckets.length - 1];
        state.processedUntil = lastBucket.end;
    } else {
        state.processedUntil = 0;
    }

    state.dirty = true;
    debugLog('State clamped. New processedUntil:', state.processedUntil);
}

export function buildVirtualChat(state, uaMessages, extensionSettings) {
    debugLog('Building virtual chat...');
    const historyEnd = Math.max(0, uaMessages.length - state.keepLastN);
    const virtual = [];

    clampStateToHistoryEnd(state, historyEnd);

    if (state.buckets.length > 0) {
        debugLog(`Injecting ${state.buckets.length} buckets as summary.`);
        const sortedBuckets = state.buckets.slice().sort((a, b) => a.start - b.start);
        const allSummaries = sortedBuckets.map(b => b.summary).join('\n\n');

        const template = extensionSettings.injectionTemplate || '[Summary of earlier conversation:]\n{{summary}}';
        const injectedText = template.replace('{{summary}}', allSummaries);

        const injectionRole = extensionSettings.injectionRole || 'system';
        const isSystem = injectionRole === 'system';
        const isUser = injectionRole === 'user';

        virtual.push({
            role: injectionRole,
            mes: injectedText,
            is_system: isSystem,
            is_user: isUser,
            name: isUser ? 'User' : (isSystem ? 'System' : 'HBS Summary'),
        });
    }

    const remainderStart = state.processedUntil;
    debugLog(`Adding remainder messages from ${remainderStart} to ${historyEnd}`);
    for (let i = remainderStart; i < historyEnd; i++) {
        if (i < uaMessages.length) {
            virtual.push(uaMessages[i]);
        }
    }

    debugLog(`Adding live window messages from ${historyEnd} to ${uaMessages.length}`);
    for (let i = historyEnd; i < uaMessages.length; i++) {
        virtual.push(uaMessages[i]);
    }

    debugLog(`Virtual chat built. Total messages: ${virtual.length}`);
    return virtual;
}

export async function countTokensForMessages(messages) {
    const context = getContext();
    const getTokenCountAsync = context.getTokenCountAsync;

    if (!getTokenCountAsync) {
        console.warn('[HBS] Token counting not available');
        return 0;
    }

    let total = 0;
    for (const msg of messages) {
        if (msg.mes) {
            const count = await getTokenCountAsync(msg.mes, 0);
            total += count;
        }
    }

    return total;
}

export async function computeTokenStats(state, uaMessages) {
    debugLog('Computing token stats...');
    const historyEnd = Math.max(0, uaMessages.length - state.keepLastN);

    let bucketTokens = 0;
    for (const bucket of state.buckets) {
        bucketTokens += bucket.summaryTokens || 0;
    }

    const remainderMessages = uaMessages.slice(state.processedUntil, historyEnd);
    const remainderTokens = await countTokensForMessages(remainderMessages);

    const liveMessages = uaMessages.slice(historyEnd);
    const liveTokens = await countTokensForMessages(liveMessages);

    const stats = {
        bucketTokens,
        remainderTokens,
        liveTokens,
        totalVirtual: bucketTokens + remainderTokens + liveTokens,
        processedUntil: state.processedUntil,
        historyEnd,
        totalMessages: uaMessages.length,
        bucketsCount: state.buckets.length,
    };
    debugLog('Stats computed:', stats);
    return stats;
}

export function resetHbsState(state) {
    debugLog('Resetting HBS state');
    state.processedUntil = 0;
    state.buckets = [];
    state.dirty = false;
    state.fingerprint = '';
}

export function getBucketCountsByLevel(state) {
    const counts = {};
    for (const bucket of state.buckets) {
        const level = bucket.level;
        counts[level] = (counts[level] || 0) + 1;
    }
    return counts;
}

export async function rebuildBuckets(state, uaMessages, chatId) {
    debugLog('Rebuilding buckets from scratch...');
    const oldProcessedUntil = state.processedUntil;
    const oldBuckets = state.buckets.slice();

    resetHbsState(state);

    try {
        await ensureBucketsUpToDate(state, uaMessages, chatId);
        console.log(`[HBS] Rebuilt buckets: ${oldBuckets.length} -> ${state.buckets.length}`);
    } catch (error) {
        console.error('[HBS] Rebuild failed, restoring old state:', error);
        state.processedUntil = oldProcessedUntil;
        state.buckets = oldBuckets;
        throw error;
    }
}
