import { marked } from 'marked';

// Configure marked for safe rendering
marked.setOptions({
  breaks: true,
  gfm: true,
});

// ===== STATE =====
const state = {
  apiKey: '',
  sessionId: localStorage.getItem('session_id') || crypto.randomUUID(),
  isStreaming: false,
  isPlaylistProcessing: false,
  sidebarOpen: true,
  playlistSnapshot: null,
  uploadSnapshot: null,
};
localStorage.setItem('session_id', state.sessionId);
let sourceSyncTimer = null;

// ===== DOM REFS =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  apiModal: $('#api-modal'),
  resumeModal: $('#resume-modal'),
  resumeModalSummary: $('#resume-modal-summary'),
  resumeNow: $('#resume-now'),
  resumeLater: $('#resume-later'),
  apiKeyInput: $('#api-key-input'),
  apiKeySave: $('#api-key-save'),
  apiHint: $('#api-modal .modal-hint'),
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
  setupEventListeners();

  // Check if server has a working API key configured in .env
  try {
    const res = await fetch('/api/config');
    const raw = await res.text();
    const config = raw ? JSON.parse(raw) : {};

    if (config.hasKey && config.isValid) {
      state.apiKey = '__env__'; // marker: key is on the server
      state.envKeyPreview = config.keyPreview;
      showApp();
      await refreshKnowledgeAndSnapshots(true);
      return;
    }

    if (config.hasKey && !config.isValid) {
      showModal('Saved API key in .env is not working. Enter a new key to overwrite it.', true);
      return;
    }

    showModal();
    return;
  } catch (e) { /* server not ready yet */ }

  showModal('Could not verify server API key. Make sure backend is running, then try again.', true);
}

async function refreshKnowledgeAndSnapshots(showResumePrompt) {
  await Promise.all([loadSources(), loadPendingSnapshots()]);
  if (showResumePrompt) maybeShowResumeModal();
}

function showApp() {
  els.apiModal.classList.add('hidden');
  els.mainLayout.style.display = 'flex';
}

function showModal(message = '', isError = false) {
  if (message) {
    setApiHint(message, isError);
  } else {
    setApiHint('Your key is saved in the project .env file and used server-side only.');
  }
  els.apiKeyInput.value = '';
  els.apiModal.classList.remove('hidden');
  els.mainLayout.style.display = 'none';
}

function showResumeModal(summary) {
  els.resumeModalSummary.textContent = summary;
  els.resumeModal.classList.remove('hidden');
}

function hideResumeModal() {
  els.resumeModal.classList.add('hidden');
}

function maybeShowResumeModal() {
  const playlistPending = state.playlistSnapshot?.canResume;
  const uploadPending = state.uploadSnapshot?.canResume;
  if (!playlistPending && !uploadPending) return;

  const parts = [];
  if (playlistPending && state.playlistSnapshot?.pending) {
    const p = state.playlistSnapshot.pending;
    parts.push(`Playlist: ${p.heldVideos || 0} held, ${p.failedVideos || 0} failed`);
  }
  if (uploadPending && state.uploadSnapshot?.pending) {
    const u = state.uploadSnapshot.pending;
    parts.push(`Files: ${u.heldFiles || 0} held, ${u.failedFiles || 0} failed`);
  }

  showResumeModal(parts.join(' • '));
}

async function resumeHeldJobs() {
  hideResumeModal();

  if (state.playlistSnapshot?.canResume) {
    let playlistResumed = await resumePlaylist();
    if (!playlistResumed) {
      await new Promise(r => setTimeout(r, 1200));
      playlistResumed = await resumePlaylist();
    }
  }

  if (state.uploadSnapshot?.canResume) {
    await resumeFiles();
  }

  await refreshKnowledgeAndSnapshots(false);
}

async function deferHeldJobs() {
  hideResumeModal();

  const requests = [];
  if (state.playlistSnapshot?.canResume) {
    requests.push(fetch('/api/playlist/defer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey }),
    }));
  }
  if (state.uploadSnapshot?.canResume) {
    requests.push(fetch('/api/upload/defer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey }),
    }));
  }

  try {
    if (requests.length > 0) await Promise.all(requests);
  } catch {
    // ignore defer errors
  }

  await refreshKnowledgeAndSnapshots(false);
}

// ===== EVENT LISTENERS =====
function setupEventListeners() {
  // API Key
  els.apiKeySave.addEventListener('click', saveApiKey);
  els.apiKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveApiKey(); });
  els.changeKey.addEventListener('click', () => {
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
  els.videoList.addEventListener('click', onVideoRowActionClick);
  els.fileList.addEventListener('click', onFileRowActionClick);

  // Resume modal
  els.resumeNow.addEventListener('click', resumeHeldJobs);
  els.resumeLater.addEventListener('click', deferHeldJobs);
}

// ===== API KEY =====
async function saveApiKey() {
  const key = els.apiKeyInput.value.trim();
  if (!key) {
    setApiHint('Please enter a valid NVIDIA API key.', true);
    return;
  }

  els.apiKeySave.disabled = true;
  setApiHint('Validating key and saving it to .env...');

  try {
    const response = await fetch('/api/config/api-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: key }),
    });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (e) {
      throw new Error(raw || `API request failed (${response.status})`);
    }

    if (!response.ok || data.error) {
      throw new Error(data.error || 'Could not save API key');
    }

    state.apiKey = '__env__';
    setApiHint(`Connected (${data.keyPreview || 'nvapi-***'})`);
    els.apiKeyInput.value = '';
    els.apiKeyInput.blur();
  } catch (err) {
    setApiHint(err.message, true);
    return;
  } finally {
    els.apiKeySave.disabled = false;
  }

  showApp();
  await refreshKnowledgeAndSnapshots(true);
}

function setApiHint(message, isError = false) {
  if (!els.apiHint) return;
  els.apiHint.textContent = message;
  els.apiHint.style.color = isError ? 'var(--error)' : 'var(--text-muted)';
}

function isApiKeyIssue(message) {
  const text = String(message || '').toLowerCase();
  return (
    text.includes('api key') ||
    text.includes('unauthorized') ||
    text.includes('invalid') ||
    text.includes('expired') ||
    text.includes('401') ||
    text.includes('403') ||
    text.includes('bearer')
  );
}

function handleApiKeyFailure(message) {
  state.apiKey = '';
  showModal(`Saved key failed: ${message}. Enter a new key to overwrite .env.`, true);
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

  await streamPlaylistRequest('/api/playlist/load', { url, apiKey: state.apiKey });
}

async function resumePlaylist() {
  return streamPlaylistRequest('/api/playlist/resume', { apiKey: state.apiKey });
}

async function resumeFiles() {
  try {
    setStatus(els.uploadStatus, 'Resuming held files...');
    const response = await fetch('/api/upload/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Failed to resume files');
    }

    if (Array.isArray(data.items)) {
      data.items.forEach(item => hydrateFileItemFromSnapshot(item));
    }

    setStatus(els.uploadStatus, 'Held files processed.', 'success');
    await loadPendingSnapshots();
    await loadSources();
  } catch (err) {
    setStatus(els.uploadStatus, `Error: ${err.message}`, 'error');
    if (isApiKeyIssue(err.message)) handleApiKeyFailure(err.message);
  }
}

async function loadPendingSnapshots() {
  try {
    const [playlistRes, uploadRes] = await Promise.all([
      fetch('/api/playlist/pending'),
      fetch('/api/upload/pending'),
    ]);

    state.playlistSnapshot = playlistRes.ok ? await playlistRes.json() : null;
    state.uploadSnapshot = uploadRes.ok ? await uploadRes.json() : null;
    state.isPlaylistProcessing = !!state.playlistSnapshot?.running;

    hydratePendingStates();
  } catch {
    state.playlistSnapshot = null;
    state.uploadSnapshot = null;
    state.isPlaylistProcessing = false;
  }
}

async function streamPlaylistRequest(endpoint, payload) {
  const shouldClearList = endpoint === '/api/playlist/load' || endpoint === '/api/playlist/resume';
  let success = false;
  state.isPlaylistProcessing = true;

  els.loadPlaylistText.style.display = 'none';
  els.playlistSpinner.style.display = 'block';
  els.loadPlaylist.disabled = true;
  if (shouldClearList) els.videoList.innerHTML = '';
  els.playlistStatus.innerHTML = '';

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text();
      let message = `Request failed (${response.status})`;
      try {
        const parsed = text ? JSON.parse(text) : {};
        message = parsed.error || parsed.message || message;
      } catch {
        if (text) message = text;
      }
      throw new Error(message);
    }

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
    success = true;
  } catch (err) {
    setStatus(els.playlistStatus, `Error: ${err.message}`, 'error');
    if (isApiKeyIssue(err.message)) {
      handleApiKeyFailure(err.message);
    }
  }

  state.isPlaylistProcessing = false;
  els.loadPlaylistText.style.display = 'inline';
  els.playlistSpinner.style.display = 'none';
  els.loadPlaylist.disabled = false;
  await refreshKnowledgeAndSnapshots(false);
  return success;
}

function handlePlaylistEvent(data) {
  if (data.videoCount !== undefined && data.videos) {
    // Playlist info received
    setStatus(els.playlistStatus, `Found ${data.videoCount} videos in "${data.title}"`, 'success');
    data.videos.forEach(v => {
      const status = v.status || 'pending';
      addVideoItem(v.id, v.title, v.duration, status);
      if (v.message) updateVideoItem(v.id, status, v.message);
    });
    return;
  }

  if (data.videoId && data.status) {
    updateVideoItem(data.videoId, data.status, data.message);
    if (data.processed !== undefined) {
      setStatus(els.playlistStatus, `Processing ${data.processed}/${data.total}...`);
    }
    if (typeof data.totalSourcesInStore === 'number') {
      els.statSources.textContent = data.totalSourcesInStore;
    }
    if (typeof data.totalChunksInStore === 'number') {
      els.statChunks.textContent = data.totalChunksInStore;
    }
    if (typeof data.totalSourcesInStore === 'number' && typeof data.totalChunksInStore === 'number') {
      els.chatSubtitle.textContent = `${data.totalSourcesInStore} sources loaded • ${data.totalChunksInStore} chunks indexed`;
    }
    if (data.status === 'done' || data.status === 'failed' || data.status === 'skipped') {
      scheduleSourceSync();
    }
    return;
  }

  if (data.totalVideos !== undefined) {
    // Complete
    setStatus(els.playlistStatus,
      `✅ Done! ${data.processedVideos} videos indexed (${data.failedVideos} failed). ${data.totalChunks} chunks total.`,
      'success'
    );

    if (typeof data.totalSourcesInStore === 'number') {
      els.statSources.textContent = data.totalSourcesInStore;
    }
    if (typeof data.totalChunksInStore === 'number') {
      els.statChunks.textContent = data.totalChunksInStore;
    }
  }

  if (data.message && !data.videoId && !data.totalVideos) {
    if (isApiKeyIssue(data.message)) {
      handleApiKeyFailure(data.message);
      return;
    }
    setStatus(els.playlistStatus, data.message);
  }
}

function scheduleSourceSync() {
  if (sourceSyncTimer) clearTimeout(sourceSyncTimer);
  sourceSyncTimer = setTimeout(() => {
    refreshKnowledgeAndSnapshots(false);
  }, 300);
}

function addVideoItem(id, title, duration, status) {
  let item = document.getElementById(`video-${id}`);
  if (!item) {
    item = document.createElement('div');
    item.className = 'video-item';
    item.id = `video-${id}`;
    item.dataset.sourceId = `video_${id}`;
    item.dataset.sourceType = 'video';
    item.innerHTML = `
      <span class="status-icon">⏳</span>
      <span class="video-title" title="${title}">${title}</span>
      <span class="video-duration">${duration}</span>
      <button class="source-retry-btn hidden" title="Retry this video" data-video-id="${id}">Retry</button>
      <button class="source-remove-btn hidden" title="Remove transcript from knowledge base" data-source-id="video_${id}" data-source-type="video">🗑</button>
    `;
    els.videoList.appendChild(item);
  } else {
    item.dataset.sourceId = `video_${id}`;
    item.dataset.sourceType = 'video';

    const titleEl = item.querySelector('.video-title');
    const durationEl = item.querySelector('.video-duration');
    if (titleEl) {
      titleEl.textContent = title;
      titleEl.title = title;
    }
    if (durationEl) durationEl.textContent = duration;

    if (!item.querySelector('.source-retry-btn')) {
      const retryBtn = document.createElement('button');
      retryBtn.className = 'source-retry-btn hidden';
      retryBtn.title = 'Retry this video';
      retryBtn.dataset.videoId = id;
      retryBtn.textContent = 'Retry';
      item.appendChild(retryBtn);
    }

    if (!item.querySelector('.source-remove-btn')) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'source-remove-btn hidden';
      removeBtn.title = 'Remove transcript from knowledge base';
      removeBtn.dataset.sourceId = `video_${id}`;
      removeBtn.dataset.sourceType = 'video';
      removeBtn.textContent = '🗑';
      item.appendChild(removeBtn);
    }
  }

  updateVideoItem(id, status, '');
}

function updateVideoItem(videoId, status, message) {
  const item = $(`#video-${videoId}`);
  if (!item) return;

  item.dataset.status = status;

  const iconMap = {
    processing: '⏳', embedding: '🔄', done: '✅',
    failed: '❌', skipped: '⏭️', pending: '⏳', held: '⏸️',
  };

  item.querySelector('.status-icon').textContent = iconMap[status] || '⏳';
  if (status === 'done') item.classList.add('done');
  if (status === 'failed') item.classList.remove('done');

  const removeBtn = item.querySelector('.source-remove-btn');
  const retryBtn = item.querySelector('.source-retry-btn');
  const canRemove = status === 'done' || status === 'skipped';
  const canRetry = status === 'failed' || status === 'held';

  if (retryBtn) {
    retryBtn.classList.toggle('hidden', !canRetry);
    retryBtn.disabled = false;
  }
  if (removeBtn) {
    removeBtn.classList.toggle('hidden', !canRemove);
    removeBtn.disabled = false;
  }

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
      if (isApiKeyIssue(data.error)) {
        handleApiKeyFailure(data.error);
      }
      setStatus(els.uploadStatus, `Error: ${data.error}`, 'error');
      // Mark all pending files as failed
      files.forEach(f => {
        addFileItem(f.name, 'failed', { message: data.error });
      });
      return;
    }

    // Update file items with results
    data.results.forEach(r => {
      addFileItem(r.filename, r.status || 'failed', r);
    });

    const successCount = data.results.filter(r => r.status === 'done').length;
    setStatus(els.uploadStatus,
      `✅ ${successCount}/${data.results.length} files processed. ${data.totalChunks} total chunks.`,
      'success'
    );
    await refreshKnowledgeAndSnapshots(false);
  } catch (err) {
    if (isApiKeyIssue(err.message)) {
      handleApiKeyFailure(err.message);
    }
    setStatus(els.uploadStatus, `Error: ${err.message}`, 'error');
  }
}

function addFileItem(filename, status, info) {
  const ext = filename.split('.').pop().toUpperCase();
  const iconMap = { done: '✅', failed: '❌', pending: '⏳', held: '⏸️', processing: '⏳', embedding: '🔄' };

  // Reuse existing row for this source/file when possible
  let item = null;
  if (info?.sourceId) {
    item = Array.from(els.fileList.children).find(
      el => el.dataset.sourceId === info.sourceId
    );
  }
  if (!item) {
    item = Array.from(els.fileList.children).find(
      el => el.dataset.filename === filename
    );
  }
  
  if (!item) {
    item = document.createElement('div');
    item.className = 'file-item';
    item.dataset.filename = filename;
    els.fileList.insertBefore(item, els.fileList.firstChild);
  }

  item.dataset.status = status;
  if (info?.id) {
    item.dataset.itemId = info.id;
  }
  if (info?.sourceId) {
    item.dataset.sourceId = info.sourceId;
    item.dataset.sourceType = 'file';
  }

  let errorMsgHtml = '';
  if (status === 'failed' && info?.message) {
    errorMsgHtml = `<div class="file-error-text">${info.message}</div>`;
  }

  const sourceId = item.dataset.sourceId || '';
  const itemId = item.dataset.itemId || '';
  const showRemove = status === 'done' && !!sourceId;
  const showRetry = (status === 'failed' || status === 'held') && !!itemId;

  item.innerHTML = `
    <div class="file-item-header">
      <span class="file-badge">${ext}</span>
      <span class="file-name" title="${filename}">${filename}</span>
      <span class="file-status">${iconMap[status] || '⏳'}</span>
      <button class="source-retry-btn ${showRetry ? '' : 'hidden'}" title="Retry this file" data-item-id="${itemId}">Retry</button>
      <button class="source-remove-btn ${showRemove ? '' : 'hidden'}" title="Remove file from knowledge base" data-source-id="${sourceId}" data-source-type="file">🗑</button>
    </div>
    ${errorMsgHtml}
  `;

  if (info?.chunkCount) {
    item.title = `${info.chunkCount} chunks, ${(info.charCount / 1000).toFixed(0)}K chars`;
    item.classList.remove('error-item');
  } else if (status === 'failed' && info?.message) {
    item.title = info.message;
    item.classList.add('error-item');
  }
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
    let streamError = '';
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
            } else if (data.message) {
              streamError = data.message;
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

    if (streamError && !fullResponse) {
      msgEl.remove();
      appendMessage('assistant', `⚠️ Error: ${streamError}`);
      if (isApiKeyIssue(streamError)) {
        handleApiKeyFailure(streamError);
      }
    }

    // Add source badges
    if (sources.length > 0) {
      addSourceBadges(msgEl, sources);
    }

  } catch (err) {
    removeTyping(typingId);
    appendMessage('assistant', `⚠️ Error: ${err.message}`);
    if (isApiKeyIssue(err.message)) {
      handleApiKeyFailure(err.message);
    }
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

function updateKnowledgeStats(sources, totalChunks) {
  els.statSources.textContent = sources.length;
  els.statChunks.textContent = totalChunks;

  if (sources.length > 0) {
    els.chatSubtitle.textContent = `${sources.length} sources loaded • ${totalChunks} chunks indexed`;
  } else {
    els.chatSubtitle.textContent = 'Load a playlist or upload files to start learning';
  }
}

function extractVideoIdFromSource(source) {
  if (source.videoId) return source.videoId;
  if (source.id && source.id.startsWith('video_')) return source.id.slice(6);
  return null;
}

function hydrateVideoItemFromSnapshot(item) {
  const status = item.status || 'pending';
  addVideoItem(item.videoId, item.title || `Video ${item.videoId}`, item.duration || 'Unknown', status);
  updateVideoItem(item.videoId, status, item.message || '');
}

function hydrateFileItemFromSnapshot(item) {
  addFileItem(item.filename || item.id, item.status || 'pending', {
    id: item.id,
    sourceId: item.sourceId,
    chunkCount: item.chunkCount || 0,
    charCount: item.charCount || 0,
    type: item.type || '',
    message: item.message || '',
  });
}

function hydratePendingStates() {
  const playlistItems = state.playlistSnapshot?.pending?.items || [];
  if (playlistItems.length > 0) {
    els.videoList.innerHTML = '';
    playlistItems.forEach(hydrateVideoItemFromSnapshot);
    if (state.playlistSnapshot?.pending?.url) {
      els.playlistUrl.value = state.playlistSnapshot.pending.url;
    }
  }

  const fileItems = state.uploadSnapshot?.pending?.items || [];
  if (fileItems.length > 0) {
    els.fileList.innerHTML = '';
    fileItems.forEach(hydrateFileItemFromSnapshot);
  }
}

function reconcileRowsWithKnownSources(sources) {
  const knownSourceIds = new Set((sources || []).map(s => s.id));

  Array.from(els.videoList.children).forEach((row) => {
    const sourceId = row.dataset.sourceId;
    const status = row.dataset.status;
    if (!sourceId) return;

    if ((status === 'done' || status === 'skipped') && !knownSourceIds.has(sourceId)) {
      const videoId = row.id.replace('video-', '');
      updateVideoItem(videoId, 'held', 'Not indexed in current knowledge base. Retry to re-index.');
    }
  });

  Array.from(els.fileList.children).forEach((row) => {
    const sourceId = row.dataset.sourceId;
    const status = row.dataset.status;
    if (!sourceId) return;

    if (status === 'done' && !knownSourceIds.has(sourceId)) {
      addFileItem(row.dataset.filename || sourceId, 'failed', {
        id: row.dataset.itemId || '',
        sourceId,
        message: 'Not indexed in current knowledge base. Re-upload to index again.',
      });
    }
  });
}

function hydrateSourceLists(sources) {
  if (!Array.isArray(sources)) return;

  for (const source of sources) {
    if (source.type === 'video') {
      const videoId = extractVideoIdFromSource(source);
      if (!videoId) continue;

      const existing = document.getElementById(`video-${videoId}`);
      if (!existing) {
        addVideoItem(videoId, source.name || `Video ${videoId}`, source.duration || 'Unknown', 'done');
      }
      updateVideoItem(videoId, 'done', 'Loaded from existing knowledge base');
      continue;
    }

    if (source.type === 'file') {
      addFileItem(source.name || source.id, 'done', {
        sourceId: source.id,
        chunkCount: source.chunkCount || 0,
        charCount: source.charCount || 0,
        type: source.fileType || '',
      });
    }
  }
}

function onInlineSourceRemoveClick(event) {
  // Deprecated; kept for backward compatibility
}

function onVideoRowActionClick(event) {
  const retryButton = event.target.closest('.source-retry-btn');
  if (retryButton && retryButton.dataset.videoId) {
    retryPlaylistVideo(retryButton.dataset.videoId, retryButton);
    return;
  }

  const removeButton = event.target.closest('.source-remove-btn');
  if (removeButton) {
    const row = removeButton.closest('.video-item');
    const sourceId = removeButton.dataset.sourceId;
    const sourceType = removeButton.dataset.sourceType;
    if (!sourceId) return;

    const label = row?.querySelector('.video-title')?.textContent?.trim() || sourceId;
    removeKnowledgeSource(sourceId, sourceType, label, row, removeButton);
  }
}

function onFileRowActionClick(event) {
  const retryButton = event.target.closest('.source-retry-btn');
  if (retryButton && retryButton.dataset.itemId) {
    retryUploadedFile(retryButton.dataset.itemId, retryButton);
    return;
  }

  const removeButton = event.target.closest('.source-remove-btn');
  if (removeButton) {
    const row = removeButton.closest('.file-item');
    const sourceId = removeButton.dataset.sourceId;
    const sourceType = removeButton.dataset.sourceType;
    if (!sourceId) return;

    const label = row?.querySelector('.file-name')?.textContent?.trim() || sourceId;
    removeKnowledgeSource(sourceId, sourceType, label, row, removeButton);
  }
}

async function retryPlaylistVideo(videoId, button) {
  button.disabled = true;
  try {
    setStatus(els.playlistStatus, 'Retrying selected video...');
    const response = await fetch(`/api/playlist/retry/${encodeURIComponent(videoId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Retry failed');
    }

    if (data.item) {
      hydrateVideoItemFromSnapshot(data.item);
    }

    setStatus(els.playlistStatus, 'Video retry completed.', 'success');
    await refreshKnowledgeAndSnapshots(false);
  } catch (err) {
    setStatus(els.playlistStatus, `Error: ${err.message}`, 'error');
    if (isApiKeyIssue(err.message)) handleApiKeyFailure(err.message);
  } finally {
    button.disabled = false;
  }
}

async function retryUploadedFile(itemId, button) {
  button.disabled = true;
  try {
    setStatus(els.uploadStatus, 'Retrying selected file...');
    const response = await fetch(`/api/upload/retry/${encodeURIComponent(itemId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Retry failed');
    }

    if (data.item) {
      hydrateFileItemFromSnapshot(data.item);
    }

    setStatus(els.uploadStatus, 'File retry completed.', 'success');
    await refreshKnowledgeAndSnapshots(false);
  } catch (err) {
    setStatus(els.uploadStatus, `Error: ${err.message}`, 'error');
    if (isApiKeyIssue(err.message)) handleApiKeyFailure(err.message);
  } finally {
    button.disabled = false;
  }
}

async function removeKnowledgeSource(sourceId, sourceType, label, row, button) {
  const thing = sourceType === 'video' ? 'transcript' : 'file';
  const confirmed = window.confirm(`Remove this ${thing} from the knowledge base?\n\n${label}\n\nThis cannot be undone.`);
  if (!confirmed) return;

  button.disabled = true;

  try {
    const response = await fetch(`/api/playlist/source/${encodeURIComponent(sourceId)}`, {
      method: 'DELETE',
    });
    const data = await response.json();

    if (!response.ok || data.error) {
      throw new Error(data.error || 'Failed to remove source');
    }

    if (row) row.remove();
    updateKnowledgeStats(data.sources || [], data.totalChunks || 0);
    await refreshKnowledgeAndSnapshots(false);
    await clearChat();

    const statusEl = sourceType === 'video' ? els.playlistStatus : els.uploadStatus;
    setStatus(statusEl, `Removed ${thing} from knowledge base. Chat reset to avoid stale context.`, 'success');
  } catch (err) {
    const statusEl = sourceType === 'video' ? els.playlistStatus : els.uploadStatus;
    setStatus(statusEl, `Error: ${err.message}`, 'error');
  } finally {
    button.disabled = false;
  }
}

async function loadSources() {
  try {
    const response = await fetch('/api/playlist/sources');
    const data = await response.json();
    hydrateSourceLists(data.sources || []);
    reconcileRowsWithKnownSources(data.sources || []);
    updateKnowledgeStats(data.sources || [], data.totalChunks || 0);
  } catch (e) { /* ignore on startup */ }
}

// ===== BOOT =====
init();
