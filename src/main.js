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
  playlistPaused: false,
  cancelPlaylistInFlight: false,
  playlistAbortController: null,
  sidebarOpen: true,
  playlistSnapshot: null,
  uploadSnapshot: null,
  modal: {
    active: null,
    lastFocused: null,
    onEscape: null,
  },
  sourcePanel: {
    open: false,
    lastTrigger: null,
  },
};
localStorage.setItem('session_id', state.sessionId);
let sourceSyncTimer = null;

// ===== DOM REFS =====
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const els = {
  apiModal: $('#api-modal'),
  apiModalCard: $('#api-modal .modal-card'),
  resumeModal: $('#resume-modal'),
  resumeModalCard: $('#resume-modal .modal-card'),
  resumeModalSummary: $('#resume-modal-summary'),
  resumeNow: $('#resume-now'),
  resumeLater: $('#resume-later'),
  settingsModal: $('#settings-modal'),
  settingsModalCard: $('#settings-modal .modal-card'),
  settingsClose: $('#settings-close'),
  settingsBackHome: $('#settings-back-home'),
  settingsApiKeyInput: $('#settings-api-key-input'),
  settingsSaveKey: $('#settings-save-key'),
  settingsDeleteKey: $('#settings-delete-key'),
  settingsKeyStatus: $('#settings-key-status'),
  settingsStatus: $('#settings-status'),
  settingsClearSources: $('#settings-clear-sources'),
  settingsClearChat: $('#settings-clear-chat'),
  apiKeyInput: $('#api-key-input'),
  apiKeySave: $('#api-key-save'),
  apiHint: $('#api-modal .modal-hint'),
  mainLayout: $('#main-layout'),
  sidebar: $('#sidebar'),
  sidebarToggle: $('#sidebar-toggle'),
  sidebarOpen: $('#sidebar-open'),
  playlistUrl: $('#playlist-url'),
  loadPlaylist: $('#load-playlist'),
  cancelPlaylist: $('#cancel-playlist'),
  retryPlaylist: $('#retry-playlist'),
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

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const CHAT_INPUT_PLACEHOLDER = 'Ask a question about your loaded sources...';

// ===== INIT =====
async function init() {
  setupEventListeners();
  initSourcePanelAccessibility();
  switchTab('playlist');

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
      showModal('The saved API key is not working. Enter a new key to update .env.', true);
      return;
    }

    showModal();
    return;
  } catch (e) { /* server not ready yet */ }

  showModal('Could not verify the server API key. Start the backend, then try again.', true);
}

async function refreshKnowledgeAndSnapshots(showResumePrompt) {
  await Promise.all([loadSources(), loadPendingSnapshots()]);
  if (showResumePrompt) maybeShowResumeModal();
}

function showApp() {
  deactivateModal(els.apiModal, { restoreFocus: false });
  deactivateModal(els.resumeModal, { restoreFocus: false });
  deactivateModal(els.settingsModal, { restoreFocus: false });
  els.mainLayout.style.display = 'flex';
  syncApiKeyDependentUI();
}

function showModal(message = '', isError = false) {
  if (message) {
    setApiHint(message, isError);
  } else {
    setApiHint('Your API key is saved in .env and used only by the server.');
  }
  els.apiKeyInput.value = '';
  activateModal(els.apiModal, {
    initialFocus: els.apiKeyInput,
    onEscape: null,
  });
  els.mainLayout.style.display = 'none';
}

function showResumeModal(summary) {
  els.resumeModalSummary.textContent = summary;
  activateModal(els.resumeModal, {
    initialFocus: els.resumeNow,
    onEscape: deferHeldJobs,
  });
}

function hideResumeModal() {
  deactivateModal(els.resumeModal, { restoreFocus: true });
}

function getFocusableElements(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.hasAttribute('hidden')) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
}

function activateModal(modalEl, options = {}) {
  if (!modalEl) return;

  if (state.modal.active && state.modal.active !== modalEl) {
    deactivateModal(state.modal.active, { restoreFocus: false });
  }

  state.modal.lastFocused = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  state.modal.active = modalEl;
  state.modal.onEscape = typeof options.onEscape === 'function' ? options.onEscape : null;

  modalEl.classList.remove('hidden');
  modalEl.setAttribute('aria-hidden', 'false');

  const focusable = getFocusableElements(modalEl);
  const preferred = options.initialFocus;
  const target = preferred && !preferred.disabled ? preferred : focusable[0] || null;
  if (target && typeof target.focus === 'function') {
    target.focus();
  } else {
    const card = modalEl.querySelector('.modal-card');
    if (card instanceof HTMLElement) card.focus();
  }

  document.removeEventListener('keydown', handleModalKeydown, true);
  document.addEventListener('keydown', handleModalKeydown, true);
}

function deactivateModal(modalEl, options = {}) {
  if (!modalEl) return;

  modalEl.classList.add('hidden');
  modalEl.setAttribute('aria-hidden', 'true');

  if (state.modal.active === modalEl) {
    const restoreTarget = state.modal.lastFocused;
    state.modal.active = null;
    state.modal.onEscape = null;
    state.modal.lastFocused = null;
    document.removeEventListener('keydown', handleModalKeydown, true);

    if (options.restoreFocus && restoreTarget && typeof restoreTarget.focus === 'function') {
      restoreTarget.focus();
    }
  }
}

function handleModalKeydown(event) {
  const modalEl = state.modal.active;
  if (!modalEl) return;

  if (event.key === 'Escape') {
    if (typeof state.modal.onEscape === 'function') {
      event.preventDefault();
      state.modal.onEscape();
    }
    return;
  }

  if (event.key !== 'Tab') return;

  const focusable = getFocusableElements(modalEl);
  if (focusable.length === 0) {
    event.preventDefault();
    const card = modalEl.querySelector('.modal-card');
    if (card instanceof HTMLElement) card.focus();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function maybeShowResumeModal() {
  const playlistPending = state.playlistSnapshot?.canResume;
  const uploadPending = state.uploadSnapshot?.canResume;
  if (!playlistPending && !uploadPending) return;

  const parts = [];
  if (playlistPending && state.playlistSnapshot?.pending) {
    const p = state.playlistSnapshot.pending;
    parts.push(`Playlist: ${p.heldVideos || 0} paused, ${p.failedVideos || 0} failed`);
  }
  if (uploadPending && state.uploadSnapshot?.pending) {
    const u = state.uploadSnapshot.pending;
    parts.push(`Files: ${u.heldFiles || 0} paused, ${u.failedFiles || 0} failed`);
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
  els.changeKey.addEventListener('click', () => openSettingsModal());
  if (els.settingsClose) els.settingsClose.addEventListener('click', closeSettingsModal);
  if (els.settingsBackHome) els.settingsBackHome.addEventListener('click', closeSettingsModal);
  if (els.settingsSaveKey) els.settingsSaveKey.addEventListener('click', saveSettingsApiKey);
  if (els.settingsApiKeyInput) {
    els.settingsApiKeyInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveSettingsApiKey();
    });
  }
  if (els.settingsDeleteKey) els.settingsDeleteKey.addEventListener('click', deleteSettingsApiKey);
  if (els.settingsClearSources) els.settingsClearSources.addEventListener('click', clearAllSourcesFromSettings);
  if (els.settingsClearChat) {
    els.settingsClearChat.addEventListener('click', async () => {
      await clearChat();
      setStatus(els.settingsStatus, 'Chat cleared.', 'success');
    });
  }

  // Sidebar
  els.sidebarToggle.addEventListener('click', toggleSidebar);
  els.sidebarOpen.addEventListener('click', toggleSidebar);

  // Tabs
  $$('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    tab.addEventListener('keydown', handleTabKeydown);
  });

  // Playlist
  els.loadPlaylist.addEventListener('click', loadPlaylist);
  if (els.cancelPlaylist) {
    els.cancelPlaylist.addEventListener('click', cancelPlaylistProcessing);
  }
  if (els.retryPlaylist) {
    els.retryPlaylist.addEventListener('click', retryPausedPlaylist);
  }
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
  if (els.welcomeScreen) {
    els.welcomeScreen.addEventListener('click', handleStarterPromptClick);
  }

  // Sources
  els.closeSources.addEventListener('click', () => closeSourcePanel());
  els.videoList.addEventListener('click', onVideoRowActionClick);
  els.fileList.addEventListener('click', onFileRowActionClick);
  document.addEventListener('keydown', handleGlobalKeydown);

  // Resume modal
  els.resumeNow.addEventListener('click', resumeHeldJobs);
  els.resumeLater.addEventListener('click', deferHeldJobs);
}

function handleStarterPromptClick(event) {
  const chip = event.target.closest('.prompt-chip');
  if (!chip) return;

  const prompt = chip.dataset.prompt?.trim();
  if (!prompt) return;

  els.chatInput.value = prompt;
  autoResizeTextarea();
  els.chatInput.focus();
}

function handleTabKeydown(event) {
  const tabs = Array.from($$('.tab'));
  const currentIndex = tabs.indexOf(event.currentTarget);
  if (currentIndex === -1) return;

  let nextIndex = currentIndex;
  if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
  if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
  if (event.key === 'Home') nextIndex = 0;
  if (event.key === 'End') nextIndex = tabs.length - 1;

  if (nextIndex === currentIndex) return;
  event.preventDefault();
  const nextTab = tabs[nextIndex];
  switchTab(nextTab.dataset.tab);
  nextTab.focus();
}

function initSourcePanelAccessibility() {
  if (!els.sourcePanel) return;
  els.sourcePanel.setAttribute('role', 'region');
  els.sourcePanel.setAttribute('aria-hidden', 'true');
}

function setSourceBadgeExpandedState(expanded) {
  const badges = document.querySelectorAll('.source-badge');
  badges.forEach((badge) => {
    badge.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });
}

function openSourcePanel(triggerEl) {
  if (!els.sourcePanel) return;
  state.sourcePanel.open = true;
  state.sourcePanel.lastTrigger = triggerEl instanceof HTMLElement
    ? triggerEl
    : document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  els.sourcePanel.classList.add('open');
  els.sourcePanel.setAttribute('aria-hidden', 'false');
  setSourceBadgeExpandedState(true);
  if (els.closeSources && typeof els.closeSources.focus === 'function') {
    els.closeSources.focus();
  }
}

function closeSourcePanel() {
  if (!els.sourcePanel) return;
  state.sourcePanel.open = false;
  els.sourcePanel.classList.remove('open');
  els.sourcePanel.setAttribute('aria-hidden', 'true');
  setSourceBadgeExpandedState(false);

  const target = state.sourcePanel.lastTrigger;
  state.sourcePanel.lastTrigger = null;
  if (target && typeof target.focus === 'function') {
    target.focus();
  }
}

function handleGlobalKeydown(event) {
  if (event.key !== 'Escape') return;
  if (state.modal.active) return;
  if (!state.sourcePanel.open) return;
  event.preventDefault();
  closeSourcePanel();
}

// ===== API KEY =====
function hasApiKey() {
  return Boolean(state.apiKey);
}

function syncApiKeyDependentUI() {
  const missingKey = !hasApiKey();
  if (!state.isStreaming) {
    els.sendBtn.disabled = missingKey;
  }
  els.chatInput.placeholder = missingKey
    ? 'Add API key in Settings to continue chatting...'
    : CHAT_INPUT_PLACEHOLDER;
}

function closeSettingsModal() {
  deactivateModal(els.settingsModal, { restoreFocus: true });
}

async function refreshSettingsKeyStatus() {
  if (!els.settingsKeyStatus) return;

  try {
    const response = await fetch('/api/config');
    const raw = await response.text();
    const config = raw ? JSON.parse(raw) : {};

    if (config.hasKey && config.isValid) {
      els.settingsKeyStatus.textContent = `Connected (${config.keyPreview || 'nvapi-***'})`;
      if (els.settingsDeleteKey) els.settingsDeleteKey.disabled = false;
      return;
    }

    if (config.hasKey && !config.isValid) {
      els.settingsKeyStatus.textContent = 'Configured key is invalid';
      if (els.settingsDeleteKey) els.settingsDeleteKey.disabled = false;
      return;
    }

    els.settingsKeyStatus.textContent = 'Missing';
    if (els.settingsDeleteKey) els.settingsDeleteKey.disabled = true;
  } catch {
    els.settingsKeyStatus.textContent = hasApiKey() ? 'Connected' : 'Unknown';
    if (els.settingsDeleteKey) els.settingsDeleteKey.disabled = !hasApiKey();
  }
}

function openSettingsModal(statusMessage = '', isError = false) {
  if (els.settingsStatus) {
    els.settingsStatus.innerHTML = '';
    if (statusMessage) {
      setStatus(els.settingsStatus, statusMessage, isError ? 'error' : '');
    }
  }

  if (els.settingsApiKeyInput) {
    els.settingsApiKeyInput.value = '';
  }

  refreshSettingsKeyStatus();
  activateModal(els.settingsModal, {
    initialFocus: els.settingsApiKeyInput,
    onEscape: closeSettingsModal,
  });
}

async function saveApiKeyToServer(key) {
  const response = await fetch('/api/config/api-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  });
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(raw || `API request failed (${response.status})`);
  }

  if (!response.ok || data.error) {
    throw new Error(data.error || 'Could not save API key');
  }

  return data;
}

async function removeApiKeyFromServer() {
  const response = await fetch('/api/config/api-key', {
    method: 'DELETE',
  });
  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(raw || `API request failed (${response.status})`);
  }

  if (!response.ok || data.error) {
    throw new Error(data.error || 'Could not delete API key');
  }

  return data;
}

async function saveApiKey() {
  const key = els.apiKeyInput.value.trim();
  if (!key) {
    setApiHint('Please enter a valid NVIDIA API key.', true);
    return;
  }

  els.apiKeySave.disabled = true;
  setApiHint('Validating key and saving it to .env...');

  try {
    const data = await saveApiKeyToServer(key);

    state.apiKey = '__env__';
    state.envKeyPreview = data.keyPreview || null;
    syncApiKeyDependentUI();
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

async function saveSettingsApiKey() {
  const key = els.settingsApiKeyInput?.value.trim() || '';
  if (!key) {
    setStatus(els.settingsStatus, 'Enter a valid NVIDIA API key.', 'error');
    return;
  }

  els.settingsSaveKey.disabled = true;
  setStatus(els.settingsStatus, 'Validating and saving API key...');

  try {
    const data = await saveApiKeyToServer(key);
    state.apiKey = '__env__';
    state.envKeyPreview = data.keyPreview || null;
    syncApiKeyDependentUI();
    if (els.settingsApiKeyInput) els.settingsApiKeyInput.value = '';
    setStatus(els.settingsStatus, `Connected (${data.keyPreview || 'nvapi-***'}).`, 'success');
    await refreshSettingsKeyStatus();
    await refreshKnowledgeAndSnapshots(false);
  } catch (err) {
    setStatus(els.settingsStatus, err.message, 'error');
  } finally {
    els.settingsSaveKey.disabled = false;
  }
}

async function deleteSettingsApiKey() {
  const confirmed = window.confirm(
    'Delete saved API key from this workspace?\n\nYou will stay in chat, but sending new messages and processing sources will require adding a key again.'
  );
  if (!confirmed) return;

  els.settingsDeleteKey.disabled = true;
  setStatus(els.settingsStatus, 'Removing API key...');

  try {
    await removeApiKeyFromServer();
    state.apiKey = '';
    state.envKeyPreview = null;
    syncApiKeyDependentUI();
    setStatus(els.settingsStatus, 'API key removed. Add a key to continue.', 'success');
    await refreshSettingsKeyStatus();
  } catch (err) {
    setStatus(els.settingsStatus, err.message, 'error');
    await refreshSettingsKeyStatus();
  } finally {
    els.settingsDeleteKey.disabled = false;
  }
}

function requireApiKey(message, statusContainer) {
  if (hasApiKey()) return true;

  const prompt = message || 'Add your NVIDIA API key in Settings to continue.';
  if (statusContainer) {
    setStatus(statusContainer, prompt, 'error');
  }
  openSettingsModal(prompt, true);
  return false;
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
  syncApiKeyDependentUI();
  openSettingsModal(`The saved API key failed: ${message}. Add a new key to continue.`, true);
}

// ===== SIDEBAR =====
function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  els.sidebar.classList.toggle('collapsed');
  els.sidebarOpen.style.display = state.sidebarOpen ? 'none' : 'flex';
}

function switchTab(tabName) {
  $$('.tab').forEach((t) => {
    const isActive = t.dataset.tab === tabName;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
    t.setAttribute('tabindex', isActive ? '0' : '-1');
  });

  $$('.tab-panel').forEach((p) => {
    const isActive = p.id === `tab-${tabName}`;
    p.classList.toggle('active', isActive);
    p.setAttribute('aria-hidden', isActive ? 'false' : 'true');
  });
}

// ===== PLAYLIST LOADING =====
async function loadPlaylist() {
  if (state.isPlaylistProcessing) return;
  if (!requireApiKey('Add API key in Settings before loading a playlist.', els.playlistStatus)) return;

  const url = els.playlistUrl.value.trim();
  if (!url) {
    setStatus(els.playlistStatus, 'Paste a YouTube playlist URL to continue.', 'error');
    els.playlistUrl.focus();
    return;
  }

  const normalizedUrl = normalizePlaylistUrl(url);
  if (!normalizedUrl) {
    setStatus(
      els.playlistStatus,
      'Enter a valid YouTube playlist URL that includes `list=`.',
      'error'
    );
    els.playlistUrl.focus();
    return;
  }

  await streamPlaylistRequest('/api/playlist/load', { url: normalizedUrl, apiKey: state.apiKey });
}

function normalizePlaylistUrl(input) {
  if (!input) return null;

  const candidates = [input];
  if (!/^https?:\/\//i.test(input)) {
    candidates.push(`https://${input}`);
  }

  for (const raw of candidates) {
    try {
      const parsed = new URL(raw);
      const host = parsed.hostname.toLowerCase();
      const isYoutubeHost =
        host === 'youtube.com'
        || host === 'www.youtube.com'
        || host === 'm.youtube.com'
        || host === 'music.youtube.com'
        || host === 'youtu.be';

      if (!isYoutubeHost) continue;

      const playlistId = parsed.searchParams.get('list');
      if (!playlistId || playlistId.trim().length === 0) continue;

      return parsed.toString();
    } catch {
      // Try next candidate
    }
  }

  return null;
}

async function resumePlaylist() {
  return streamPlaylistRequest('/api/playlist/resume', { apiKey: state.apiKey });
}

async function resumeFiles() {
  if (!requireApiKey('Add API key in Settings before resuming files.', els.uploadStatus)) return;

  try {
    setStatus(els.uploadStatus, 'Resuming paused file processing...');
    const response = await fetch('/api/upload/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Could not resume paused files');
    }

    if (Array.isArray(data.items)) {
      data.items.forEach(item => hydrateFileItemFromSnapshot(item));
    }

    setStatus(els.uploadStatus, 'Paused files finished processing.', 'success');
    await loadPendingSnapshots();
    await loadSources();
  } catch (err) {
    setStatus(els.uploadStatus, `Could not resume files: ${err.message}`, 'error');
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

    if (!state.playlistSnapshot?.canResume) {
      state.playlistPaused = false;
    }

    if (state.playlistPaused) {
      state.isPlaylistProcessing = false;
    } else {
      state.isPlaylistProcessing = !!state.playlistSnapshot?.running;
      if (!state.isPlaylistProcessing && !!state.playlistSnapshot?.canResume) {
        state.playlistPaused = true;
      }
    }

    updatePlaylistControls();
    hydratePendingStates();
  } catch {
    state.playlistSnapshot = null;
    state.uploadSnapshot = null;
    state.isPlaylistProcessing = false;
    state.playlistPaused = false;
    updatePlaylistControls();
  }
}

function updatePlaylistControls() {
  const isProcessing = state.isPlaylistProcessing;
  const showRetry = !isProcessing && state.playlistPaused;

  els.loadPlaylist.style.display = showRetry ? 'none' : 'inline-flex';
  els.loadPlaylist.disabled = isProcessing;
  els.loadPlaylistText.style.display = isProcessing ? 'none' : 'inline';
  els.playlistSpinner.style.display = isProcessing ? 'block' : 'none';

  if (els.cancelPlaylist) {
    els.cancelPlaylist.style.display = isProcessing ? 'inline-flex' : 'none';
    els.cancelPlaylist.disabled = !isProcessing || state.cancelPlaylistInFlight;
    els.cancelPlaylist.textContent = state.cancelPlaylistInFlight ? 'Cancelling...' : 'Cancel';
  }

  if (els.retryPlaylist) {
    els.retryPlaylist.style.display = showRetry ? 'inline-flex' : 'none';
    els.retryPlaylist.disabled = isProcessing || state.cancelPlaylistInFlight;
  }
}

function markRemainingPlaylistItemsHeld() {
  Array.from(els.videoList.children).forEach((row) => {
    const status = row.dataset.status;
    if (status !== 'pending' && status !== 'processing' && status !== 'embedding') return;

    const videoId = row.id.replace('video-', '');
    if (!videoId) return;
    updateVideoItem(videoId, 'held', 'Paused. Click Retry to continue.');
  });
}

async function cancelPlaylistProcessing() {
  if (!state.isPlaylistProcessing || state.cancelPlaylistInFlight) return;

  state.cancelPlaylistInFlight = true;
  updatePlaylistControls();

  try {
    setStatus(els.playlistStatus, 'Cancelling playlist processing. Remaining videos will be paused...');
    const response = await fetch('/api/playlist/defer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey }),
    });

    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }

    if (!response.ok || data.error) {
      throw new Error(data.error || 'Could not cancel playlist processing');
    }

    if (state.playlistAbortController) {
      state.playlistAbortController.abort();
    }

    state.playlistPaused = true;
    state.isPlaylistProcessing = false;
    updatePlaylistControls();
    markRemainingPlaylistItemsHeld();
    if (Array.isArray(data.pending?.items)) {
      data.pending.items.forEach(hydrateVideoItemFromSnapshot);
    }

    setStatus(els.playlistStatus, 'Playlist paused. Remaining videos are held; use Retry on any video to continue later.', 'success');
    await loadSources();
  } catch (err) {
    setStatus(els.playlistStatus, `Could not cancel playlist processing: ${err.message}`, 'error');
    if (isApiKeyIssue(err.message)) handleApiKeyFailure(err.message);
  } finally {
    state.cancelPlaylistInFlight = false;
    updatePlaylistControls();
  }
}

async function retryPausedPlaylist() {
  if (state.isPlaylistProcessing || state.cancelPlaylistInFlight) return;
  if (!requireApiKey('Add API key in Settings before resuming this playlist.', els.playlistStatus)) return;

  state.playlistPaused = false;
  updatePlaylistControls();
  setStatus(els.playlistStatus, 'Resuming paused playlist videos...');

  const resumed = await resumePlaylist();
  if (resumed) return;

  await loadPendingSnapshots();
  if (state.playlistSnapshot?.canResume) {
    state.playlistPaused = true;
    updatePlaylistControls();
  }
}

async function streamPlaylistRequest(endpoint, payload) {
  const shouldClearList = endpoint === '/api/playlist/load' || endpoint === '/api/playlist/resume';
  let success = false;
  state.playlistPaused = false;
  state.isPlaylistProcessing = true;
  state.playlistAbortController = new AbortController();
  updatePlaylistControls();

  if (shouldClearList) els.videoList.innerHTML = '';
  els.playlistStatus.innerHTML = '';

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: state.playlistAbortController.signal,
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

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
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
    if (err?.name !== 'AbortError') {
      setStatus(els.playlistStatus, `Could not process this playlist: ${err.message}`, 'error');
      if (isApiKeyIssue(err.message)) {
        handleApiKeyFailure(err.message);
      }
    }
  }

  state.playlistAbortController = null;
  state.isPlaylistProcessing = false;
  updatePlaylistControls();
  await refreshKnowledgeAndSnapshots(false);
  return success;
}

function handlePlaylistEvent(data) {
  if (data.videoCount !== undefined && data.videos) {
    // Playlist info received
    setStatus(els.playlistStatus, `Found ${data.videoCount} videos in "${data.title}". Processing now.`, 'success');
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
      setStatus(els.playlistStatus, `Processing video ${data.processed} of ${data.total}. You can keep chatting.`);
    }
    if (typeof data.totalSourcesInStore === 'number') {
      els.statSources.textContent = data.totalSourcesInStore;
    }
    if (typeof data.totalChunksInStore === 'number') {
      els.statChunks.textContent = data.totalChunksInStore;
    }
    if (typeof data.totalSourcesInStore === 'number' && typeof data.totalChunksInStore === 'number') {
      els.chatSubtitle.textContent = `${data.totalSourcesInStore} sources ready • ${data.totalChunksInStore} study sections indexed`;
    }
    if (data.status === 'done' || data.status === 'failed' || data.status === 'skipped') {
      scheduleSourceSync();
    }
    return;
  }

  if (data.totalVideos !== undefined) {
    // Complete
    setStatus(els.playlistStatus,
      `Done: ${data.processedVideos} videos indexed, ${data.failedVideos} failed. ${data.totalChunks} study sections ready.`,
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
  const safeTitle = escapeHtml(title);
  const safeDuration = escapeHtml(duration);
  let item = document.getElementById(`video-${id}`);
  if (!item) {
    item = document.createElement('div');
    item.className = 'video-item';
    item.id = `video-${id}`;
    item.dataset.sourceId = `video_${id}`;
    item.dataset.sourceType = 'video';
    item.innerHTML = `
      <span class="status-icon">⏳</span>
      <span class="video-title" title="${safeTitle}">${safeTitle}</span>
      <span class="video-duration">${safeDuration}</span>
      <button class="source-retry-btn hidden" title="Retry indexing this video" data-video-id="${id}">Retry</button>
      <button class="source-remove-btn hidden" title="Remove this transcript source" data-source-id="video_${id}" data-source-type="video">🗑</button>
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
      retryBtn.title = 'Retry indexing this video';
      retryBtn.dataset.videoId = id;
      retryBtn.textContent = 'Retry';
      item.appendChild(retryBtn);
    }

    if (!item.querySelector('.source-remove-btn')) {
      const removeBtn = document.createElement('button');
      removeBtn.className = 'source-remove-btn hidden';
      removeBtn.title = 'Remove this transcript source';
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
  if (!requireApiKey('Add API key in Settings before uploading files.', els.uploadStatus)) return;

  // Show file items as pending
  files.forEach(f => addFileItem(f.name, 'pending'));
  setStatus(els.uploadStatus, `Uploading ${files.length} file(s). Processing starts automatically.`);

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
      setStatus(els.uploadStatus, `Could not process uploaded files: ${data.error}`, 'error');
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
      `${successCount}/${data.results.length} files processed. ${data.totalChunks} study sections ready.`,
      'success'
    );
    await refreshKnowledgeAndSnapshots(false);
  } catch (err) {
    if (isApiKeyIssue(err.message)) {
      handleApiKeyFailure(err.message);
    }
    setStatus(els.uploadStatus, `Could not upload files: ${err.message}`, 'error');
  }
}

function addFileItem(filename, status, info) {
  const ext = escapeHtml(filename.split('.').pop().toUpperCase());
  const safeFilename = escapeHtml(filename);
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
    errorMsgHtml = `<div class="file-error-text">${escapeHtml(info.message)}</div>`;
  }

  const sourceId = item.dataset.sourceId || '';
  const itemId = item.dataset.itemId || '';
  const showRemove = status === 'done' && !!sourceId;
  const showRetry = (status === 'failed' || status === 'held') && !!itemId;

  item.innerHTML = `
    <div class="file-item-header">
      <span class="file-badge">${ext}</span>
      <span class="file-name" title="${safeFilename}">${safeFilename}</span>
      <span class="file-status">${iconMap[status] || '⏳'}</span>
      <button class="source-retry-btn ${showRetry ? '' : 'hidden'}" title="Retry indexing this file" data-item-id="${itemId}">Retry</button>
      <button class="source-remove-btn ${showRemove ? '' : 'hidden'}" title="Remove this file source" data-source-id="${sourceId}" data-source-type="file">🗑</button>
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
  if (!requireApiKey('Add API key in Settings before sending a message.')) return;

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

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Chat request failed (${response.status})`);
    }
    if (!response.body) {
      throw new Error('Streaming response was empty');
    }

    // Remove typing indicator
    removeTyping(typingId);

    // Stream the response
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullResponse = '';
    let sources = [];
    let streamError = '';
    let pendingRender = false;
    let renderRafId = 0;
    let renderTimerId = 0;
    let lastRenderAt = 0;
    let lastRenderedLength = 0;
    let currentEvent = 'message';
    const RENDER_INTERVAL_MS = 120;
    const msgEl = appendMessage('assistant', '');
    const contentEl = msgEl.querySelector('.message-text');

    function renderResponse() {
      if (!fullResponse) return;
      if (fullResponse.length === lastRenderedLength) return;
      contentEl.textContent = fullResponse;
      lastRenderedLength = fullResponse.length;
      scrollToBottom();
    }

    function renderFinalMarkdown() {
      if (!fullResponse) return;
      contentEl.innerHTML = marked.parse(fullResponse);
      scrollToBottom();
    }

    function flushRender() {
      if (renderTimerId) {
        clearTimeout(renderTimerId);
        renderTimerId = 0;
      }
      if (renderRafId) {
        cancelAnimationFrame(renderRafId);
        renderRafId = 0;
      }
      pendingRender = false;
      renderResponse();
    }

    function scheduleRender(force = false) {
      if (pendingRender && !force) return;

      const startRafRender = () => {
        if (renderRafId) return;
        pendingRender = true;
        renderRafId = requestAnimationFrame(() => {
          renderRafId = 0;
          lastRenderAt = performance.now();
          pendingRender = false;
          renderResponse();
        });
      };

      if (force) {
        flushRender();
        return;
      }

      const now = performance.now();
      const elapsed = now - lastRenderAt;
      const delay = Math.max(0, RENDER_INTERVAL_MS - elapsed);

      if (delay === 0) {
        startRafRender();
        return;
      }

      if (renderTimerId) return;
      pendingRender = true;
      renderTimerId = setTimeout(() => {
        renderTimerId = 0;
        startRafRender();
      }, delay);
    }

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          continue;
        }

        if (!line.startsWith('data: ')) continue;

        const payload = line.slice(6);
        if (!payload) continue;

        if (currentEvent === 'sources') {
          try {
            const parsedSources = JSON.parse(payload);
            if (Array.isArray(parsedSources)) {
              sources = parsedSources;
            }
          } catch (e) { /* skip */ }
          continue;
        }

        try {
          const data = JSON.parse(payload);
          if (data.token) {
            fullResponse += data.token;
            scheduleRender();
          } else if (data.message && currentEvent !== 'done') {
            streamError = data.message;
          }
        } catch (e) { /* skip */ }
      }
    }

    // Final render to ensure all content is displayed
    scheduleRender(true);
    renderFinalMarkdown();

    if (streamError && !fullResponse) {
      msgEl.remove();
      appendMessage('assistant', `I could not finish that response: ${streamError}`);
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
    appendMessage('assistant', `I could not send that request: ${err.message}`);
    if (isApiKeyIssue(err.message)) {
      handleApiKeyFailure(err.message);
    }
  }

  state.isStreaming = false;
  syncApiKeyDependentUI();
  els.chatInput.focus();
}

function appendMessage(role, content) {
  const div = document.createElement('div');
  div.className = `message ${role}`;

  const avatar = role === 'assistant'
    ? '<svg class="avatar-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="5" y="6" width="14" height="12" rx="4" stroke="currentColor" stroke-width="1.8"/><path d="M12 3.5V6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="9.5" cy="11.5" r="1" fill="currentColor"/><circle cx="14.5" cy="11.5" r="1" fill="currentColor"/><path d="M9 15C9.9 15.7 11 16 12 16C13 16 14.1 15.7 15 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
    : '<svg class="avatar-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><circle cx="12" cy="8.5" r="3.2" stroke="currentColor" stroke-width="1.8"/><path d="M6.5 18.5C7.6 15.9 9.6 14.5 12 14.5C14.4 14.5 16.4 15.9 17.5 18.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
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
    <div class="message-avatar"><svg class="avatar-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="5" y="6" width="14" height="12" rx="4" stroke="currentColor" stroke-width="1.8"/><path d="M12 3.5V6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="9.5" cy="11.5" r="1" fill="currentColor"/><circle cx="14.5" cy="11.5" r="1" fill="currentColor"/><path d="M9 15C9.9 15.7 11 16 12 16C13 16 14.1 15.7 15 15" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></div>
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
    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'source-badge';
    badge.textContent = `${s.source || `Source ${i + 1}`} (${s.similarity}%)`;
    badge.setAttribute('aria-label', `View source ${s.source || `Source ${i + 1}`}`);
    badge.setAttribute('aria-controls', 'source-panel');
    badge.setAttribute('aria-expanded', 'false');
    badge.addEventListener('click', () => showSources(sources, badge));
    sourcesDiv.appendChild(badge);
  });

  contentEl.appendChild(sourcesDiv);
}

function showSources(sources, triggerEl) {
  els.sourceList.innerHTML = '';
  sources.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'source-card';

    const header = document.createElement('div');
    header.className = 'source-card-header';

    const nameEl = document.createElement('span');
    nameEl.className = 'source-card-name';
    nameEl.textContent = s.source || `Source ${i + 1}`;

    const scoreEl = document.createElement('span');
    scoreEl.className = 'source-card-score';
    scoreEl.textContent = `${s.similarity}% match`;

    const textEl = document.createElement('div');
    textEl.className = 'source-card-text';
    textEl.textContent = s.text || '';

    const typeEl = document.createElement('div');
    typeEl.className = 'source-card-type';
    typeEl.textContent = s.type === 'video' ? 'Video transcript' : 'Uploaded file';

    header.appendChild(nameEl);
    header.appendChild(scoreEl);
    card.appendChild(header);
    card.appendChild(textEl);
    card.appendChild(typeEl);

    els.sourceList.appendChild(card);
  });
  openSourcePanel(triggerEl);
}

async function clearChat() {
  closeSourcePanel();
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

async function clearAllSourcesFromSettings() {
  const confirmed = window.confirm(
    'Clear all indexed sources and reset workspace data?\n\nThis removes playlist transcripts, uploaded document chunks, and chat memory.'
  );
  if (!confirmed) return;

  els.settingsClearSources.disabled = true;
  setStatus(els.settingsStatus, 'Clearing all sources...');

  try {
    const response = await fetch('/api/playlist/clear', { method: 'DELETE' });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }

    if (!response.ok || data.error) {
      throw new Error(data.error || 'Could not clear all sources');
    }

    if (state.playlistAbortController) {
      state.playlistAbortController.abort();
    }
    state.playlistAbortController = null;
    state.isPlaylistProcessing = false;
    state.playlistPaused = false;
    state.cancelPlaylistInFlight = false;
    updatePlaylistControls();

    els.videoList.innerHTML = '';
    els.fileList.innerHTML = '';
    els.playlistStatus.innerHTML = '';
    els.uploadStatus.innerHTML = '';
    els.messages.innerHTML = '';
    els.welcomeScreen.classList.remove('hidden');
    closeSourcePanel();

    state.sessionId = crypto.randomUUID();
    localStorage.setItem('session_id', state.sessionId);

    await refreshKnowledgeAndSnapshots(false);
    setStatus(els.settingsStatus, 'All sources cleared. Workspace reset complete.', 'success');
  } catch (err) {
    setStatus(els.settingsStatus, `Could not clear all sources: ${err.message}`, 'error');
  } finally {
    els.settingsClearSources.disabled = false;
  }
}

// ===== UTILITIES =====
function scrollToBottom() {
  els.messagesContainer.scrollTop = els.messagesContainer.scrollHeight;
}

function autoResizeTextarea() {
  els.chatInput.style.height = 'auto';
  els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, 150) + 'px';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setStatus(container, message, type = '') {
  const className = type === 'error' ? 'status-error' : type === 'success' ? 'status-success' : '';

  container.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  container.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const messageEl = document.createElement('div');
  messageEl.className = `status-msg ${className}`.trim();
  messageEl.textContent = String(message || '');

  container.innerHTML = '';
  container.appendChild(messageEl);
}

function updateKnowledgeStats(sources, totalChunks) {
  els.statSources.textContent = sources.length;
  els.statChunks.textContent = totalChunks;

  if (sources.length > 0) {
    els.chatSubtitle.textContent = `${sources.length} sources ready • ${totalChunks} study sections indexed`;
  } else {
    els.chatSubtitle.textContent = 'Skip long playlists. Load sources and ask your first question.';
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
      updateVideoItem(videoId, 'held', 'Not in the current knowledge base. Retry to index again.');
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
        message: 'Not in the current knowledge base. Re-upload to index again.',
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
  if (!requireApiKey('Add API key in Settings before retrying this video.', els.playlistStatus)) return;

  button.disabled = true;
  try {
    setStatus(els.playlistStatus, 'Retrying this video...');
    const response = await fetch(`/api/playlist/retry/${encodeURIComponent(videoId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'Video retry failed');
    }

    if (data.item) {
      hydrateVideoItemFromSnapshot(data.item);
    }

    const finalStatus = data.result?.status || data.item?.status;
    const finalMessage = data.result?.message || data.item?.message || '';
    if (finalStatus === 'done') {
      setStatus(els.playlistStatus, 'Video re-indexed successfully.', 'success');
    } else if (finalStatus === 'failed') {
      setStatus(els.playlistStatus, `Video retry finished, but it still failed: ${finalMessage || 'Unknown error'}`, 'error');
    } else {
      setStatus(els.playlistStatus, finalMessage || 'Video retry finished.', 'success');
    }

    await refreshKnowledgeAndSnapshots(false);
  } catch (err) {
    setStatus(els.playlistStatus, `Could not retry this video: ${err.message}`, 'error');
    if (isApiKeyIssue(err.message)) handleApiKeyFailure(err.message);
  } finally {
    button.disabled = false;
  }
}

async function retryUploadedFile(itemId, button) {
  if (!requireApiKey('Add API key in Settings before retrying this file.', els.uploadStatus)) return;

  button.disabled = true;
  try {
    setStatus(els.uploadStatus, 'Retrying this file...');
    const response = await fetch(`/api/upload/retry/${encodeURIComponent(itemId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: state.apiKey }),
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      throw new Error(data.error || 'File retry failed');
    }

    if (data.item) {
      hydrateFileItemFromSnapshot(data.item);
    }

    const finalStatus = data.item?.status;
    const finalMessage = data.item?.message || '';
    if (finalStatus === 'done') {
      setStatus(els.uploadStatus, 'File re-indexed successfully.', 'success');
    } else if (finalStatus === 'failed') {
      setStatus(els.uploadStatus, `File retry finished, but it still failed: ${finalMessage || 'Unknown error'}`, 'error');
    } else {
      setStatus(els.uploadStatus, finalMessage || 'File retry finished.', 'success');
    }

    await refreshKnowledgeAndSnapshots(false);
  } catch (err) {
    setStatus(els.uploadStatus, `Could not retry this file: ${err.message}`, 'error');
    if (isApiKeyIssue(err.message)) handleApiKeyFailure(err.message);
  } finally {
    button.disabled = false;
  }
}

async function removeKnowledgeSource(sourceId, sourceType, label, row, button) {
  const thing = sourceType === 'video' ? 'transcript' : 'file';
  const confirmed = window.confirm(`Remove this ${thing} from your sources?\n\n${label}\n\nThis action cannot be undone.`);
  if (!confirmed) return;

  button.disabled = true;

  try {
    const response = await fetch(`/api/playlist/source/${encodeURIComponent(sourceId)}`, {
      method: 'DELETE',
    });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }

    if (!response.ok || data.error) {
      throw new Error(data.error || 'Could not remove this source');
    }

    if (row && sourceType !== 'video') {
      row.remove();
    }

    if (row && sourceType === 'video') {
      const videoId = row.id.replace('video-', '');
      if (videoId) {
        updateVideoItem(videoId, 'held', 'Removed from knowledge base. Click Retry to index again.');
      }
    }

    updateKnowledgeStats(data.sources || [], data.totalChunks || 0);
    await refreshKnowledgeAndSnapshots(false);
    const statusEl = sourceType === 'video' ? els.playlistStatus : els.uploadStatus;
    setStatus(statusEl, `${thing[0].toUpperCase() + thing.slice(1)} removed from your sources.`, 'success');
  } catch (err) {
    const statusEl = sourceType === 'video' ? els.playlistStatus : els.uploadStatus;
    setStatus(statusEl, `Could not remove this ${thing}: ${err.message}`, 'error');
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
