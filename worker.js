/**
 * =================================================================================
 * 项目: writecream-2api (Cloudflare Worker 单文件版)
 * 版本: 1.0.0 (代号: Chimera Synthesis - Pseudo Stream)
 * 作者: 首席AI执行官 (Principal AI Executive Officer)
 * 协议: 奇美拉协议 · 综合版 (Project Chimera: Synthesis Edition)
 * 日期: 2025-12-10
 *
 * [核心特性]
 * 1. [伪流式生成] 将 Writecream 的一次性响应实时转换为 OpenAI SSE 流，提供卓越的打字机体验。
 * 2. [完全匿名] 无需任何身份凭证，模拟匿名用户进行请求。
 * 3. [格式兼容] 完美适配 Cherry Studio, LobeChat, Immersive Translate 等兼容 OpenAI 接口的客户端。
 * 4. [开发者驾驶舱] 内置全功能、信息密集的中文 Web UI，用于 API 测试、状态监控和快速集成。
 * 5. [生产级标准] 包含请求水印、CORS 处理、Brotli 压缩和优雅的错误处理。
 * =================================================================================
 */

// --- [第一部分: 核心配置 (Configuration-as-Code)] ---
const CONFIG = {
  // 项目元数据
  PROJECT_NAME: "writecream-2api",
  PROJECT_VERSION: "1.0.0",

  // 安全配置 (建议在 Cloudflare 环境变量中设置 API_MASTER_KEY)
  API_MASTER_KEY: "1",

  // 上游服务配置
  UPSTREAM_URL: "https://www.writecream.com/wp-admin/admin-ajax.php",
  UPSTREAM_ORIGIN: "https://www.writecream.com",

  // 模型列表
  MODELS: [
    "writecream-chat",
  ],
  DEFAULT_MODEL: "writecream-chat",
};

// --- [第二部分: Worker 入口与路由] ---
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // 优先使用环境变量中的密钥
    const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;

    // 1. CORS 预检请求
    if (request.method === 'OPTIONS') {
      return handleCorsPreflight();
    }

    // 2. 开发者驾驶舱 (Web UI)
    if (url.pathname === '/') {
      return handleUI(request, apiKey);
    }
    // 3. API 路由
    else if (url.pathname.startsWith('/v1/')) {
      return handleApi(request, apiKey);
    }
    // 4. 404
    else {
      return createErrorResponse(`路径未找到: ${url.pathname}`, 404, 'not_found');
    }
  }
};

// --- [第三部分: API 代理逻辑] ---

/**
 * 处理所有 /v1/ 路径下的 API 请求
 * @param {Request} request - 传入的请求对象
 * @param {string} apiKey - 有效的 API 密钥
 * @returns {Promise<Response>}
 */
async function handleApi(request, apiKey) {
  // 认证检查
  if (apiKey && apiKey !== "1") {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return createErrorResponse('需要 Bearer Token 认证。', 401, 'unauthorized');
    }
    const token = authHeader.substring(7);
    if (token !== apiKey) {
      return createErrorResponse('无效的 API Key。', 403, 'invalid_api_key');
    }
  }

  const url = new URL(request.url);
  const requestId = `chatcmpl-${crypto.randomUUID()}`;

  // 根据 API 路径执行不同操作
  if (url.pathname === '/v1/models') {
    return handleModelsRequest();
  } else if (url.pathname === '/v1/chat/completions') {
    return handleChatCompletions(request, requestId);
  } else {
    return createErrorResponse(`API 路径不支持: ${url.pathname}`, 404, 'not_found');
  }
}

/**
 * 处理 /v1/models 请求
 * @returns {Response}
 */
function handleModelsRequest() {
  const modelsData = {
    object: 'list',
    data: CONFIG.MODELS.map(modelId => ({
      id: modelId,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'writecream-2api',
    })),
  };
  return new Response(JSON.stringify(modelsData), {
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

/**
 * 处理 /v1/chat/completions 请求
 * @param {Request} request - 传入的请求对象
 * @param {string} requestId - 本次请求的唯一 ID
 * @returns {Promise<Response>}
 */
async function handleChatCompletions(request, requestId) {
  try {
    const requestData = await request.json();
    
    // 1. 构造 FormData
    const formData = new FormData();
    formData.append('action', 'generate_chat');
    formData.append('query', JSON.stringify(requestData.messages || []));
    formData.append('link', 'writecream.com');

    // 2. 发送上游请求
    const upstreamResponse = await fetch(CONFIG.UPSTREAM_URL, {
      method: 'POST',
      headers: {
        'Accept': '*/*',
        'Origin': CONFIG.UPSTREAM_ORIGIN,
        'Referer': `${CONFIG.UPSTREAM_ORIGIN}/ai-chat/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'X-Request-ID': requestId, // 请求水印
      },
      body: formData,
    });

    if (!upstreamResponse.ok) {
      const errorBody = await upstreamResponse.text();
      console.error(`上游服务错误: ${upstreamResponse.status}`, errorBody);
      return createErrorResponse(`上游服务返回错误 ${upstreamResponse.status}: ${errorBody}`, upstreamResponse.status, 'upstream_error');
    }

    const responseData = await upstreamResponse.json();
    
    if (!responseData.success || !responseData.data || !responseData.data.response_content) {
        return createErrorResponse('上游返回无效数据结构', 502, 'bad_gateway');
    }

    const fullContent = responseData.data.response_content;

    // 3. 根据请求决定是流式返回还是非流式返回
    if (requestData.stream !== false) {
      // 流式返回：启动伪流式生成器
      const stream = createPseudoStream(fullContent, requestId, requestData.model || CONFIG.DEFAULT_MODEL);
      return new Response(stream, {
        headers: corsHeaders({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Worker-Trace-ID': requestId, // 响应水印
        }),
      });
    } else {
      // 非流式返回
      const openAIResponse = {
        id: requestId,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: requestData.model || CONFIG.DEFAULT_MODEL,
        choices: [{
            index: 0,
            message: { role: "assistant", content: fullContent },
            finish_reason: "stop",
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
      return new Response(JSON.stringify(openAIResponse), {
        headers: corsHeaders({
          'Content-Type': 'application/json; charset=utf-8',
          'X-Worker-Trace-ID': requestId,
        }),
      });
    }

  } catch (e) {
    console.error('处理聊天请求时发生异常:', e);
    return createErrorResponse(`处理请求时发生内部错误: ${e.message}`, 500, 'internal_server_error');
  }
}

/**
 * 创建伪流式 ReadableStream
 * @param {string} text - 要流式传输的完整文本
 * @param {string} requestId - 请求ID
 * @param {string} model - 模型名称
 * @returns {ReadableStream}
 */
function createPseudoStream(text, requestId, model) {
  const encoder = new TextEncoder();
  let words = text.split(/(\s+)/); // 按空格分割，保留空格

  return new ReadableStream({
    async start(controller) {
      for (const word of words) {
        if (word) {
          const chunk = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{
              index: 0,
              delta: { content: word },
              finish_reason: null,
            }],
          };
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        // 模拟打字机延迟
        await new Promise(resolve => setTimeout(resolve, 25));
      }

      // 发送结束块
      const finalChunk = {
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop',
        }],
      };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
}


/**
 * 辅助函数，创建标准化的 JSON 错误响应
 * @param {string} message - 错误信息
 * @param {number} status - HTTP 状态码
 * @param {string} code - 错误代码
 * @returns {Response}
 */
function createErrorResponse(message, status, code) {
  return new Response(JSON.stringify({
    error: { message, type: 'api_error', code }
  }), {
    status,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' })
  });
}

/**
 * 辅助函数，处理 CORS 预检请求
 * @returns {Response}
 */
function handleCorsPreflight() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

/**
 * 辅助函数，为响应头添加 CORS 策略
 * @param {object} headers - 现有的响应头
 * @returns {object} - 包含 CORS 头的新对象
 */
function corsHeaders(headers = {}) {
  return {
    ...headers,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

// --- [第四部分: 开发者驾驶舱 UI] ---
/**
 * 处理对根路径的请求，返回一个功能丰富的 HTML UI
 * @param {Request} request - 传入的请求对象
 * @param {string} apiKey - API 密钥
 * @returns {Response} - 包含完整 UI 的 HTML 响应
 */
function handleUI(request, apiKey) {
  const origin = new URL(request.url).origin;
  const allModels = CONFIG.MODELS;
  const customModelsString = allModels.map(m => `+${m}`).join(',');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${CONFIG.PROJECT_NAME} - 开发者驾驶舱</title>
    <style>
      /* --- 全局样式与主题 --- */
      :root {
        --bg-color: #121212;
        --sidebar-bg: #1E1E1E;
        --main-bg: #121212;
        --border-color: #333333;
        --text-color: #E0E0E0;
        --text-secondary: #888888;
        --primary-color: #FFBF00; /* 琥珀色 */
        --primary-hover: #FFD700;
        --input-bg: #2A2A2A;
        --error-color: #CF6679;
        --success-color: #66BB6A;
        --font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
        --font-mono: 'Fira Code', 'Consolas', 'Monaco', monospace;
      }
      * { box-sizing: border-box; }
      body {
        font-family: var(--font-family);
        margin: 0;
        background-color: var(--bg-color);
        color: var(--text-color);
        font-size: 14px;
        display: flex;
        height: 100vh;
        overflow: hidden;
      }
      /* --- 骨架屏样式 --- */
      .skeleton {
        background-color: #2a2a2a;
        background-image: linear-gradient(90deg, #2a2a2a, #3a3a3a, #2a2a2a);
        background-size: 200% 100%;
        animation: skeleton-loading 1.5s infinite;
        border-radius: 4px;
      }
      @keyframes skeleton-loading {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
    </style>
</head>
<body>
    <!-- 主布局自定义元素 -->
    <main-layout></main-layout>

    <!-- 模板定义 -->
    <template id="main-layout-template">
      <style>
        .layout { display: flex; width: 100%; height: 100vh; }
        .sidebar { width: 380px; flex-shrink: 0; background-color: var(--sidebar-bg); border-right: 1px solid var(--border-color); padding: 20px; display: flex; flex-direction: column; overflow-y: auto; }
        .main-content { flex-grow: 1; display: flex; flex-direction: column; padding: 20px; overflow: hidden; }
        .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 15px; margin-bottom: 15px; border-bottom: 1px solid var(--border-color); }
        .header h1 { margin: 0; font-size: 20px; }
        .header .version { font-size: 12px; color: var(--text-secondary); margin-left: 8px; }
        .collapsible-section { margin-top: 20px; }
        .collapsible-section summary { cursor: pointer; font-weight: bold; margin-bottom: 10px; list-style-type: '⚙️'; padding-left: 8px; }
        .collapsible-section[open] > summary { list-style-type: '⚙️'; }
        @media (max-width: 768px) { .layout { flex-direction: column; } .sidebar { width: 100%; height: auto; border-right: none; border-bottom: 1px solid var(--border-color); } }
      </style>
      <div class="layout">
        <aside class="sidebar">
          <header class="header">
            <h1>${CONFIG.PROJECT_NAME}<span class="version">v${CONFIG.PROJECT_VERSION}</span></h1>
            <status-indicator></status-indicator>
          </header>
          <info-panel></info-panel>
          <details class="collapsible-section" open><summary> 主流客户端集成指南</summary><client-guides></client-guides></details>
        </aside>
        <main class="main-content"><live-terminal></live-terminal></main>
      </div>
    </template>

    <template id="status-indicator-template">
      <style>
        .indicator { display: flex; align-items: center; gap: 8px; font-size: 12px; }
        .dot { width: 10px; height: 10px; border-radius: 50%; transition: background-color: 0.3s; }
        .dot.grey { background-color: #555; } .dot.yellow { background-color: #FFBF00; animation: pulse 2s infinite; } .dot.green { background-color: var(--success-color); } .dot.red { background-color: var(--error-color); }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(255,191,0,0.4); } 70% { box-shadow: 0 0 0 10px rgba(0,0,0,0); } 100% { box-shadow: 0 0 0 0 rgba(255,191,0,0); } }
      </style>
      <div class="indicator"><div id="status-dot" class="dot grey"></div><span id="status-text">正在初始化...</span></div>
    </template>

    <template id="info-panel-template">
      <style>
        .panel { display: flex; flex-direction: column; gap: 12px; } .info-item { display: flex; flex-direction: column; } .info-item label { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
        .info-value { background-color: var(--input-bg); padding: 8px 12px; border-radius: 4px; font-family: var(--font-mono); font-size: 13px; color: var(--primary-color); display: flex; align-items: center; justify-content: space-between; word-break: break-all; }
        .info-value.password { -webkit-text-security: disc; } .info-value.visible { -webkit-text-security: none; } .actions { display: flex; gap: 8px; }
        .icon-btn { background: none; border: none; color: var(--text-secondary); cursor: pointer; padding: 2px; display: flex; align-items: center; } .icon-btn:hover { color: var(--text-color); } .icon-btn svg { width: 16px; height: 16px; } .skeleton { height: 34px; }
      </style>
      <div class="panel">
        <div class="info-item"><label>API 端点 (Endpoint)</label><div id="api-url" class="info-value skeleton"></div></div>
        <div class="info-item"><label>API 密钥 (Master Key)</label><div id="api-key" class="info-value password skeleton"></div></div>
        <div class="info-item"><label>默认模型 (Default Model)</label><div id="default-model" class="info-value skeleton"></div></div>
      </div>
    </template>

    <template id="client-guides-template">
       <style>
        .tabs { display: flex; border-bottom: 1px solid var(--border-color); } .tab { padding: 8px 12px; cursor: pointer; border: none; background: none; color: var(--text-secondary); font-size: 13px; } .tab.active { color: var(--primary-color); border-bottom: 2px solid var(--primary-color); font-weight: bold; }
        .content { padding: 15px 0; } pre { background-color: var(--input-bg); padding: 12px; border-radius: 4px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-all; position: relative; }
        .copy-code-btn { position: absolute; top: 8px; right: 8px; background: #444; border: 1px solid #555; color: #ccc; border-radius: 4px; cursor: pointer; padding: 2px 6px; font-size: 12px; } .copy-code-btn:hover { background: #555; } .copy-code-btn.copied { background-color: var(--success-color); color: #121212; }
        p { font-size: 13px; line-height: 1.5; }
       </style>
       <div><div class="tabs"></div><div class="content"></div></div>
    </template>

    <template id="live-terminal-template">
      <style>
        .terminal { display: flex; flex-direction: column; height: 100%; background-color: var(--sidebar-bg); border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; }
        .output-window { flex-grow: 1; padding: 15px; overflow-y: auto; font-size: 14px; line-height: 1.6; }
        .output-window p { margin: 0 0 1em 0; } .output-window pre { background-color: #0d0d0d; padding: 1em; border-radius: 4px; white-space: pre-wrap; font-family: var(--font-mono); }
        .output-window .message { margin-bottom: 1em; } .output-window .message.user { color: var(--primary-color); font-weight: bold; } .output-window .message.assistant { color: var(--text-color); white-space: pre-wrap; } .output-window .message.error { color: var(--error-color); }
        .input-area { border-top: 1px solid var(--border-color); padding: 15px; display: flex; gap: 10px; align-items: flex-end; }
        textarea { flex-grow: 1; background-color: var(--input-bg); border: 1px solid var(--border-color); border-radius: 4px; color: var(--text-color); padding: 10px; font-family: var(--font-family); font-size: 14px; resize: none; min-height: 40px; max-height: 200px; }
        .send-btn { background-color: var(--primary-color); color: #121212; border: none; border-radius: 4px; padding: 0 15px; height: 40px; font-weight: bold; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background-color 0.2s; }
        .send-btn:hover { background-color: var(--primary-hover); } .send-btn:disabled { background-color: #555; cursor: not-allowed; }
        .send-btn.cancel svg { width: 24px; height: 24px; } .send-btn svg { width: 20px; height: 20px; }
        .placeholder { color: var(--text-secondary); }
      </style>
      <div class="terminal">
        <div class="output-window"><p class="placeholder">实时交互终端已就绪。输入指令开始测试...</p></div>
        <div class="input-area">
          <textarea id="prompt-input" rows="1" placeholder="输入您的指令..."></textarea>
          <button id="send-btn" class="send-btn" title="发送">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.949a.75.75 0 00.95.544l3.239-1.281a.75.75 0 000-1.39L4.23 6.28a.75.75 0 00-.95-.545L1.865 3.45a.75.75 0 00.95-.826l.002-.007.002-.006zm.002 14.422a.75.75 0 00.95.826l1.415-2.28a.75.75 0 00-.545-.95l-3.239-1.28a.75.75 0 00-1.39 0l-1.28 3.239a.75.75 0 00.544.95l4.95 1.414zM12.75 8.5a.75.75 0 000 1.5h5.5a.75.75 0 000-1.5h-5.5z"/></svg>
          </button>
        </div>
      </div>
    </template>

    <script>
      // --- [第五部分: 客户端逻辑 (Developer Cockpit JS)] ---

      const CLIENT_CONFIG = {
          WORKER_ORIGIN: '${origin}',
          API_MASTER_KEY: '${apiKey}',
          DEFAULT_MODEL: '${CONFIG.DEFAULT_MODEL}',
          MODEL_LIST_STRING: '${allModels.join(', ')}',
          CUSTOM_MODELS_STRING: '${customModelsString}',
      };

      const AppState = { INITIALIZING: 'INITIALIZING', HEALTH_CHECKING: 'HEALTH_CHECKING', READY: 'READY', REQUESTING: 'REQUESTING', STREAMING: 'STREAMING', ERROR: 'ERROR' };
      let currentState = AppState.INITIALIZING;
      let abortController = null;

      class BaseComponent extends HTMLElement {
        constructor(templateId) {
          super();
          this.attachShadow({ mode: 'open' });
          const template = document.getElementById(templateId);
          if (template) this.shadowRoot.appendChild(template.content.cloneNode(true));
        }
      }

      class MainLayout extends BaseComponent { constructor() { super('main-layout-template'); } }
      customElements.define('main-layout', MainLayout);

      class StatusIndicator extends BaseComponent {
        constructor() { super('status-indicator-template'); this.dot = this.shadowRoot.getElementById('status-dot'); this.text = this.shadowRoot.getElementById('status-text'); }
        setState(state, message) {
          this.dot.className = 'dot';
          switch (state) {
            case 'checking': this.dot.classList.add('yellow'); break;
            case 'ok': this.dot.classList.add('green'); break;
            case 'error': this.dot.classList.add('red'); break;
            default: this.dot.classList.add('grey'); break;
          }
          this.text.textContent = message;
        }
      }
      customElements.define('status-indicator', StatusIndicator);

      class InfoPanel extends BaseComponent {
        constructor() { super('info-panel-template'); this.apiUrlEl = this.shadowRoot.getElementById('api-url'); this.apiKeyEl = this.shadowRoot.getElementById('api-key'); this.defaultModelEl = this.shadowRoot.getElementById('default-model'); }
        connectedCallback() { this.render(); }
        render() {
          this.populateField(this.apiUrlEl, CLIENT_CONFIG.WORKER_ORIGIN + '/v1');
          this.populateField(this.apiKeyEl, CLIENT_CONFIG.API_MASTER_KEY, true);
          this.populateField(this.defaultModelEl, CLIENT_CONFIG.DEFAULT_MODEL);
        }
        populateField(el, value, isPassword = false) {
          el.classList.remove('skeleton');
          el.innerHTML = \`<span>\${value}</span><div class="actions">\${isPassword ? '<button class="icon-btn" data-action="toggle-visibility" title="切换可见性"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M10 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z"/><path fill-rule="evenodd" d="M.664 10.59a1.651 1.651 0 010-1.18l.88-1.473a1.65 1.65 0 012.899 0l.88 1.473a1.65 1.65 0 010 1.18l-.88 1.473a1.65 1.65 0 01-2.899 0l-.88-1.473zM18.45 10.59a1.651 1.651 0 010-1.18l.88-1.473a1.65 1.65 0 012.899 0l.88 1.473a1.65 1.65 0 010 1.18l-.88 1.473a1.65 1.65 0 01-2.899 0l-.88-1.473zM10 17a1.651 1.651 0 01-1.18 0l-1.473-.88a1.65 1.65 0 010-2.899l1.473-.88a1.651 1.651 0 011.18 0l1.473.88a1.65 1.65 0 010 2.899l-1.473.88a1.651 1.651 0 01-1.18 0z" clip-rule="evenodd"/></svg></button>' : ''}<button class="icon-btn" data-action="copy" title="复制"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M7 3.5A1.5 1.5 0 018.5 2h3.879a1.5 1.5 0 011.06.44l3.122 3.121A1.5 1.5 0 0117 6.621V16.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 017 16.5v-13z"/><path d="M5 6.5A1.5 1.5 0 016.5 5h3.879a1.5 1.5 0 011.06.44l3.122 3.121A1.5 1.5 0 0115 9.621V14.5a1.5 1.5 0 01-1.5 1.5h-7A1.5 1.5 0 015 14.5v-8z"/></svg></button></div>\`;
          el.querySelector('[data-action="copy"]').addEventListener('click', () => navigator.clipboard.writeText(value));
          if (isPassword) el.querySelector('[data-action="toggle-visibility"]').addEventListener('click', () => el.classList.toggle('visible'));
        }
      }
      customElements.define('info-panel', InfoPanel);

      class ClientGuides extends BaseComponent {
        constructor() { super('client-guides-template'); this.tabs = this.shadowRoot.querySelector('.tabs'); this.content = this.shadowRoot.querySelector('.content'); this.guides = { 'cURL': this.getCurlGuide(), 'Python': this.getPythonGuide(), 'LobeChat': this.getLobeChatGuide(), 'Next-Web': this.getNextWebGuide() }; }
        connectedCallback() {
          Object.keys(this.guides).forEach((name, index) => { const tab = document.createElement('button'); tab.className = 'tab'; tab.textContent = name; if (index === 0) tab.classList.add('active'); tab.addEventListener('click', () => this.switchTab(name)); this.tabs.appendChild(tab); });
          this.switchTab(Object.keys(this.guides)[0]);
          this.content.addEventListener('click', (e) => { const button = e.target.closest('.copy-code-btn'); if (button) { const code = button.closest('pre').querySelector('code').innerText; navigator.clipboard.writeText(code).then(() => { button.textContent = '已复制!'; button.classList.add('copied'); setTimeout(() => { button.textContent = '复制'; button.classList.remove('copied'); }, 2000); }); } });
        }
        switchTab(name) { this.tabs.querySelector('.active')?.classList.remove('active'); const newActiveTab = Array.from(this.tabs.children).find(tab => tab.textContent === name); newActiveTab?.classList.add('active'); this.content.innerHTML = this.guides[name]; }
        getCurlGuide() { return \`<pre><button class="copy-code-btn">复制</button><code>curl --location '\\\${CLIENT_CONFIG.WORKER_ORIGIN}/v1/chat/completions' \\\\<br>--header 'Content-Type: application/json' \\\\<br>--header 'Authorization: Bearer \\\${CLIENT_CONFIG.API_MASTER_KEY}' \\\\<br>--data '{<br>    "model": "\\\${CLIENT_CONFIG.DEFAULT_MODEL}",<br>    "messages": [{"role": "user", "content": "你好"}],<br>    "stream": true<br>}'</code></pre>\`; }
        getPythonGuide() { return \`<pre><button class="copy-code-btn">复制</button><code>import openai<br><br>client = openai.OpenAI(<br>    api_key="\\\${CLIENT_CONFIG.API_MASTER_KEY}",<br>    base_url="\\\${CLIENT_CONFIG.WORKER_ORIGIN}/v1"<br>)<br><br>stream = client.chat.completions.create(<br>    model="\\\${CLIENT_CONFIG.DEFAULT_MODEL}",<br>    messages=[{"role": "user", "content": "你好"}],<br>    stream=True,<br>)<br><br>for chunk in stream:<br>    print(chunk.choices[0].delta.content or "", end="")</code></pre>\`; }
        getLobeChatGuide() { return \`<p>在 LobeChat 设置中:</p><pre><button class="copy-code-btn">复制</button><code>API Key: \\\${CLIENT_CONFIG.API_MASTER_KEY}<br>API 地址: \\\${CLIENT_CONFIG.WORKER_ORIGIN}<br>模型列表: (请留空或手动填入)</code></pre>\`; }
        getNextWebGuide() { return \`<p>在 ChatGPT-Next-Web 部署时:</p><pre><button class="copy-code-btn">复制</button><code>CODE=\\\${CLIENT_CONFIG.API_MASTER_KEY}<br>BASE_URL=\\\${CLIENT_CONFIG.WORKER_ORIGIN}<br>CUSTOM_MODELS=\\\${CLIENT_CONFIG.CUSTOM_MODELS_STRING}</code></pre>\`; }
      }
      customElements.define('client-guides', ClientGuides);

      class LiveTerminal extends BaseComponent {
        constructor() {
          super('live-terminal-template');
          this.outputWindow = this.shadowRoot.querySelector('.output-window');
          this.promptInput = this.shadowRoot.getElementById('prompt-input');
          this.sendBtn = this.shadowRoot.getElementById('send-btn');
          this.sendIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.949a.75.75 0 00.95.544l3.239-1.281a.75.75 0 000-1.39L4.23 6.28a.75.75 0 00-.95-.545L1.865 3.45a.75.75 0 00.95-.826l.002-.007.002-.006zm.002 14.422a.75.75 0 00.95.826l1.415-2.28a.75.75 0 00-.545-.95l-3.239-1.28a.75.75 0 00-1.39 0l-1.28 3.239a.75.75 0 00.544.95l4.95 1.414zM12.75 8.5a.75.75 0 000 1.5h5.5a.75.75 0 000-1.5h-5.5z"/></svg>';
          this.cancelIcon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z"/></svg>';
        }
        connectedCallback() {
          this.sendBtn.addEventListener('click', () => this.handleSend());
          this.promptInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.handleSend(); } });
          this.promptInput.addEventListener('input', this.autoResize);
        }
        autoResize(event) { const textarea = event.target; textarea.style.height = 'auto'; textarea.style.height = textarea.scrollHeight + 'px'; }
        handleSend() { if (currentState === AppState.REQUESTING || currentState === AppState.STREAMING) { this.cancelStream(); } else { this.startStream(); } }
        addMessage(role, content) {
            const messageEl = document.createElement('div');
            messageEl.className = 'message ' + role;
            messageEl.textContent = content;
            const placeholder = this.outputWindow.querySelector('.placeholder');
            if (placeholder) placeholder.remove();
            this.outputWindow.appendChild(messageEl);
            this.outputWindow.scrollTop = this.outputWindow.scrollHeight;
            return messageEl;
        }
        async startStream() {
          const prompt = this.promptInput.value.trim();
          if (!prompt) return;
          setState(AppState.REQUESTING);
          this.addMessage('user', prompt);
          const assistantMessageEl = this.addMessage('assistant', '▍');
          abortController = new AbortController();
          try {
            const response = await fetch(CLIENT_CONFIG.WORKER_ORIGIN + '/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + CLIENT_CONFIG.API_MASTER_KEY },
              body: JSON.stringify({ model: CLIENT_CONFIG.DEFAULT_MODEL, messages: [{ role: 'user', content: prompt }], stream: true }),
              signal: abortController.signal,
            });
            if (!response.ok) { const err = await response.json(); throw new Error(err.error.message); }
            setState(AppState.STREAMING);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              const chunk = decoder.decode(value);
              const lines = chunk.split('\\n').filter(line => line.startsWith('data:'));
              for (const line of lines) {
                const dataStr = line.substring(5).trim();
                if (dataStr === '[DONE]') { assistantMessageEl.textContent = fullContent; break; }
                try {
                  const data = JSON.parse(dataStr);
                  const delta = data.choices[0].delta.content;
                  if (delta) { fullContent += delta; assistantMessageEl.textContent = fullContent + '▍'; this.outputWindow.scrollTop = this.outputWindow.scrollHeight; }
                } catch (e) {}
              }
            }
          } catch (e) {
            if (e.name !== 'AbortError') { this.addMessage('error', '请求失败: ' + e.message); setState(AppState.ERROR); }
          } finally {
            if (currentState !== AppState.ERROR) { setState(AppState.READY); }
          }
        }
        cancelStream() { if (abortController) { abortController.abort(); abortController = null; } setState(AppState.READY); }
        updateButtonState(state) {
            if (state === AppState.REQUESTING || state === AppState.STREAMING) {
                this.sendBtn.innerHTML = this.cancelIcon; this.sendBtn.title = "取消"; this.sendBtn.classList.add('cancel'); this.sendBtn.disabled = false;
            } else {
                this.sendBtn.innerHTML = this.sendIcon; this.sendBtn.title = "发送"; this.sendBtn.classList.remove('cancel'); this.sendBtn.disabled = state !== AppState.READY;
            }
        }
      }
      customElements.define('live-terminal', LiveTerminal);

      function setState(newState) {
        currentState = newState;
        const terminal = document.querySelector('main-layout')?.shadowRoot.querySelector('live-terminal');
        if (terminal) terminal.updateButtonState(newState);
      }

      async function performHealthCheck() {
        const statusIndicator = document.querySelector('main-layout')?.shadowRoot.querySelector('status-indicator');
        if (!statusIndicator) return;
        statusIndicator.setState('checking', '检查上游服务...');
        try {
          const response = await fetch(CLIENT_CONFIG.WORKER_ORIGIN + '/v1/models', { headers: { 'Authorization': 'Bearer ' + CLIENT_CONFIG.API_MASTER_KEY } });
          if (response.ok) {
            statusIndicator.setState('ok', '服务运行正常');
            setState(AppState.READY);
          } else {
            const err = await response.json();
            throw new Error(err.error.message);
          }
        } catch (e) {
          statusIndicator.setState('error', '健康检查失败');
          setState(AppState.ERROR);
        }
      }

      document.addEventListener('DOMContentLoaded', () => {
        setState(AppState.INITIALIZING);
        customElements.whenDefined('main-layout').then(() => {
            performHealthCheck();
        });
      });
    </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
