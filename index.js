/**
 * ST Chat Summarizer - 聊天记录总结插件
 * 提取自 ST-Memory-Context,专注于聊天记录总结功能
 */

import {
    eventSource,
    event_types,
    getRequestHeaders,
    callPopup,
    substituteParams,
    saveSettingsDebounced,
    getCurrentChatId,
} from '../../../../script.js';

import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

import { 
    generateQuietPrompt 
} from '../../../generation.js';

const MODULE_NAME = 'chat-summarizer';
const UPDATE_INTERVAL = 1000;

// 默认设置
const defaultSettings = {
    enabled: true,
    
    // 总结设置
    auto_summarize: false,
    summarize_interval: 20,
    batch_size: 50,
    
    // 提示词设置
    summary_prompt: `请总结以下对话内容,提取关键信息、重要事件和角色发展:

{{messages}}

请用简洁的语言总结上述对话的核心内容。`,
    
    // 显示设置
    show_in_chat: true,
    summary_position: 'top',
    
    // 存储
    summaries: {}
};

let settings = { ...defaultSettings };
let isGenerating = false;

/**
 * 初始化插件
 */
async function init() {
    try {
        // 加载设置
        if (!extension_settings[MODULE_NAME]) {
            extension_settings[MODULE_NAME] = defaultSettings;
        }
        Object.assign(settings, extension_settings[MODULE_NAME]);
        
        // 加载UI
        const template = await renderExtensionTemplateAsync('third-party/chat-summarizer', 'settings');
        $('#extensions_settings2').append(template);
        
        // 绑定事件
        setupEventListeners();
        
        // 注册聊天事件
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        
        console.log('Chat Summarizer: Plugin initialized successfully');
    } catch (error) {
        console.error('Chat Summarizer: Initialization failed', error);
        toastr.error('聊天总结器初始化失败: ' + error.message);
    }
}

/**
 * 设置事件监听器
 */
function setupEventListeners() {
    // 启用开关
    $('#summarizer_enabled').prop('checked', settings.enabled).on('change', function() {
        settings.enabled = $(this).prop('checked');
        saveSettings();
        updateUI();
    });
    
    // 自动总结
    $('#summarizer_auto').prop('checked', settings.auto_summarize).on('change', function() {
        settings.auto_summarize = $(this).prop('checked');
        saveSettings();
    });
    
    // 总结间隔
    $('#summarizer_interval').val(settings.summarize_interval).on('input', function() {
        settings.summarize_interval = parseInt($(this).val());
        $('#summarizer_interval_value').text(settings.summarize_interval);
        saveSettings();
    });
    
    // 批次大小
    $('#summarizer_batch_size').val(settings.batch_size).on('input', function() {
        settings.batch_size = parseInt($(this).val());
        $('#summarizer_batch_size_value').text(settings.batch_size);
        saveSettings();
    });
    
    // 自定义提示词
    $('#summarizer_prompt').val(settings.summary_prompt).on('input', function() {
        settings.summary_prompt = $(this).val();
        saveSettings();
    });
    
    // 显示设置
    $('#summarizer_show_in_chat').prop('checked', settings.show_in_chat).on('change', function() {
        settings.show_in_chat = $(this).prop('checked');
        saveSettings();
        updateChatDisplay();
    });
    
    $('#summarizer_position').val(settings.summary_position).on('change', function() {
        settings.summary_position = $(this).val();
        saveSettings();
        updateChatDisplay();
    });
    
    // 操作按钮
    $('#summarizer_generate').on('click', () => generateSummary(false));
    $('#summarizer_clear').on('click', clearSummary);
    $('#summarizer_export').on('click', exportSummary);
    $('#summarizer_view').on('click', viewSummary);
    $('#summarizer_import').on('click', () => $('#summarizer_import_file').click());
    
    // 文件导入
    $('#summarizer_import_file').on('change', handleImportFile);
    
    // 初始化UI状态
    updateUI();
}

/**
 * 保存设置
 */
function saveSettings() {
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
}

/**
 * 更新UI状态
 */
function updateUI() {
    const enabled = settings.enabled;
    $('#summarizer_controls').toggle(enabled);
    
    const chatId = getCurrentChatId();
    const hasSummary = chatId && settings.summaries[chatId];
    
    $('#summarizer_view').toggle(hasSummary);
    $('#summarizer_clear').toggle(hasSummary);
    $('#summarizer_export').toggle(hasSummary);
    
    if (hasSummary) {
        const summary = settings.summaries[chatId];
        const timeStr = new Date(summary.timestamp).toLocaleString();
        $('#summarizer_status').text(`最后总结: ${timeStr} (${summary.messageCount}条消息)`);
    } else {
        $('#summarizer_status').text('暂无总结');
    }
}

/**
 * 当收到新消息时
 */
async function onMessageReceived() {
    if (!settings.enabled || !settings.auto_summarize) return;
    
    try {
        const context = getContext();
        const chatId = getCurrentChatId();
        if (!chatId || !context.chat) return;
        
        const messageCount = context.chat.length;
        const lastSummary = settings.summaries[chatId];
        const lastCount = lastSummary ? lastSummary.messageCount : 0;
        
        if (messageCount - lastCount >= settings.summarize_interval) {
            await generateSummary(true);
        }
    } catch (error) {
        console.error('Chat Summarizer: Auto summarize failed', error);
    }
}

/**
 * 当切换聊天时
 */
function onChatChanged() {
    updateUI();
    updateChatDisplay();
}

/**
 * 生成总结
 */
async function generateSummary(isAuto = false) {
    if (isGenerating) {
        if (!isAuto) toastr.warning('正在生成总结,请稍候...');
        return;
    }
    
    const context = getContext();
    const chatId = getCurrentChatId();
    
    if (!chatId || !context.chat || context.chat.length === 0) {
        if (!isAuto) toastr.error('当前没有可总结的聊天记录');
        return;
    }
    
    try {
        isGenerating = true;
        
        if (!isAuto) {
            toastr.info('开始生成总结...');
        }
        
        // 收集消息
        const messages = context.chat
            .filter(msg => !msg.is_system)
            .map(msg => {
                const role = msg.is_user ? '用户' : (msg.name || 'AI');
                return `${role}: ${msg.mes}`;
            });
        
        if (messages.length === 0) {
            if (!isAuto) toastr.warning('没有可总结的消息');
            return;
        }
        
        // 分批处理
        const batches = [];
        for (let i = 0; i < messages.length; i += settings.batch_size) {
            batches.push(messages.slice(i, i + settings.batch_size));
        }
        
        let finalSummary = '';
        
        if (batches.length === 1) {
            finalSummary = await summarizeBatch(batches[0]);
        } else {
            const batchSummaries = [];
            
            for (let i = 0; i < batches.length; i++) {
                const batchSummary = await summarizeBatch(batches[i], i + 1, batches.length);
                batchSummaries.push(batchSummary);
            }
            
            finalSummary = await summarizeBatch(
                batchSummaries.map((s, i) => `[第${i + 1}批次总结]\n${s}`),
                0,
                0,
                true
            );
        }
        
        // 保存总结
        settings.summaries[chatId] = {
            timestamp: Date.now(),
            content: finalSummary,
            messageCount: messages.length,
            characterName: context.name
        };
        
        saveSettings();
        updateUI();
        updateChatDisplay();
        
        if (!isAuto) {
            toastr.success('总结生成完成!');
        }
        
    } catch (error) {
        console.error('Chat Summarizer: Generate summary failed', error);
        if (!isAuto) {
            toastr.error('生成总结失败: ' + error.message);
        }
    } finally {
        isGenerating = false;
    }
}

/**
 * 总结一批消息
 */
async function summarizeBatch(messages, batchNum = 0, totalBatches = 0, isFinal = false) {
    const messagesText = Array.isArray(messages) ? messages.join('\n\n') : messages;
    
    let prompt = settings.summary_prompt.replace('{{messages}}', messagesText);
    
    if (batchNum > 0 && totalBatches > 0) {
        prompt = `[正在总结第 ${batchNum}/${totalBatches} 批次]\n\n` + prompt;
    }
    
    if (isFinal) {
        prompt = `以下是多个批次的总结内容,请将它们整合成一个完整、连贯的总结:\n\n${messagesText}\n\n请生成最终的综合总结。`;
    }
    
    const result = await generateQuietPrompt(prompt);
    
    return result;
}

/**
 * 清除当前聊天的总结
 */
async function clearSummary() {
    const chatId = getCurrentChatId();
    if (!chatId) return;
    
    const confirm = await callPopup('确定要清除当前聊天的总结吗?', 'confirm');
    if (confirm !== 'true') return;
    
    delete settings.summaries[chatId];
    saveSettings();
    updateUI();
    updateChatDisplay();
    
    toastr.success('总结已清除');
}

/**
 * 导出总结
 */
function exportSummary() {
    const chatId = getCurrentChatId();
    const summary = settings.summaries[chatId];
    
    if (!summary) {
        toastr.error('没有可导出的总结');
        return;
    }
    
    const context = getContext();
    const fileName = `Summary_${context.name || 'Chat'}_${new Date().toISOString().split('T')[0]}.txt`;
    
    const content = `=== CHAT SUMMARY ===
CHARACTER: ${summary.characterName || '未知'}
CHAT_ID: ${chatId}
TIMESTAMP: ${summary.timestamp}
MESSAGE_COUNT: ${summary.messageCount}
GENERATED_AT: ${new Date(summary.timestamp).toISOString()}

=== SUMMARY CONTENT ===

${summary.content}

=== END OF SUMMARY ===`;
    
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    toastr.success('总结已导出');
}

/**
 * 处理导入文件
 */
async function handleImportFile(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    event.target.value = '';
    
    try {
        const text = await file.text();
        const parsed = parseExportedSummary(text);
        
        if (!parsed) {
            toastr.error('无法识别的文件格式');
            return;
        }
        
        const chatId = getCurrentChatId();
        
        if (!chatId) {
            toastr.error('请先打开一个聊天');
            return;
        }
        
        const confirmMsg = `确定要导入总结吗?\n\n` +
                          `来源角色: ${parsed.characterName || '未知'}\n` +
                          `生成时间: ${new Date(parsed.timestamp).toLocaleString()}\n` +
                          `消息数量: ${parsed.messageCount}\n\n` +
                          `${settings.summaries[chatId] ? '⚠️ 这将覆盖当前聊天的总结' : ''}`;
        
        const confirmed = await callPopup(confirmMsg, 'confirm');
        if (confirmed !== 'true') return;
        
        settings.summaries[chatId] = {
            timestamp: Date.now(),
            originalTimestamp: parsed.timestamp,
            content: parsed.content,
            messageCount: parsed.messageCount,
            characterName: parsed.characterName,
            imported: true,
            importedFrom: file.name
        };
        
        saveSettings();
        updateUI();
        updateChatDisplay();
        
        toastr.success('总结导入成功!');
        
    } catch (error) {
        console.error('Chat Summarizer: Import failed', error);
        toastr.error('导入失败: ' + error.message);
    }
}

/**
 * 解析导出的总结文件
 */
function parseExportedSummary(text) {
    try {
        // 标准格式
        const characterMatch = text.match(/CHARACTER:\s*(.+)/);
        const timestampMatch = text.match(/TIMESTAMP:\s*(\d+)/);
        const messageCountMatch = text.match(/MESSAGE_COUNT:\s*(\d+)/);
        const contentMatch = text.match(/=== SUMMARY CONTENT ===\s*([\s\S]+?)\s*=== END OF SUMMARY ===/);
        
        if (contentMatch) {
            return {
                characterName: characterMatch ? characterMatch[1].trim() : '未知',
                timestamp: timestampMatch ? parseInt(timestampMatch[1]) : Date.now(),
                messageCount: messageCountMatch ? parseInt(messageCountMatch[1]) : 0,
                content: contentMatch[1].trim()
            };
        }
        
        // 旧格式
        const oldFormatMatch = text.match(/角色:\s*(.+)\s*\n[\s\S]*?=== 总结内容 ===\s*([\s\S]+)/);
        if (oldFormatMatch) {
            return {
                characterName: oldFormatMatch[1].trim(),
                timestamp: Date.now(),
                messageCount: 0,
                content: oldFormatMatch[2].trim()
            };
        }
        
        // 纯文本
        if (text.length > 50 && text.length < 50000) {
            return {
                characterName: '导入',
                timestamp: Date.now(),
                messageCount: 0,
                content: text.trim()
            };
        }
        
        return null;
    } catch (error) {
        console.error('Chat Summarizer: Parse failed', error);
        return null;
    }
}

/**
 * 查看总结
 */
async function viewSummary() {
    const chatId = getCurrentChatId();
    const summary = settings.summaries[chatId];
    
    if (!summary) {
        toastr.error('没有可查看的总结');
        return;
    }
    
    const html = `
        <div class="summary-viewer">
            <div class="summary-header">
                <strong>角色:</strong> ${summary.characterName || '未知'}<br>
                <strong>生成时间:</strong> ${new Date(summary.timestamp).toLocaleString()}<br>
                <strong>消息数量:</strong> ${summary.messageCount}
            </div>
            <hr>
            <div class="summary-content">
                ${summary.content.replace(/\n/g, '<br>')}
            </div>
        </div>
    `;
    
    await callPopup(html, 'text', '', { wide: true, large: true });
}

/**
 * 更新聊天界面显示
 */
function updateChatDisplay() {
    $('.chat-summary-display').remove();
    
    if (!settings.enabled || !settings.show_in_chat) return;
    
    const chatId = getCurrentChatId();
    const summary = settings.summaries[chatId];
    
    if (!summary) return;
    
    const summaryHtml = `
        <div class="chat-summary-display">
            <div class="summary-header">
                <i class="fa-solid fa-book"></i> 
                <strong>聊天总结</strong>
                <span class="summary-info">(${summary.messageCount}条消息)</span>
            </div>
            <div class="summary-body">
                ${summary.content.replace(/\n/g, '<br>')}
            </div>
            <div class="summary-footer">
                <small>生成于 ${new Date(summary.timestamp).toLocaleString()}</small>
            </div>
        </div>
    `;
    
    const $chat = $('#chat');
    if (settings.summary_position === 'top') {
        $chat.prepend(summaryHtml);
    } else {
        $chat.append(summaryHtml);
    }
}

// 初始化
jQuery(async () => {
    await init();
});
