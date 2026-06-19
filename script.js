/**
 * NexusChat — script.js
 * Production-quality vanilla JS AI chatbot frontend.
 *
 * SECURITY NOTE:
 * ──────────────
 * Storing an API key in frontend JavaScript is insecure. Anyone with
 * DevTools can read window/localStorage and extract your key. In production:
 *   1. Create a backend proxy endpoint (e.g. /api/chat).
 *   2. Store the API key in a server-side environment variable.
 *   3. The frontend sends messages to YOUR backend — never to OpenRouter directly.
 *   4. Authenticate users to your backend via session tokens or OAuth.
 *   5. Apply rate-limiting and abuse detection at the proxy layer.
 * This implementation is intentionally kept client-side for learning purposes.
 */

'use strict';

/* ──────────────────────────────────────────────────────────────
   CONFIGURATION — paste your OpenRouter API key below
────────────────────────────────────────────────────────────── */
const DEFAULT_CONFIG = {
  OPENROUTER_API_KEY: 'PASTE_YOUR_KEY_HERE', // ← replace this
  MODEL: 'openai/gpt-4o-mini',
  SYSTEM_PROMPT: 'You are a helpful, concise, and knowledgeable AI assistant.',
  TEMPERATURE: 0.7,
  MAX_TOKENS: 1024,
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 1200,
  REQUEST_TIMEOUT_MS: 45000,
  MAX_CONTEXT_MESSAGES: 40,
};

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const STORAGE_KEY_PREFIX  = 'nexuschat_';
const MODEL_LABELS = {
  'openai/gpt-4o-mini':                  'GPT-4o Mini',
  'openai/gpt-4o':                        'GPT-4o',
  'anthropic/claude-3.5-sonnet':          'Claude 3.5 Sonnet',
  'anthropic/claude-3-haiku':             'Claude 3 Haiku',
  'google/gemini-pro-1.5':               'Gemini Pro 1.5',
  'meta-llama/llama-3.1-70b-instruct':   'Llama 3.1 70B',
};

/* ──────────────────────────────────────────────────────────────
   STATE
────────────────────────────────────────────────────────────── */
let state = {
  config: { ...DEFAULT_CONFIG },
  conversations: [],       // [{ id, title, messages: [], createdAt, updatedAt }]
  activeConversationId: null,
  isLoading: false,
  abortController: null,
  theme: 'dark',
  sidebarCollapsed: false,
};

/* Shorthand DOM accessors */
const $ = id => document.getElementById(id);

/* ──────────────────────────────────────────────────────────────
   DOM REFERENCES
────────────────────────────────────────────────────────────── */
const DOM = {
  app:                  $('app'),
  sidebar:              $('sidebar'),
  sidebarOverlay:       $('sidebar-overlay'),
  sidebarToggleBtn:     $('sidebar-toggle-btn'),
  sidebarCollapseBtn:   $('sidebar-collapse-btn'),
  newChatBtn:           $('new-chat-btn'),
  conversationList:     $('conversation-list'),
  themToggleBtn:        $('theme-toggle-btn'),
  exportTxtBtn:         $('export-txt-btn'),
  exportJsonBtn:        $('export-json-btn'),
  settingsBtn:          $('settings-btn'),
  currentModelBadge:    $('current-model-badge'),
  clearChatBtn:         $('clear-chat-btn'),
  chatArea:             $('chat-area'),
  welcomeScreen:        $('welcome-screen'),
  messagesContainer:    $('messages-container'),
  typingIndicator:      $('typing-indicator'),
  messageInput:         $('message-input'),
  charCounter:          $('char-counter'),
  sendBtn:              $('send-btn'),
  statTotal:            $('stat-total'),
  statUser:             $('stat-user'),
  statAi:               $('stat-ai'),
  settingsModal:        $('settings-modal'),
  closeSettingsBtn:     $('close-settings-btn'),
  cancelSettingsBtn:    $('cancel-settings-btn'),
  saveSettingsBtn:      $('save-settings-btn'),
  apiKeyInput:          $('api-key-input'),
  toggleKeyVisibility:  $('toggle-key-visibility'),
  modelSelect:          $('model-select'),
  systemPromptInput:    $('system-prompt-input'),
  tempSlider:           $('temp-slider'),
  tempValue:            $('temp-value'),
  maxTokensInput:       $('max-tokens-input'),
  toastContainer:       $('toast-container'),
  iconMoon:             document.querySelector('.icon-moon'),
  iconSun:              document.querySelector('.icon-sun'),
};

/* ──────────────────────────────────────────────────────────────
   PERSISTENCE
────────────────────────────────────────────────────────────── */
const Storage = {
  get(key, fallback = null) {
    try { const v = localStorage.getItem(STORAGE_KEY_PREFIX + key); return v !== null ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(STORAGE_KEY_PREFIX + key, JSON.stringify(value)); }
    catch (e) { console.warn('localStorage write failed:', e); }
  },
  remove(key) {
    try { localStorage.removeItem(STORAGE_KEY_PREFIX + key); }
    catch {}
  },
};

function loadPersistedState() {
  const savedConfig = Storage.get('config', {});
  state.config = { ...DEFAULT_CONFIG, ...savedConfig };

  state.conversations = Storage.get('conversations', []);
  state.activeConversationId = Storage.get('activeConversationId', null);
  state.theme = Storage.get('theme', 'dark');

  // Validate active conversation still exists
  if (state.activeConversationId && !state.conversations.find(c => c.id === state.activeConversationId)) {
    state.activeConversationId = state.conversations[0]?.id ?? null;
  }
}

function persistConversations() {
  Storage.set('conversations', state.conversations);
  Storage.set('activeConversationId', state.activeConversationId);
}

function persistConfig() {
  Storage.set('config', state.config);
}

/* ──────────────────────────────────────────────────────────────
   THEME
────────────────────────────────────────────────────────────── */
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  Storage.set('theme', theme);
  const isDark = theme === 'dark';
  DOM.iconMoon.style.display = isDark ? 'block' : 'none';
  DOM.iconSun.style.display  = isDark ? 'none'  : 'block';
}

/* ──────────────────────────────────────────────────────────────
   CONVERSATION MANAGEMENT
────────────────────────────────────────────────────────────── */
function generateId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function createConversation() {
  const conv = {
    id: generateId(),
    title: 'New Chat',
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.conversations.unshift(conv);
  return conv;
}

function getActiveConversation() {
  return state.conversations.find(c => c.id === state.activeConversationId) ?? null;
}

function setActiveConversation(id) {
  state.activeConversationId = id;
  Storage.set('activeConversationId', id);
  renderMessages();
  renderConversationList();
  updateStats();
  updateWelcomeVisibility();
}

function deleteConversation(id) {
  state.conversations = state.conversations.filter(c => c.id !== id);
  if (state.activeConversationId === id) {
    state.activeConversationId = state.conversations[0]?.id ?? null;
    if (!state.activeConversationId) {
      const fresh = createConversation();
      state.activeConversationId = fresh.id;
    }
  }
  persistConversations();
  renderConversationList();
  renderMessages();
  updateStats();
  updateWelcomeVisibility();
}

function autoTitleConversation(conv, firstUserMessage) {
  if (conv.title !== 'New Chat') return;
  const trimmed = firstUserMessage.trim();
  conv.title = trimmed.length > 42 ? trimmed.slice(0, 42) + '…' : trimmed;
}

/* ──────────────────────────────────────────────────────────────
   MARKDOWN PARSER (lightweight, no dependencies)
────────────────────────────────────────────────────────────── */
function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const SYNTAX_RULES = [
  // Python / JS keywords
  { regex: /\b(def|class|return|import|from|as|if|elif|else|for|while|in|not|and|or|is|None|True|False|pass|break|continue|try|except|finally|with|yield|lambda|del|global|nonlocal|raise|assert)\b/g, cls: 'tok-keyword' },
  { regex: /\b(const|let|var|function|async|await|new|this|typeof|instanceof|void|delete|throw|catch|switch|case|default|export|import)\b/g, cls: 'tok-keyword' },
  // Strings
  { regex: /(["'`])(?:(?!\1)[^\\]|\\.)*?\1/g, cls: 'tok-string' },
  // Comments
  { regex: /(\/\/[^\n]*)|(#[^\n]*)/g, cls: 'tok-comment' },
  // Numbers
  { regex: /\b(\d+\.?\d*)\b/g, cls: 'tok-number' },
  // Functions calls
  { regex: /\b([a-zA-Z_]\w*)\s*(?=\()/g, cls: 'tok-function' },
];

function applySyntaxHighlight(code, lang) {
  let html = escapeHtml(code);
  // Only highlight known languages to avoid over-coloring plain text
  const codeLangs = ['js','javascript','ts','typescript','py','python','bash','sh','css','html','json','jsx','tsx','rust','go','java','c','cpp','ruby','php'];
  if (!codeLangs.includes((lang || '').toLowerCase())) return html;
  SYNTAX_RULES.forEach(({ regex, cls }) => {
    html = html.replace(regex, m => `<span class="${cls}">${m}</span>`);
  });
  return html;
}

function renderMarkdown(text) {
  if (!text) return '';
  let html = escapeHtml(text);

  // Fenced code blocks ```lang\n...\n```
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const id = 'cb_' + generateId();
    const highlighted = applySyntaxHighlight(code.trim(), lang);
    return `<pre data-code-id="${id}"><div class="code-block-header"><span>${lang || 'code'}</span><button class="code-copy-btn" onclick="copyCode('${id}')">Copy</button></div><code id="${id}">${highlighted}</code></pre>`;
  });

  // Inline code `...`
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold **...**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic *...*
  html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');

  // Heading ### ## #
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Unordered lists
  html = html.replace(/((?:^[ \t]*[-*+] .+\n?)+)/gm, match => {
    const items = match.trim().split('\n').map(l => `<li>${l.replace(/^[ \t]*[-*+] /, '')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, match => {
    const items = match.trim().split('\n').map(l => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Paragraphs — split on double newlines, wrap non-block-elements
  const blocks = html.split(/\n{2,}/);
  html = blocks.map(block => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (/^<(h[1-3]|ul|ol|pre|blockquote)/.test(trimmed)) return trimmed;
    return `<p>${trimmed.replace(/\n/g, '<br>')}</p>`;
  }).join('');

  return html;
}

/* ──────────────────────────────────────────────────────────────
   MESSAGE RENDERING
────────────────────────────────────────────────────────────── */
function formatTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function buildMessageElement(msg) {
  const isUser = msg.role === 'user';
  const wrapper = document.createElement('div');
  wrapper.className = `message ${isUser ? 'user-message' : 'ai-message'}`;
  wrapper.dataset.messageId = msg.id;

  const avatar = document.createElement('div');
  avatar.className = 'message-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  if (isUser) {
    avatar.textContent = 'U';
  } else {
    avatar.innerHTML = `<svg viewBox="0 0 24 24" fill="none"><path d="M12 2L2 7l10 5 10-5-10-5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 17l10 5 10-5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M2 12l10 5 10-5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
  }

  const body = document.createElement('div');
  body.className = 'message-body';

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.innerHTML = `<span class="message-role">${isUser ? 'You' : 'NexusChat'}</span><span class="message-time">${formatTime(msg.createdAt)}</span>`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  if (isUser) {
    bubble.textContent = msg.content;
  } else {
    bubble.innerHTML = renderMarkdown(msg.content);
  }

  const actions = document.createElement('div');
  actions.className = 'message-actions';

  // Copy button
  const copyBtn = document.createElement('button');
  copyBtn.className = 'icon-btn';
  copyBtn.setAttribute('aria-label', 'Copy message');
  copyBtn.setAttribute('title', 'Copy message');
  copyBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
  copyBtn.addEventListener('click', () => copyMessageText(msg.content));

  // Delete button
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'icon-btn danger';
  deleteBtn.setAttribute('aria-label', 'Delete message');
  deleteBtn.setAttribute('title', 'Delete message');
  deleteBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>`;
  deleteBtn.addEventListener('click', () => deleteMessage(msg.id));

  actions.append(copyBtn, deleteBtn);
  body.append(meta, bubble, actions);
  wrapper.append(avatar, body);
  return wrapper;
}

function renderMessages() {
  DOM.messagesContainer.innerHTML = '';
  const conv = getActiveConversation();
  if (!conv) return;
  conv.messages.forEach(msg => {
    DOM.messagesContainer.appendChild(buildMessageElement(msg));
  });
  scrollToBottom();
}

function appendMessageElement(msg) {
  const el = buildMessageElement(msg);
  DOM.messagesContainer.appendChild(el);
  scrollToBottom();
}

function updateWelcomeVisibility() {
  const conv = getActiveConversation();
  const hasMessages = conv?.messages.length > 0;
  DOM.welcomeScreen.style.display = hasMessages ? 'none' : 'flex';
  DOM.messagesContainer.style.display = hasMessages ? 'flex' : 'none';
}

function scrollToBottom(behavior = 'smooth') {
  DOM.chatArea.scrollTo({ top: DOM.chatArea.scrollHeight, behavior });
}

function deleteMessage(messageId) {
  const conv = getActiveConversation();
  if (!conv) return;
  conv.messages = conv.messages.filter(m => m.id !== messageId);
  conv.updatedAt = new Date().toISOString();
  persistConversations();
  renderMessages();
  updateStats();
  updateWelcomeVisibility();
  showToast('Message deleted', 'info');
}

/* ──────────────────────────────────────────────────────────────
   CONVERSATION LIST (SIDEBAR)
────────────────────────────────────────────────────────────── */
function renderConversationList() {
  DOM.conversationList.innerHTML = '';
  if (state.conversations.length === 0) {
    const empty = document.createElement('li');
    empty.style.cssText = 'padding:10px 8px;font-size:0.8rem;color:var(--text-tertiary);';
    empty.textContent = 'No conversations yet.';
    DOM.conversationList.appendChild(empty);
    return;
  }
  state.conversations.forEach(conv => {
    const li = document.createElement('li');
    li.className = `conversation-item${conv.id === state.activeConversationId ? ' active' : ''}`;
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.setAttribute('aria-current', conv.id === state.activeConversationId ? 'true' : 'false');
    li.setAttribute('aria-label', `Open conversation: ${conv.title}`);

    li.innerHTML = `
      <span class="conversation-item-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      </span>
      <span class="conversation-item-label">${escapeHtml(conv.title)}</span>
      <button class="conversation-item-delete" aria-label="Delete conversation: ${escapeHtml(conv.title)}" title="Delete conversation">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>`;

    li.addEventListener('click', e => {
      if (e.target.closest('.conversation-item-delete')) return;
      setActiveConversation(conv.id);
      closeMobileSidebar();
    });
    li.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActiveConversation(conv.id); closeMobileSidebar(); }
    });
    li.querySelector('.conversation-item-delete').addEventListener('click', e => {
      e.stopPropagation();
      if (confirm(`Delete "${conv.title}"?`)) deleteConversation(conv.id);
    });

    DOM.conversationList.appendChild(li);
  });
}

/* ──────────────────────────────────────────────────────────────
   STATISTICS
────────────────────────────────────────────────────────────── */
function updateStats() {
  const conv = getActiveConversation();
  const messages = conv?.messages ?? [];
  const userCount = messages.filter(m => m.role === 'user').length;
  const aiCount   = messages.filter(m => m.role === 'assistant').length;
  DOM.statTotal.textContent = messages.length;
  DOM.statUser.textContent  = userCount;
  DOM.statAi.textContent    = aiCount;
}

/* ──────────────────────────────────────────────────────────────
   API CALL WITH RETRY & TIMEOUT
────────────────────────────────────────────────────────────── */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  state.abortController = controller;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

async function callOpenRouter(messages, retryCount = 0) {
  const { OPENROUTER_API_KEY, MODEL, SYSTEM_PROMPT, TEMPERATURE, MAX_TOKENS, MAX_RETRIES, RETRY_DELAY_MS, REQUEST_TIMEOUT_MS, MAX_CONTEXT_MESSAGES } = state.config;

  if (!OPENROUTER_API_KEY || OPENROUTER_API_KEY === 'PASTE_YOUR_KEY_HERE') {
    throw new Error('API key not configured. Open Settings (⚙) and paste your OpenRouter API key.');
  }

  // Build message context (limit to avoid huge payloads)
  const contextMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.slice(-MAX_CONTEXT_MESSAGES),
  ];

  const body = JSON.stringify({
    model: MODEL,
    messages: contextMessages,
    temperature: TEMPERATURE,
    max_tokens: MAX_TOKENS,
    stream: false,
  });

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
    'HTTP-Referer': window.location.href,
    'X-Title': 'NexusChat',
  };

  let response;
  try {
    response = await fetchWithTimeout(OPENROUTER_ENDPOINT, { method: 'POST', headers, body }, REQUEST_TIMEOUT_MS);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out. Please try again.');
    throw new Error(`Network error: ${err.message}`);
  }

  // Rate limit handling
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get('Retry-After') || '5', 10);
    if (retryCount < MAX_RETRIES) {
      showToast(`Rate limited. Retrying in ${retryAfter}s…`, 'warning');
      await delay(retryAfter * 1000);
      return callOpenRouter(messages, retryCount + 1);
    }
    throw new Error('Rate limit exceeded. Please wait a moment before trying again.');
  }

  // Server errors — retry
  if (response.status >= 500 && retryCount < MAX_RETRIES) {
    await delay(RETRY_DELAY_MS * (retryCount + 1));
    return callOpenRouter(messages, retryCount + 1);
  }

  if (!response.ok) {
    let errMsg = `API error ${response.status}`;
    try {
      const errData = await response.json();
      errMsg = errData?.error?.message || errMsg;
    } catch {}
    throw new Error(errMsg);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('Empty response from API.');
  return content;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

/* ──────────────────────────────────────────────────────────────
   SEND MESSAGE
────────────────────────────────────────────────────────────── */
async function sendMessage(content) {
  content = content.trim();
  if (!content || state.isLoading) return;

  let conv = getActiveConversation();
  if (!conv) {
    conv = createConversation();
    state.activeConversationId = conv.id;
  }

  // Auto-title on first message
  if (conv.messages.length === 0) autoTitleConversation(conv, content);

  const userMsg = {
    id: generateId(),
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  };

  conv.messages.push(userMsg);
  conv.updatedAt = new Date().toISOString();
  persistConversations();

  updateWelcomeVisibility();
  appendMessageElement(userMsg);
  updateStats();
  renderConversationList();

  // Set loading state
  state.isLoading = true;
  setInputDisabled(true);
  DOM.typingIndicator.hidden = false;
  scrollToBottom();

  // Prepare messages for API (only role+content)
  const apiMessages = conv.messages.map(({ role, content: c }) => ({ role, content: c }));

  try {
    const aiContent = await callOpenRouter(apiMessages);

    const aiMsg = {
      id: generateId(),
      role: 'assistant',
      content: aiContent,
      createdAt: new Date().toISOString(),
    };

    conv.messages.push(aiMsg);
    conv.updatedAt = new Date().toISOString();
    persistConversations();
    appendMessageElement(aiMsg);
    updateStats();
  } catch (err) {
    console.error('[NexusChat] API error:', err);
    showToast(err.message || 'Something went wrong.', 'error');
  } finally {
    state.isLoading = false;
    state.abortController = null;
    setInputDisabled(false);
    DOM.typingIndicator.hidden = true;
    DOM.messageInput.focus();
  }
}

/* ──────────────────────────────────────────────────────────────
   INPUT HANDLING
────────────────────────────────────────────────────────────── */
function setInputDisabled(disabled) {
  DOM.messageInput.disabled = disabled;
  DOM.sendBtn.disabled = disabled || !DOM.messageInput.value.trim();
}

function autoResizeTextarea() {
  const ta = DOM.messageInput;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}

function updateCharCounter() {
  const len = DOM.messageInput.value.length;
  const max = 8000;
  DOM.charCounter.textContent = `${len.toLocaleString()} / ${max.toLocaleString()}`;
  DOM.charCounter.className = 'char-counter' +
    (len > max * 0.9 ? ' danger' : len > max * 0.75 ? ' warning' : '');
  DOM.sendBtn.disabled = state.isLoading || len === 0 || len > max;
}

/* ──────────────────────────────────────────────────────────────
   CLEAR CHAT
────────────────────────────────────────────────────────────── */
function clearCurrentChat() {
  const conv = getActiveConversation();
  if (!conv) return;
  if (!confirm('Clear all messages in this conversation?')) return;
  conv.messages = [];
  conv.title = 'New Chat';
  conv.updatedAt = new Date().toISOString();
  persistConversations();
  renderMessages();
  renderConversationList();
  updateStats();
  updateWelcomeVisibility();
  showToast('Chat cleared', 'success');
}

/* ──────────────────────────────────────────────────────────────
   COPY HELPERS
────────────────────────────────────────────────────────────── */
async function copyMessageText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied to clipboard', 'success');
  } catch {
    showToast('Copy failed', 'error');
  }
}

// Called from inline onclick in code blocks
window.copyCode = async function(id) {
  const el = document.getElementById(id);
  if (!el) return;
  try {
    await navigator.clipboard.writeText(el.textContent);
    showToast('Code copied!', 'success');
  } catch {
    showToast('Copy failed', 'error');
  }
};

/* ──────────────────────────────────────────────────────────────
   EXPORT
────────────────────────────────────────────────────────────── */
function exportAsTxt() {
  const conv = getActiveConversation();
  if (!conv || conv.messages.length === 0) { showToast('No messages to export', 'warning'); return; }
  const lines = [`NexusChat Export — ${conv.title}`, `Generated: ${new Date().toLocaleString()}`, '─'.repeat(60), ''];
  conv.messages.forEach(m => {
    lines.push(`[${m.role === 'user' ? 'You' : 'AI'}] ${formatTime(m.createdAt)}`);
    lines.push(m.content);
    lines.push('');
  });
  downloadFile(lines.join('\n'), `nexuschat_${Date.now()}.txt`, 'text/plain');
  showToast('Exported as TXT', 'success');
}

function exportAsJson() {
  const conv = getActiveConversation();
  if (!conv || conv.messages.length === 0) { showToast('No messages to export', 'warning'); return; }
  const data = { title: conv.title, exportedAt: new Date().toISOString(), model: state.config.MODEL, messages: conv.messages };
  downloadFile(JSON.stringify(data, null, 2), `nexuschat_${Date.now()}.json`, 'application/json');
  showToast('Exported as JSON', 'success');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ──────────────────────────────────────────────────────────────
   SETTINGS MODAL
────────────────────────────────────────────────────────────── */
function openSettings() {
  DOM.apiKeyInput.value        = state.config.OPENROUTER_API_KEY === 'PASTE_YOUR_KEY_HERE' ? '' : state.config.OPENROUTER_API_KEY;
  DOM.modelSelect.value        = state.config.MODEL;
  DOM.systemPromptInput.value  = state.config.SYSTEM_PROMPT;
  DOM.tempSlider.value         = state.config.TEMPERATURE;
  DOM.tempValue.textContent    = state.config.TEMPERATURE;
  DOM.maxTokensInput.value     = state.config.MAX_TOKENS;
  DOM.settingsModal.hidden     = false;
  DOM.apiKeyInput.focus();
}

function closeSettings() {
  DOM.settingsModal.hidden = true;
}

function saveSettings() {
  const key = DOM.apiKeyInput.value.trim();
  if (!key) { showToast('API key cannot be empty', 'error'); return; }

  state.config.OPENROUTER_API_KEY = key;
  state.config.MODEL              = DOM.modelSelect.value;
  state.config.SYSTEM_PROMPT      = DOM.systemPromptInput.value.trim() || DEFAULT_CONFIG.SYSTEM_PROMPT;
  state.config.TEMPERATURE        = parseFloat(DOM.tempSlider.value);
  state.config.MAX_TOKENS         = parseInt(DOM.maxTokensInput.value, 10) || 1024;

  persistConfig();
  updateModelBadge();
  closeSettings();
  showToast('Settings saved', 'success');
}

function updateModelBadge() {
  DOM.currentModelBadge.textContent = MODEL_LABELS[state.config.MODEL] || state.config.MODEL.split('/').pop();
}

/* ──────────────────────────────────────────────────────────────
   SIDEBAR
────────────────────────────────────────────────────────────── */
function toggleSidebar() {
  const isMobile = window.innerWidth <= 768;
  if (isMobile) {
    DOM.sidebar.classList.toggle('mobile-open');
    DOM.sidebarOverlay.classList.toggle('visible');
  } else {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    DOM.sidebar.classList.toggle('collapsed', state.sidebarCollapsed);
  }
}

function closeMobileSidebar() {
  DOM.sidebar.classList.remove('mobile-open');
  DOM.sidebarOverlay.classList.remove('visible');
}

/* ──────────────────────────────────────────────────────────────
   TOAST
────────────────────────────────────────────────────────────── */
function showToast(message, type = 'info') {
  const icons = { success: '✅', error: '❌', warning: '⚠️', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] ?? icons.info}</span><span>${escapeHtml(message)}</span>`;
  DOM.toastContainer.appendChild(toast);

  const duration = type === 'error' ? 5000 : 3000;
  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  }, duration);
}

/* ──────────────────────────────────────────────────────────────
   EVENT LISTENERS
────────────────────────────────────────────────────────────── */
function initEventListeners() {
  // ── Message input
  DOM.messageInput.addEventListener('input', () => {
    autoResizeTextarea();
    updateCharCounter();
  });

  DOM.messageInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!DOM.sendBtn.disabled) handleSend();
    }
  });

  DOM.sendBtn.addEventListener('click', handleSend);

  function handleSend() {
    const text = DOM.messageInput.value;
    DOM.messageInput.value = '';
    autoResizeTextarea();
    updateCharCounter();
    sendMessage(text);
  }

  // ── Suggestion cards
  document.querySelectorAll('.suggestion-card').forEach(card => {
    card.addEventListener('click', () => {
      const prompt = card.dataset.prompt;
      if (prompt) sendMessage(prompt);
    });
  });

  // ── New chat
  DOM.newChatBtn.addEventListener('click', () => {
    const conv = createConversation();
    state.activeConversationId = conv.id;
    persistConversations();
    renderConversationList();
    renderMessages();
    updateStats();
    updateWelcomeVisibility();
    DOM.messageInput.focus();
    closeMobileSidebar();
  });

  // ── Sidebar toggle (hamburger)
  DOM.sidebarToggleBtn.addEventListener('click', toggleSidebar);
  DOM.sidebarCollapseBtn.addEventListener('click', toggleSidebar);
  DOM.sidebarOverlay.addEventListener('click', closeMobileSidebar);

  // ── Theme toggle
  DOM.themToggleBtn.addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
  });

  // ── Clear chat
  DOM.clearChatBtn.addEventListener('click', clearCurrentChat);

  // ── Export
  DOM.exportTxtBtn.addEventListener('click', exportAsTxt);
  DOM.exportJsonBtn.addEventListener('click', exportAsJson);

  // ── Settings
  DOM.settingsBtn.addEventListener('click', openSettings);
  DOM.closeSettingsBtn.addEventListener('click', closeSettings);
  DOM.cancelSettingsBtn.addEventListener('click', closeSettings);
  DOM.saveSettingsBtn.addEventListener('click', saveSettings);
  DOM.settingsModal.addEventListener('click', e => { if (e.target === DOM.settingsModal) closeSettings(); });

  // ── API key visibility toggle
  DOM.toggleKeyVisibility.addEventListener('click', () => {
    const isPassword = DOM.apiKeyInput.type === 'password';
    DOM.apiKeyInput.type = isPassword ? 'text' : 'password';
    DOM.toggleKeyVisibility.textContent = isPassword ? 'Hide' : 'Show';
  });

  // ── Temperature slider live update
  DOM.tempSlider.addEventListener('input', () => {
    DOM.tempValue.textContent = parseFloat(DOM.tempSlider.value).toFixed(1);
  });

  // ── Keyboard shortcut: Escape closes modal
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!DOM.settingsModal.hidden) closeSettings();
      if (DOM.sidebar.classList.contains('mobile-open')) closeMobileSidebar();
    }
  });

  // ── Focus input on load
  DOM.messageInput.focus();
}

/* ──────────────────────────────────────────────────────────────
   INITIALISATION
────────────────────────────────────────────────────────────── */
function init() {
  loadPersistedState();
  applyTheme(state.theme);
  updateModelBadge();

  // Ensure there is at least one conversation
  if (state.conversations.length === 0 || !state.activeConversationId) {
    const conv = createConversation();
    state.activeConversationId = conv.id;
    persistConversations();
  }

  renderConversationList();
  renderMessages();
  updateStats();
  updateWelcomeVisibility();
  initEventListeners();

  // Prompt first-time users to configure
  if (state.config.OPENROUTER_API_KEY === 'PASTE_YOUR_KEY_HERE') {
    setTimeout(() => {
      showToast('Paste your OpenRouter API key in Settings (⚙)', 'warning');
    }, 800);
  }
}

document.addEventListener('DOMContentLoaded', init);