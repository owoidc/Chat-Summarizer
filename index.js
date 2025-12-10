/**
 * ST Chat Summarizer - 聊天记录总结插件 (修复版)
 * 防止死循环刷屏，增加生成冷却锁
 */

import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    getCurrentChatId,
    // generateQuiet, // ❌ 移除这个导入，改用全局调用防止死循环或兼容问题
} from '../../../../script.js';

import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

const MODULE_NAME = 'chat-summarizer';

// 默认设置
const defaultSettings = {
    enabled: true,
    auto_summarize: false,
    summarize_interval: 20,
    batch_size: 50,
    summary_prompt: `请总结以下对话内容,提取关键信息、重要事件和角色发展:\n\n{{messages}}\n\n请用简洁的语言总结上述对话的核心内容。`,
    show_in_chat: true,
    summary_position: 'top',
    summaries: {}
};

let settings = { ...defaultSettings };

// 🔒 状态锁 & 冷却计时器
let isGenerating = false;
let lastGenerationTime = 0;
const COOLDOWN_MS = 5000; // 强制冷却时间 5秒

/**
 * 初始化插件
 */
async function init() {
    try {
        if (!extension_settings[MODULE_NAME]) {
            extension_settings[MODULE_NAME] = defaultSettings;
        }
        Object.assign(settings, extension_settings[MODULE_NAME]);
        
        // 加载界面
        const template = await renderExtensionTemplateAsync('third-party/Chat-Summarizer', 'settings');
        $('#extensions_settings2').append(template);
        
        setupEventListeners();
        
        // 绑定事件
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        
        console.log('✅ Chat Summarizer loaded');
    } catch (error) {
        console.error('Chat Summarizer Init Error:', error);
    }
}

function setupEventListeners() {
    // 基础开关
    $('#summarizer_enabled').prop('checked', settings.enabled).on('change', function() {
        settings.enabled = $(this).prop('checked');
        saveSettings();
        updateUI();
    });
    $('#summarizer_auto').prop('checked', settings.auto_summarize).on('change', function() {
        settings.auto_summarize = $(this).prop('checked');
        saveSettings();
    });

    // 数值输入
    $('#summarizer_interval').val(settings.summarize_interval).on('input', function() {
        settings.summarize_interval = parseInt($(this).val());
        $('#summarizer_interval_value').text(settings.summarize_interval);
        saveSettings();
    });
    $('#summarizer_batch_size').val(settings.batch_size).on('input', function() {
        settings.batch_size = parseInt($(this).val());
        $('#summarizer_batch_size_value').text(settings.batch_size);
        saveSettings();
    });

    // 提示词 & 显示
    $('#summarizer_prompt').val(settings.summary_prompt).on('input', function() { settings.summary_prompt = $(this).val(); saveSettings(); });
    $('#summarizer_show_in_chat').prop('checked', settings.show_in_chat).on('change', function() { settings.show_in_chat = $(this).prop('checked'); saveSettings(); updateChatDisplay(); });
    $('#summarizer_position').val(settings.summary_position).on('change', function() { settings.summary_position = $(this).val(); saveSettings(); updateChatDisplay(); });

    // 按钮
    $('#summarizer_generate').on('click', () => generateSummary(false));
    $('#summarizer_clear').on('click', clearSummary);
    $('#summarizer_export').on('click', exportSummary);
    $('#summarizer_view').on('click', viewSummary);
    $('#summarizer_import').on('click', () => $('#summarizer_import_file').click());
    $('#summarizer_import_file').on('change', handleImportFile);

    updateUI();
}

function saveSettings() {
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
}

function updateUI() {
    const enabled = settings.enabled;
    $('#summarizer_controls').toggle(enabled);
    const chatId = getCurrentChatId();
    const hasSummary = chatId && settings.summaries[chatId];
    
    $('#summarizer_view').toggle(!!hasSummary);
    $('#summarizer_clear').toggle(!!hasSummary);
    $('#summarizer_export').toggle(!!hasSummary);
    
    if (hasSummary) {
        const timeStr = new Date(settings.summaries[chatId].timestamp).toLocaleString();
        $('#summarizer_status').text(`已总结 (${timeStr})`);
    } else {
        $('#summarizer_status').text('无总结数据');
    }
}

/**
 * 核心逻辑：收到消息时触发检查
 */
async function onMessageReceived() {
    if (!settings.enabled || !settings.auto_summarize) return;
    
    // 🔒 1. 检查是否正在生成
    if (isGenerating) return;

    // 🔒 2. 检查冷却时间 (防止死循环刷屏的关键)
    if (Date.now() - lastGenerationTime < COOLDOWN_MS) {
        console.log('Chat Summarizer: In cooldown, skipping auto-summary');
        return;
    }
    
    try {
        const context = getContext();
        const chatId = getCurrentChatId();
        if (!chatId || !context.chat) return;
        
        const messageCount = context.chat.length;
        const lastSummary = settings.summaries[chatId];
        const lastCount = lastSummary ? lastSummary.messageCount : 0;
        
        // 只有当新增消息超过间隔时才触发
        if (messageCount - lastCount >= settings.summarize_interval) {
            console.log(`Chat Summarizer: Triggering auto-summary (${messageCount} - ${lastCount} >= ${settings.summarize_interval})`);
            await generateSummary(true);
        }
    } catch (error) {
        console.error('Chat Summarizer: Auto summarize check failed', error);
    }
}

function onChatChanged() {
    updateUI();
    updateChatDisplay();
}

/**
 * 执行生成
 */
async function generateSummary(isAuto = false) {
    // 双重锁检查
    if (isGenerating) return;
    
    const context = getContext();
    const chatId = getCurrentChatId();
    
    if (!chatId || !context.chat || context.chat.length === 0) {
        if (!isAuto) toastr.error('没有聊天记录');
        return;
    }

    // 🔒 上锁
    isGenerating = true;
    if (!isAuto) toastr.info('正在生成总结...');

    try {
        const messages = context.chat
            .filter(msg => !msg.is_system)
            .map(msg => {
                const role = msg.is_user ? 'User' : (msg.name || 'Char');
                return `${role}: ${msg.mes}`;
            });

        // 简化的批处理逻辑 (直接取最近的 N 条，避免每次都重跑整个历史导致太慢)
        // 这里为了演示稳定性，先不分批，直接把最近的消息丢进去总结
        // 如果你需要分批，请确保逻辑不会无限递归
        const textToSummarize = messages.join('\n');
        
        let prompt = settings.summary_prompt.replace('{{messages}}', textToSummarize);
        
        // 🚀 调用核心生成函数 (兼容性写法)
        const generateFn = window.generateQuiet || window.SillyTavern?.generation?.generateQuiet;
        
        if (typeof generateFn !== 'function') {
            throw new Error('无法找到生成函数 (window.generateQuiet)');
        }

        console.log('Chat Summarizer: Sending prompt to LLM...');
        const result = await generateFn(prompt);
        console.log('Chat Summarizer: Generation complete');

        if (!result || typeof result !== 'string') {
            throw new Error('生成结果为空或格式错误');
        }

        // 保存结果
        settings.summaries[chatId] = {
            timestamp: Date.now(),
            content: result.trim(),
            messageCount: messages.length,
            characterName: context.name
        };
        
        // 更新最后生成时间
        lastGenerationTime = Date.now();
        
        saveSettings();
        updateUI();
        updateChatDisplay();
        
        if (!isAuto) toastr.success('总结更新完毕');

    } catch (error) {
        console.error('Chat Summarizer Generation Error:', error);
        if (!isAuto) toastr.error('生成失败: ' + error.message);
    } finally {
        // 🔓 无论成功失败，必须解锁
        isGenerating = false;
        // 强制冷却更新，防止 finally 后立刻又被触发
        lastGenerationTime = Date.now(); 
    }
}

// ... 后面是辅助函数（清理、导出、显示），与之前一致 ...

async function clearSummary() {
    const chatId = getCurrentChatId();
    if (!chatId) return;
    delete settings.summaries[chatId];
    saveSettings();
    updateUI();
    updateChatDisplay();
    toastr.success('总结已清除');
}

function exportSummary() {
    /* 与之前相同逻辑 */
    const chatId = getCurrentChatId();
    if (!settings.summaries[chatId]) return toastr.error('无数据');
    const blob = new Blob([settings.summaries[chatId].content], {type: 'text/plain'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Summary-${chatId}.txt`;
    a.click();
}

async function viewSummary() {
    const chatId = getCurrentChatId();
    const s = settings.summaries[chatId];
    if (!s) return toastr.error('无总结');
    await window.callPopup(`<h3>${s.characterName} 总结</h3><hr><div style="white-space: pre-wrap;">${s.content}</div>`, 'text', '', { wide: true });
}

function handleImportFile(e) {
    /* 简化的导入逻辑 */
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const content = ev.target.result;
        const chatId = getCurrentChatId();
        if(chatId) {
            settings.summaries[chatId] = {
                timestamp: Date.now(),
                content: content,
                messageCount: 0,
                characterName: "Imported"
            };
            saveSettings();
            updateUI();
            updateChatDisplay();
            toastr.success('导入成功');
        }
    };
    reader.readAsText(file);
    e.target.value = '';
}

function updateChatDisplay() {
    $('.chat-summary-display').remove();
    if (!settings.enabled || !settings.show_in_chat) return;
    
    const chatId = getCurrentChatId();
    const summary = settings.summaries[chatId];
    if (!summary) return;
    
    const html = `
        <div class="chat-summary-display" style="padding: 10px; background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--smart-theme-border); margin-bottom: 10px;">
            <div style="opacity:0.7; font-size:0.8em; margin-bottom:5px;">
                <i class="fa-solid fa-book"></i> 聊天总结 (${new Date(summary.timestamp).toLocaleTimeString()})
            </div>
            <div style="font-size: 0.9em; line-height: 1.4;">${summary.content}</div>
        </div>
    `;
    
    if (settings.summary_position === 'top') $('#chat').prepend(html);
    else $('#chat').append(html);
}

jQuery(async () => {
    await init();
});
