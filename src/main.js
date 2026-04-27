import { marked } from 'marked';

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ===== STATE =====
const state = {
  apiKey: localStorage.getItem('nvidia_api_key') || '',
  sessionId: localStorage.getItem('session_id') || crypto.randomUUID(),
  isStreaming: false,
  sidebarOpen: true,
};
localStorage.setItem('session_id', state.sessionId);

// ===== DOM REFS =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  apiModal: $('#api-modal'),
  apiKeyInput: $('#api-key-input'),
  apiKeySave: $('#api-key-save'),
  mainLayout: $('#main-layout'),
  sidebar: $('#sidebar'),
  sidebarToggle: $('#sidebar-toggle'),
  sidebarOpen: $('#sidebar-open'),
  playlistUrl: $('#playlist-url'),
  loadPlaylist: $('#load-playlist'),
  loadPlaylistText: $('#load-playlist-text'),
  playlistSpinner: $('#playlist-spinner'),
  playlistStatus: $('#playlist-status'),
  videoList: $('#video-list'),
  dropZone: $('#drop-zone'),
  fileInput: $('#file-input'),
  browseFiles: $('#browse-files'),
  fileList: $('#file-list'),
  uploadStatus: $('#upload-status'),
  messagesContainer: $('#messages-container'),
  messages: $('#messages'),
  welcomeScreen: $('#welcome-screen'),
  chatInput: $('#chat-input'),
  sendBtn: $('#send-btn'),
  clearChat: $('#clear-chat'),
  changeKey: $('#change-key'),
  chatSubtitle: $('#chat-subtitle'),
  statSources: $('#stat-sources'),
  statChunks: $('#stat-chunks'),
  sourcePanel: $('#source-panel'),
  sourceList: $('#source-list'),
  closeSources: $('#close-sources'),
};

// ===== INIT =====
async function init() {
  // Check if server has API key configured in .env
  try {
    const res = await fetch('/api/config');
    const config = await res.json();
    if (config.hasKey) {
      state.apiKey = '__env__'; // marker: key is on the server
      state.envKeyPreview = config.keyPreview;
      showApp();
    }
  } catch (e) { /* server not ready yet */ }

  if (state.apiKey && state.apiKey !== '__env__') {
    showApp();
  }
  setupEventListeners();
  loadSources();
}

function showApp() {
  els.apiModal.classList.add('hidden');
  els.mainLayout.style.display = 'flex';
}

function showModal() {
  els.apiModal.classList.remove('hidden');
  els.mainLayout.style.display = 'none';
}

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // API Key
  els.apiKeySave.addEventListener('click', saveApiKey);
  els.apiKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveApiKey(); });
  els.changeKey.addEventListener('click', () => {
    els.apiKeyInput.value = state.apiKey;
    showModal();
  });

  // Sidebar
  els.sidebarToggle.addEventListener('click', toggleSidebar);
  els.sidebarOpen.addEventListener('click', toggleSidebar);

  // Tabs
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Playlist
  els.loadPlaylist.addEventListener('click', loadPlaylist);
  els.playlistUrl.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadPlaylist(); });

  // File Upload
  els.browseFiles.addEventListener('click', (e) => { e.stopPropagation(); els.fileInput.click(); });
  els.dropZone.addEventListener('click', (e) => {
    if (e.target.closest('button')) return; // don't double-trigger from button
    els.fileInput.click();
  });
  els.fileInput.addEventListener('change', handleFileSelect);
  els.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); els.dropZone.classList.add('dragover'); });
  els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('dragover'));
  els.dropZone.addEventListener('drop', handleFileDrop);

  // Chat
  els.sendBtn.addEventListener('click', sendMessage);
  els.chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  els.chatInput.addEventListener('input', autoResizeTextarea);
  els.clearChat.addEventListener('click', clearChat);

  // Sources
  els.closeSources.addEventListener('click', () => els.sourcePanel.classList.remove('open'));
}

// ===== API KEY =====
function saveApiKey() {
  const key = els.apiKeyInput.value.trim();
  if (!key) return;
  state.apiKey = key;
  localStorage.setItem('nvidia_api_key', key);
  showApp();
}

// ===== SIDEBAR =====
function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  els.sidebar.classList.toggle('collapsed');
  els.sidebarOpen.style.display = state.sidebarOpen ? 'none' : 'flex';
}

function switchTab(tabName) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  $$('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tabName}`));
}

// ===== PLAYLIST LOADING =====
async function loadPlaylist() {
  const url = els.playlistUrl.value.trim();
  if (!url) return;

  els.loadPlaylistText.style.display = 'none';
  els.playlistSpinner.style.display = 'block';
  els.loadPlaylist.disabled = true;
  els.videoList.innerHTML = '';
  els.playlistStatus.innerHTML = '';

  try {
    const response = await fetch('/api/playlist/load', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, apiKey: state.apiKey }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          const event = line.slice(7).trim();
          const dataLine = lines[lines.indexOf(line) + 1];
          // Handle in next data line
        }
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            handlePlaylistEvent(data);
          } catch (e) { /* skip */ }
        }
      }
    }
  } catch (err) {
    setStatus(els.playlistStatus, `Error: ${err.message}`, 'error');
  }

  els.loadPlaylistText.style.display = 'inline';
  els.playlistSpinner.style.display = 'none';
  els.loadPlaylist.disabled = false;
  loadSources();
}

function handlePlaylistEvent(data) {
  if (data.videoCount !== undefined && data.videos) {
    // Playlist info received
    setStatus(els.playlistStatus, `Found ${data.videoCount} videos in "${data.title}"`, 'success');
    data.videos.forEach(v => addVideoItem(v.id, v.title, v.duration, 'pending'));
    return;
  }

  if (data.videoId && data.status) {
    updateVideoItem(data.videoId, data.status, data.message);
    if (data.processed !== undefined) {
      setStatus(els.playlistStatus, `Processing ${data.processed}/${data.total}...`);
    }
    return;
  }

  if (data.totalVideos !== undefined) {
    // Complete
    setStatus(els.playlistStatus,
      `✅ Done! ${data.processedVideos} videos indexed (${data.failedVideos} failed). ${data.totalChunks} chunks total.`,
      'success'
    );
  }

  if (data.message && !data.videoId && !data.totalVideos) {
    setStatus(els.playlistStatus, data.message);
  }
}

function addVideoItem(id, title, duration, status) {
  const item = document.createElement('div');
  item.className = 'video-item';
  item.id = `video-${id}`;
  item.innerHTML = `
    <span class="status-icon">⏳</span>
    <span class="video-title" title="${title}">${title}</span>
    <span class="video-duration">${duration}</span>
  `;
  els.videoList.appendChild(item);
}

function updateVideoItem(videoId, status, message) {
  const item = $(`#video-${videoId}`);
  if (!item) return;

  const iconMap = {
    processing: '⏳', embedding: '🔄', done: '✅',
    failed: '❌', skipped: '⏭️', pending: '⏳',
  };

  item.querySelector('.status-icon').textContent = iconMap[status] || '⏳';
  if (status === 'done') item.classList.add('done');
  item.title = message || '';
}

// ===== FILE UPLOAD =====
function handleFileDrop(e) {
  e.preventDefault();
  els.dropZone.classList.remove('dragover');
  const files = Array.from(e.dataTransfer.files);
  uploadFiles(files);
}

function handleFileSelect(e) {
  const files = Array.from(e.target.files);
  uploadFiles(files);
  e.target.value = '';
}

async function uploadFiles(files) {
  if (files.length === 0) return;

  // Show file items as pending
  files.forEach(f => addFileItem(f.name, 'pending'));
  setStatus(els.uploadStatus, `Uploading and processing ${files.length} file(s)...`);

  const formData = new FormData();
  formData.append('apiKey', state.apiKey);
  files.forEach(f => formData.append('files', f));

  try {
    const response = await fetch('/api/upload/files', {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();

    if (data.error) {
      setStatus(els.uploadStatus, `Error: ${data.error}`, 'error');
      return;
    }

    // Update file items with results
    els.fileList.innerHTML = '';
    data.results.forEach(r => {
      addFileItem(r.filename, r.status === 'success' ? 'done' : 'failed', r);
    });

    const successCount = data.results.filter(r => r.status === 'success').length;
    setStatus(els.uploadStatus,
      `✅ ${successCount}/${data.results.length} files processed. ${data.totalChunks} total chunks.`,
      'success'
    );
    loadSources();
  } catch (err) {
    setStatus(els.uploadStatus, `Error: ${err.message}`, 'error');
  }
}

function addFileItem(filename, status, info) {
  const ext = filename.split('.').pop().toUpperCase();
  const iconMap = { done: '✅', failed: '❌', pending: '⏳' };
  const item = document.createElement('div');
  item.className = 'file-item';
  item.innerHTML = `
    <span class="file-badge">${ext}</span>
    <span class="file-name" title="${filename}">${filename}</span>
    <span class="file-status">${iconMap[status] || '⏳'}</span>
  `;
  if (info?.chunkCount) item.title = `${info.chunkCount} chunks, ${(info.charCount / 1000).toFixed(0)}K chars`;
  els.fileList.appendChild(item);
}

// ===== CHAT =====
async function sendMessage() {
  const message = els.chatInput.value.trim();
  if (!message || state.isStreaming) return;

  state.isStreaming = true;
  els.sendBtn.disabled = true;
  els.chatInput.value = '';
  els.chatInput.style.height = 'auto';
  els.welcomeScreen.classList.add('hidden');

  // Add user message
  appendMessage('user', message);

  // Add typing indicator
  const typingId = appendTyping();

  try {
    const response = await fetch('/api/chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId: state.sessionId, apiKey: state.apiKey }),
    });

    // Remove typing indicator
    removeTyping(typingId);

    // Stream the response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullResponse = '';
    let sources = [];
    const msgEl = appendMessage('assistant', '');
    const contentEl = msgEl.querySelector('.message-text');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.token) {
              fullResponse += data.token;
              contentEl.innerHTML = marked.parse(fullResponse);
              scrollToBottom();
            }
          } catch (e) { /* skip */ }
        }
        if (line.startsWith('event: sources')) {
          // Next data line has sources
        }
        if (line.startsWith('data: ') && !fullResponse) {
          try {
            const data = JSON.parse(line.slice(6));
            if (Array.isArray(data)) {
              sources = data;
            }
          } catch (e) { /* skip */ }
        }
      }
    }

    // Add source badges
    if (sources.length > 0) {
      addSourceBadges(msgEl, sources);
    }

  } catch (err) {
    removeTyping(typingId);
    appendMessage('assistant', `⚠️ Error: ${err.message}`);
  }

  state.isStreaming = false;
  els.sendBtn.disabled = false;
  els.chatInput.focus();
}

function appendMessage(role, content) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const avatar = role === 'assistant' ? '🤖' : '👤';
  div.innerHTML = `
    <div class="message-avatar">${avatar}</div>
    <div class="message-content">
      <div class="message-text">${content ? marked.parse(content) : ''}</div>
    </div>
  `;

  els.messages.appendChild(div);
  scrollToBottom();
  return div;
}

function appendTyping() {
  const id = 'typing-' + Date.now();
  const div = document.createElement('div');
  div.className = 'message assistant';
  div.id = id;
  div.innerHTML = `
    <div class="message-avatar">🤖</div>
    <div class="message-content">
      <div class="typing-indicator">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
    </div>
  `;
  els.messages.appendChild(div);
  scrollToBottom();
  return id;
}

function removeTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function addSourceBadges(msgEl, sources) {
  const contentEl = msgEl.querySelector('.message-content');
  const sourcesDiv = document.createElement('div');
  sourcesDiv.className = 'message-sources';

  sources.forEach((s, i) => {
    const badge = document.createElement('span');
    badge.className = 'source-badge';
    badge.textContent = `📌 ${s.source || `Source ${i + 1}`} (${s.similarity}%)`;
    badge.addEventListener('click', () => showSources(sources));
    sourcesDiv.appendChild(badge);
  });

  contentEl.appendChild(sourcesDiv);
}

function showSources(sources) {
  els.sourceList.innerHTML = '';
  sources.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'source-card';
    card.innerHTML = `
      <div class="source-card-header">
        <span class="source-card-name">${s.source || `Source ${i + 1}`}</span>
        <span class="source-card-score">${s.similarity}% match</span>
      </div>
      <div class="source-card-text">${s.text || ''}</div>
      <div class="source-card-type">${s.type === 'video' ? '🎥 Video Transcript' : '📄 Uploaded File'}</div>
    `;
    els.sourceList.appendChild(card);
  });
  els.sourcePanel.classList.add('open');
}

async function clearChat() {
  state.sessionId = crypto.randomUUID();
  localStorage.setItem('session_id', state.sessionId);
  els.messages.innerHTML = '';
  els.welcomeScreen.classList.remove('hidden');

  try {
    await fetch('/api/chat/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
  } catch (e) { /* ignore */ }
}

// ===== UTILITIES =====
function scrollToBottom() {
  els.messagesContainer.scrollTop = els.messagesContainer.scrollHeight;
}

function autoResizeTextarea() {
  els.chatInput.style.height = 'auto';
  els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, 150) + 'px';
}

function setStatus(container, message, type = '') {
  const className = type === 'error' ? 'status-error' : type === 'success' ? 'status-success' : '';
  container.innerHTML = `<div class="status-msg ${className}">${message}</div>`;
}

async function loadSources() {
  try {
    const response = await fetch('/api/playlist/sources');
    const data = await response.json();
    els.statSources.textContent = data.sources.length;
    els.statChunks.textContent = data.totalChunks;

    if (data.sources.length > 0) {
      els.chatSubtitle.textContent = `${data.sources.length} sources loaded • ${data.totalChunks} chunks indexed`;
    }
  } catch (e) { /* ignore on startup */ }
}

// ===== BOOT =====
init();
