/**
 * ST Chat Summarizer - 安全防爆版
 * 
 * 1. 默认禁用自动总结，防止死循环
 * 2. 移除所有 ES6 Import 依赖，改用 window 全局变量，彻底解决 404 问题
 */

const MODULE_NAME = 'chat-summarizer';

// 默认设置：全部关闭，防止启动即炸
const defaultSettings = {
    enabled: false,           // 默认为关！
    auto_summarize: false,    // 默认为关！
    summarize_interval: 20,
    batch_size: 50,
    summary_prompt: `请总结以下对话内容:\n\n{{messages}}\n\n请用简洁的语言总结核心内容。`,
    show_in_chat: true,
    summary_position: 'top',
    summaries: {}
};

let settings = { ...defaultSettings };
let isGenerating = false;
let lastGenerationTime = 0;

/**
 * 核心工具：获取全局变量
 * 避免 import 路径错误导致的 404
 */
const getST = () => {
    // 兼容不同版本的酒馆全局对象
    return {
        eventSource: window.eventSource,
        event_types: window.event_types,
        saveSettingsDebounced: window.saveSettingsDebounced,
        getCurrentChatId: window.getCurrentChatId,
        generateQuiet: window.generateQuiet || (window.SillyTavern && window.SillyTavern.generation && window.SillyTavern.generation.generateQuiet),
        getContext: window.getContext,
        extension_settings: window.extension_settings,
        renderExtensionTemplateAsync: window.renderExtensionTemplateAsync,
        callPopup: window.callPopup,
        jQuery: window.jQuery || window.$
    };
};

async function init() {
    const st = getST();
    if (!st.eventSource) {
        console.error('Chat Summarizer: 这里的酒馆版本太老或未加载完成，无法启动。');
        return;
    }

    try {
        // 1. 加载配置
        if (!st.extension_settings[MODULE_NAME]) {
            st.extension_settings[MODULE_NAME] = defaultSettings;
        }
        Object.assign(settings, st.extension_settings[MODULE_NAME]);
        
        // ⚠️ 强制覆盖：如果是刚刚崩溃重启，强制把自动开关关掉，让你能进得去界面
        // 如果你需要自动功能，请在界面加载正常后手动勾选
        // settings.enabled = false; 
        
        // 2. 加载界面
        const template = await st.renderExtensionTemplateAsync('third-party/Chat-Summarizer', 'settings');
        st.jQuery('#extensions_settings2').append(template);
        
        // 3. 绑定事件
        setupEventListeners(st);
        
        // 4. 注册核心监听
        // 使用去抖动保护
        st.eventSource.on(st.event_types.MESSAGE_RECEIVED, () => tryAutoSummarize(st));
        st.eventSource.on(st.event_types.CHAT_CHANGED, () => {
            updateUI(st);
            updateChatDisplay(st);
        });
        
        console.log('✅ Chat Summarizer (Safe Mode) Loaded');
        toastr.success('聊天总结器已加载 (安全模式)');

    } catch (error) {
        console.error('Chat Summarizer Init Error:', error);
    }
}

function setupEventListeners(st) {
    const $ = st.jQuery;
    
    // 开关逻辑
    $('#summarizer_enabled').prop('checked', settings.enabled).on('change', function() {
        settings.enabled = $(this).prop('checked');
        saveSettings(st);
        updateUI(st);
    });
    
    $('#summarizer_auto').prop('checked', settings.auto_summarize).on('change', function() {
        settings.auto_summarize = $(this).prop('checked');
        saveSettings(st);
    });

    // 各种输入框
    $('#summarizer_interval').val(settings.summarize_interval).on('input', function() {
        settings.summarize_interval = parseInt($(this).val());
        $('#summarizer_interval_value').text(settings.summarize_interval);
        saveSettings(st);
    });
    
    $('#summarizer_prompt').val(settings.summary_prompt).on('input', function() { 
        settings.summary_prompt = $(this).val(); 
        saveSettings(st); 
    });
    
    $('#summarizer_show_in_chat').prop('checked', settings.show_in_chat).on('change', function() { 
        settings.show_in_chat = $(this).prop('checked'); 
        saveSettings(st); 
        updateChatDisplay(st); 
    });

    // 按钮功能
    $('#summarizer_generate').off('click').on('click', () => runGeneration(st, false)); // 手动触发
    
    $('#summarizer_clear').off('click').on('click', async () => {
        const chatId = st.getCurrentChatId();
        if (chatId) {
            delete settings.summaries[chatId];
            saveSettings(st);
            updateUI(st);
            updateChatDisplay(st);
            toastr.success('已清除');
        }
    });

    updateUI(st);
}

function saveSettings(st) {
    Object.assign(st.extension_settings[MODULE_NAME], settings);
    st.saveSettingsDebounced();
}

function updateUI(st) {
    const $ = st.jQuery;
    const enabled = settings.enabled;
    $('#summarizer_controls').toggle(enabled);
    
    const chatId = st.getCurrentChatId();
    const hasSummary = chatId && settings.summaries[chatId];
    
    if (hasSummary) {
        $('#summarizer_status').text(`已有总结 (${new Date(settings.summaries[chatId].timestamp).toLocaleTimeString()})`);
        $('#summarizer_view').show();
        $('#summarizer_clear').show();
    } else {
        $('#summarizer_status').text('暂无总结');
        $('#summarizer_view').hide();
        $('#summarizer_clear').hide();
    }
}

/**
 * 尝试自动总结 - 带有极其严格的防护锁
 */
async function tryAutoSummarize(st) {
    // 1. 全局开关检查
    if (!settings.enabled || !settings.auto_summarize) return;
    
    // 2. 正在生成锁
    if (isGenerating) return;

    // 3. 冷却时间锁 (10秒内禁止连续触发)
    const now = Date.now();
    if (now - lastGenerationTime < 10000) return;

    try {
        const context = st.getContext();
        const chatId = st.getCurrentChatId();
        
        if (!chatId || !context.chat) return;

        const summaryData = settings.summaries[chatId];
        const lastCount = summaryData ? summaryData.messageCount : 0;
        const currentCount = context.chat.length;

        // 只有当消息真正增加超过间隔时才触发
        if (currentCount - lastCount >= settings.summarize_interval) {
            console.log(`[Summarizer] Auto-triggering: ${currentCount} msgs (Last: ${lastCount})`);
            await runGeneration(st, true);
        }
    } catch (e) {
        console.warn('Auto summarize check failed:', e);
    }
}

/**
 * 执行生成逻辑
 */
async function runGeneration(st, isAuto) {
    if (isGenerating) return;
    
    // 获取生成函数
    const generateFn = st.generateQuiet;
    if (typeof generateFn !== 'function') {
        toastr.error('错误: 找不到生成函数 (generateQuiet)');
        return;
    }

    const context = st.getContext();
    const chatId = st.getCurrentChatId();
    
    if (!chatId || !context.chat || context.chat.length === 0) {
        if (!isAuto) toastr.info('没有聊天内容');
        return;
    }

    try {
        isGenerating = true;
        if (!isAuto) toastr.info('正在生成总结...请勿操作');

        // 准备提示词
        // 简单处理：取最后N条消息，或者全部消息
        const limit = 50; // 限制一次只看最近50条，防止爆内存
        const messages = context.chat
            .slice(-limit) 
            .filter(m => !m.is_system)
            .map(m => `${m.is_user ? 'User' : (m.name||'Char')}: ${m.mes}`)
            .join('\n');

        let prompt = settings.summary_prompt.replace('{{messages}}', messages);

        // 🔥 执行生成
        console.log('[Summarizer] Sending prompt...');
        const result = await generateFn(prompt);
        console.log('[Summarizer] Result received');

        if (result) {
            settings.summaries[chatId] = {
                timestamp: Date.now(),
                content: result,
                messageCount: context.chat.length,
                characterName: context.name
            };
            
            saveSettings(st);
            updateUI(st);
            updateChatDisplay(st);
            if (!isAuto) toastr.success('总结更新成功!');
        }

    } catch (err) {
        console.error('Generation Failed:', err);
        if (!isAuto) toastr.error('生成失败: ' + err.message);
    } finally {
        isGenerating = false;
        lastGenerationTime = Date.now(); // 只有完成生成后才更新时间戳
    }
}

function updateChatDisplay(st) {
    const $ = st.jQuery;
    $('.chat-summary-display').remove(); // 先清除旧的
    
    if (!settings.enabled || !settings.show_in_chat) return;
    
    const chatId = st.getCurrentChatId();
    const summary = settings.summaries[chatId];
    
    if (!summary) return;

    // 简单的显示 HTML，避免复杂的 CSS 选择器导致 Inspector 报错
    const html = `
        <div class="chat-summary-display" style="
            margin: 10px 0; 
            padding: 10px; 
            background: rgba(0,0,0,0.3); 
            border: 1px solid var(--SmartThemeBorderColor);
            border-radius: 5px;
            font-size: 0.9em;">
            <strong style="color: var(--SmartThemeQuoteColor);">📝 聊天总结:</strong>
            <div style="margin-top:5px; white-space: pre-wrap;">${summary.content}</div>
        </div>
    `;

    if (settings.summary_position === 'top') {
        $('#chat').prepend(html);
    } else {
        $('#chat').append(html);
    }
}

// 启动
(function() {
    const st = getST();
    if (st.jQuery) {
        st.jQuery(document).ready(() => init());
    } else {
        setTimeout(() => init(), 2000); // 备用延迟启动
    }
})();
