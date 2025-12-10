/**
 * ST Chat Summarizer - 聊天记录总结插件
 * 提取自 ST-Memory-Context,专注于聊天记录总结功能
 * 
 * 核心功能:
 * 1. 自动/手动生成聊天记录总结
 * 2. 分批总结长对话
 * 3. 支持自定义总结提示词
 * 4. 总结结果可保存和导出
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
    summarize_interval: 20,  // 每20条消息自动总结一次
    batch_size: 50,          // 每批处理50条消息
    
    // 提示词设置
    summary_prompt: `请总结以下对话内容,提取关键信息、重要事件和角色发展:

{{messages}}

请用简洁的语言总结上述对话的核心内容。`,
    
    // 显示设置
    show_in_chat: true,
    summary_position: 'top',  // top 或 bottom
    
    // 存储
    summaries: {}  // { chatId: { timestamp, content, messageCount } }
};

let settings = { ...defaultSettings };
let isGenerating = false;

/**
 * 初始化插件
 */
async function init() {
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
    
    console.log('Chat Summarizer initialized');
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
    $('#summarizer_generate').on('click', generateSummary);
    $('#summarizer_clear').on('click', clearSummary);
    $('#summarizer_export').on('click', exportSummary);
    $('#summarizer_view').on('click', viewSummary);
    $('#summarizer_import').on('click', () => $('#summarizer_import_file').click());
    
    // 文件导入
    $('#summarizer_import_file').on('change', handleImportFile);
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
        $('#summarizer_status').text(
            `最后总结: ${new Date(summary.timestamp).toLocaleString()} (${summary.messageCount}条消息)`
        );
    } else {
        $('#summarizer_status').text('暂无总结');
    }
}

/**
 * 当收到新消息时
 */
async function onMessageReceived() {
    if (!settings.enabled || !settings.auto_summarize) return;
    
    const context = getContext();
    const chatId = getCurrentChatId();
    if (!chatId || !context.chat) return;
    
    // 检查是否需要自动总结
    const messageCount = context.chat.length;
    const lastSummary = settings.summaries[chatId];
    const lastCount = lastSummary ? lastSummary.messageCount : 0;
    
    if (messageCount - lastCount >= settings.summarize_interval) {
        await generateSummary(true);
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
        toastr.warning('正在生成总结,请稍候...');
        return;
    }
    
    const context = getContext();
    const chatId = getCurrentChatId();
    
    if (!chatId || !context.chat || context.chat.length === 0) {
        toastr.error('当前没有可总结的聊天记录');
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
        
        // 分批处理
        const batches = [];
        for (let i = 0; i < messages.length; i += settings.batch_size) {
            batches.push(messages.slice(i, i + settings.batch_size));
        }
        
        let finalSummary = '';
        
        if (batches.length === 1) {
            // 单批次直接总结
            finalSummary = await summarizeBatch(batches[0]);
        } else {
            // 多批次:先分别总结,再汇总
            const batchSummaries = [];
            
            for (let i = 0; i < batches.length; i++) {
                const batchSummary = await summarizeBatch(batches[i], i + 1, batches.length);
                batchSummaries.push(batchSummary);
            }
            
            // 汇总所有批次
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
        console.error('生成总结失败:', error);
        toastr.error('生成总结失败: ' + error.message);
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
    
    // 使用 quiet 模式生成(不会显示在聊天中)
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
    
    const content = `聊天总结
角色: ${summary.characterName || '未知'}
生成时间: ${new Date(summary.timestamp).toLocaleString()}
消息数量: ${summary.messageCount}

=== 总结内容 ===

${summary.content}
`;
    
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
    // 移除旧的总结显示
    $('.chat-summary-display').remove();
    
    if (!settings.enabled || !settings.show_in_chat) return;
    
    const chatId = getCurrentChatId();
    const summary = settings.summaries[chatId];
    
    if (!summary) return;
    
    // 创建总结显示元素
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
    
    // 插入到聊天界面
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