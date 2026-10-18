import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { agentIconSvg } from './agent-icons.mjs';

const $ = selector => document.querySelector(selector);

let activeView = 'tasks';
let taskFilter = 'active';
let currentJobs = [];
let currentProviders = [];
let currentMcpConnections = { endpoint: '', service: { running: false }, providers: {} };
let terminal = null;
let fitAddon = null;
let terminalSessionId = null;
let terminalResizeObserver = null;
let chatgptBoundsObserver = null;
let googleMediaBoundsObserver = null;
let activeChatgptProfileId = 'web';
let jobsRefreshPromise = null;
let agentsRefreshPromise = null;
let jobsRenderSignature = '';
let jobsPollTimer = null;

function setBrowserCloseVisible(visible) {
  const button = $('#browserClose');
  if (button) button.hidden = visible !== true;
}

async function closeAllEmbeddedBrowsers() {
  await window.teamyra.closeEmbeddedBrowsers().catch(() => {});
  setBrowserCloseVisible(false);
  if (!$('#chatgptDetail').hidden) {
    $('#chatgptDetail').hidden = true;
    $('#agentsShelf').hidden = false;
  }
  if (activeView === 'agents') await refreshAgents().catch(() => {});
}
const transcriptState = new Map();

const ACTIVE_STATES = new Set(['queued', 'starting', 'running', 'waiting_for_desktop', 'waiting']);
const WORKER_META = {
  claude: { code: 'CL', icon: 'claude', cls: 'claude', label: 'Claude' },
  codex: { code: 'CX', icon: 'openai', cls: 'codex', label: 'Codex' },
  antigravity: { code: 'AG', icon: 'antigravity', cls: 'antigravity', label: 'Antigravity' },
  chatgpt: { code: 'GPT', icon: 'openai', cls: 'chatgpt', label: 'ChatGPT' },
  googleMedia: { code: 'GM', icon: '', cls: 'antigravity', label: 'Google Media' },
  other: { code: 'AI', icon: '', cls: '', label: 'Agent' }
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[ch]));
}

function safeSlug(value) {
  return String(value || 'account')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'account';
}

function workerIdForProfile(providerId, profileId) {
  if (providerId === 'claude') return profileId === 'native' ? 'claude1' : 'claude-' + safeSlug(profileId);
  if (providerId === 'codex') {
    if (profileId === 'native') return 'codex1';
    if (profileId === 'codex2') return 'codex2';
    return 'codex-' + safeSlug(profileId);
  }
  if (providerId === 'antigravity' && profileId === 'native') return 'antigravity';
  if (providerId === 'chatgpt-web') return profileId === 'web' ? 'chatgpt-normal' : 'chatgpt-' + safeSlug(profileId);
  return '';
}

function workerMeta(worker) {
  const value = String(worker || '').toLowerCase();
  if (value.includes('chatgpt')) return WORKER_META.chatgpt;
  if (value.includes('claude')) return WORKER_META.claude;
  if (value.includes('codex')) return WORKER_META.codex;
  if (value.includes('antigravity') || value.includes('agy')) return WORKER_META.antigravity;
  return WORKER_META.other;
}

function providerMeta(providerId) {
  if (providerId === 'chatgpt-web') return WORKER_META.chatgpt;
  if (providerId === 'google-media') return WORKER_META.googleMedia;
  return workerMeta(providerId);
}

function stateLabel(state) {
  const labels = {
    queued: 'Queued',
    starting: 'Starting',
    running: 'Working',
    waiting_for_desktop: 'Waiting',
    waiting: 'Waiting',
    done: 'Done',
    failed: 'Failed',
    cancelled: 'Stopped'
  };
  return labels[state] || String(state || 'Unknown');
}

function shortTime(value) {
  const seconds = Number(value) || 0;
  if (!seconds) return '';
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (delta < 60) return 'now';
  if (delta < 3600) return Math.floor(delta / 60) + 'm';
  if (delta < 86400) return Math.floor(delta / 3600) + 'h';
  return Math.floor(delta / 86400) + 'd';
}

function taskTitle(job) {
  return job.label && job.label !== job.id ? job.label : 'Task ' + String(job.id || '').slice(0, 8);
}

function isActive(job) {
  return ACTIVE_STATES.has(job.state);
}

function setView(view) {
  activeView = view === 'agents' ? 'agents' : 'tasks';
  $('#tasksView').hidden = activeView !== 'tasks';
  $('#agentsView').hidden = activeView !== 'agents';
  $('#navTasks').classList.toggle('active', activeView === 'tasks');
  $('#navAgents').classList.toggle('active', activeView === 'agents');

  if (activeView !== 'agents' || !$('#chatgptDetail').hidden) {
    const showChat = activeView === 'agents' && !$('#chatgptDetail').hidden;
    window.teamyra.setChatgptVisible(showChat).catch(() => {});
  }
  if (activeView !== 'agents') {
    window.teamyra.setGoogleMediaVisible(false).catch(() => {});
    setBrowserCloseVisible(false);
  }

  if (activeView === 'tasks') refreshJobs().catch(() => {});
  else refreshAgents().catch(() => {});
}

function updateLiveBadge() {
  const active = currentJobs.filter(isActive).length;
  $('#liveBadge').hidden = active === 0;
  $('#liveLabel').textContent = active === 1 ? '1 live' : active + ' live';
}

async function loadTranscriptPreview(job) {
  const state = transcriptState.get(job.id) || { offset: 0, text: '' };
  try {
    let loops = 0;
    do {
      const result = await window.teamyra.transcript(job.id, state.offset);
      const chunk = String(result?.text || '');
      if (chunk) state.text = (state.text + chunk).slice(-12000);
      const next = Number(result?.next) || state.offset;
      if (next <= state.offset || chunk.length < 200000) {
        state.offset = next;
        break;
      }
      state.offset = next;
      loops += 1;
    } while (loops < 4);
    if (!state.text.trim() && job.lastEvent) state.text = String(job.lastEvent);
  } catch (error) {
    if (!state.text.trim()) state.text = String(job.lastEvent || error?.message || 'No output yet.');
  }
  state.jobState = job.state;
  transcriptState.set(job.id, state);
  const output = document.querySelector('[data-task-output="' + CSS.escape(job.id) + '"]');
  if (output) {
    output.textContent = state.text || 'Waiting for agent output…';
    output.classList.toggle('empty', !state.text.trim());
    output.scrollTop = output.scrollHeight;
  }
}

function taskCardHtml(job) {
  const meta = workerMeta(job.worker);
  const active = isActive(job);
  const preview = transcriptState.get(job.id)?.text || job.lastEvent || (active ? 'Agent is starting…' : 'No transcript preview.');
  return `
    <article class="task-card ${active ? 'running' : ''}" data-job-id="${escapeHtml(job.id)}">
      <div class="task-head">
        <span class="agent-avatar ${meta.cls}">${agentIconSvg(meta.icon) || escapeHtml(meta.code)}</span>
        <div class="task-title">
          <strong title="${escapeHtml(taskTitle(job))}">${escapeHtml(taskTitle(job))}</strong>
          <span>${escapeHtml(meta.label)} · ${escapeHtml(shortTime(job.started || job.created))}</span>
        </div>
        <span class="status-pill ${escapeHtml(job.state)}"><i class="status-dot"></i>${escapeHtml(stateLabel(job.state))}</span>
      </div>
      <pre class="task-output ${preview ? '' : 'empty'}" data-task-output="${escapeHtml(job.id)}">${escapeHtml(preview)}</pre>
      <div class="task-foot">
        <span class="task-path" title="${escapeHtml(job.cwd)}">${escapeHtml(job.cwd || job.branch || '')}</span>
        ${active ? `<button class="task-cancel" type="button" data-cancel-job="${escapeHtml(job.id)}">Stop</button>` : ''}
      </div>
    </article>
  `;
}

function renderJobs() {
  const jobs = taskFilter === 'active'
    ? currentJobs.filter(isActive)
    : currentJobs.slice(0, 18);

  const desk = $('#taskDesk');
  if (!jobs.length) {
    desk.innerHTML = `
      <div class="empty-state">
        <div class="empty-orb"></div>
        <strong>${taskFilter === 'active' ? 'No active tasks' : 'No tasks yet'}</strong>
        <span>${taskFilter === 'active' ? 'Start one and its agent will appear here.' : 'Your recent agent work will appear here.'}</span>
      </div>
    `;
    return;
  }

  desk.innerHTML = jobs.map(taskCardHtml).join('');
  desk.querySelectorAll('[data-cancel-job]').forEach(button => {
    button.addEventListener('click', async () => {
      const id = button.dataset.cancelJob;
      button.disabled = true;
      button.textContent = 'Stopping…';
      try {
        await window.teamyra.cancelTask(id);
        await refreshJobs();
      } catch (error) {
        alert('Could not stop task: ' + String(error?.message || error));
        button.disabled = false;
        button.textContent = 'Stop';
      }
    });
  });

  for (const job of jobs.slice(0, 12)) {
    const cached = transcriptState.get(job.id);
    if (isActive(job) || !cached || cached.jobState !== job.state) loadTranscriptPreview(job);
  }
}

async function refreshJobs() {
  if (jobsRefreshPromise) return jobsRefreshPromise;
  jobsRefreshPromise = (async () => {
    const jobs = await window.teamyra.jobs();
    currentJobs = jobs;
    updateLiveBadge();
    const signature = jobs.map(job => [job.id, job.state, job.updated, job.heartbeatAt, job.lastEvent].join(':')).join('|');
    if (signature !== jobsRenderSignature) {
      jobsRenderSignature = signature;
      renderJobs();
    }
    return jobs;
  })();
  try {
    return await jobsRefreshPromise;
  } finally {
    jobsRefreshPromise = null;
  }
}

function profileRows(provider) {
  let profiles = Array.isArray(provider.profiles) ? [...provider.profiles] : [];
  if (provider.id !== 'chatgpt-web' && provider.installed && !profiles.length) {
    profiles = [{
      id: 'native',
      name: 'Default',
      signedIn: false,
      enabled: true,
      editable: false
    }];
  }
  return profiles;
}

function profileActionLabel(provider, profile) {
  if (provider.id === 'chatgpt-web' || provider.id === 'google-media') return profile.signedIn ? 'Open' : 'Connect';
  return profile.signedIn ? 'Open' : 'Connect';
}

function mcpConnectionFor(providerId) {
  return currentMcpConnections?.providers?.[providerId] || null;
}

function mcpButtonHtml(provider) {
  if (!['claude', 'codex', 'antigravity'].includes(provider.id)) return '';
  const state = mcpConnectionFor(provider.id);
  const serviceOnline = currentMcpConnections?.service?.running === true;
  const connected = state?.connected === true && serviceOnline;
  const disabled = provider.installed !== true;
  const title = !serviceOnline && state?.connected
    ? 'TEAMYRA MCP is configured but the local service is offline'
    : state?.detail || (disabled ? 'Install this provider CLI first' : 'Connect this provider to the local TEAMYRA MCP');
  return `<button class="profile-action mcp-action ${connected ? 'connected' : ''}" type="button"
    data-connect-mcp="${escapeHtml(provider.id)}" ${disabled ? 'disabled' : ''}
    title="${escapeHtml(title)}">${connected ? 'MCP Connected' : 'Connect Teamyra'}</button>`;
}

function agentCardHtml(provider) {
  const meta = providerMeta(provider.id);
  const profiles = profileRows(provider);
  const connected = provider.id === 'chatgpt-web'
    ? provider.signedIn === true
    : profiles.some(profile => profile.signedIn);
  const status = provider.id === 'chatgpt-web'
    ? (provider.status || 'Embedded web session')
    : !provider.installed
      ? 'Not installed'
      : connected
        ? 'Connected'
        : 'Sign in needed';

  const rows = profiles.length
    ? profiles.map(profile => `
        <div class="profile-row">
          <div class="profile-name">
            <strong>${escapeHtml(profile.name || profile.id)}</strong>
            <span>${profile.signedIn ? 'ready' : provider.id === 'chatgpt-web' ? 'embedded session' : provider.id === 'google-media' ? 'Google sign-in' : 'not connected'}</span>
          </div>
          <div class="profile-actions">
            <button class="profile-action" type="button"
              data-provider="${escapeHtml(provider.id)}"
              data-profile="${escapeHtml(profile.id)}"
              data-signed-in="${profile.signedIn ? '1' : '0'}">${profileActionLabel(provider, profile)}</button>
            ${provider.id === 'google-media' && profile.signedIn
              ? `<button class="profile-action" type="button" data-google-bulk="${escapeHtml(profile.id)}" title="Generate many images, videos or sound effects at once">Bulk</button>
                 <button class="profile-action" type="button" data-google-music="${escapeHtml(profile.id)}" title="${profile.musicSignedIn ? 'Open Flow Music' : 'Authorize Flow Music with Google'}">${profile.musicSignedIn ? 'Music' : 'Connect Music'}</button>`
              : ''}
          </div>
        </div>
      `).join('')
    : '<div class="profile-row"><div class="profile-name"><strong>No account available</strong><span>Install or connect this agent first</span></div></div>';

  return `
    <article class="agent-card" data-provider-card="${escapeHtml(provider.id)}">
      <div class="agent-card-head">
        <span class="agent-avatar ${meta.cls}">${agentIconSvg(meta.icon) || escapeHtml(meta.code)}</span>
        <div class="agent-card-title">
          <strong>${escapeHtml(provider.name)}</strong>
          <span>${escapeHtml(status)}</span>
        </div>
        <i class="agent-state ${connected ? 'ready' : ''}"></i>
      </div>
      <div class="profile-list">${rows}</div>
      <div class="agent-card-foot">
        ${mcpButtonHtml(provider)}
        ${provider.managedProfilesVerified && provider.installed
          ? `<button class="profile-action" type="button" data-add-account="${escapeHtml(provider.id)}">+ Account</button>`
          : ''}
      </div>
    </article>
  `;
}

async function refreshAgents(force = false) {
  if (agentsRefreshPromise) return agentsRefreshPromise;
  agentsRefreshPromise = (async () => {
  const [providers, mcpConnections] = await Promise.all([
    window.teamyra.providers(force),
    window.teamyra.mcpConnections()
  ]);
  currentProviders = providers;
  currentMcpConnections = mcpConnections || { endpoint: '', service: { running: false }, providers: {} };
  const connected = currentProviders.filter(provider =>
    provider.id === 'chatgpt-web'
      ? provider.signedIn === true
      : profileRows(provider).some(profile => profile.signedIn)
  ).length;
  const serviceOnline = currentMcpConnections?.service?.running === true;
  const mcpConnected = serviceOnline
    ? ['claude', 'codex', 'antigravity'].filter(id => currentMcpConnections?.providers?.[id]?.connected === true).length
    : 0;
  const coreAwake = currentMcpConnections?.service?.backendRunning === true;
  const runtimeLabel = !serviceOnline ? 'Wake offline' : coreAwake ? 'Core active' : 'Core sleeping';
  $('#agentSummary').textContent = connected + ' agents · ' + mcpConnected + ' MCP · ' + runtimeLabel;
  const idleSeconds = Number(currentMcpConnections?.service?.idleSeconds) || 600;
  $('#agentSummary').title = currentMcpConnections?.bootError ||
    (currentMcpConnections?.endpoint + ' · auto-sleep after ' + Math.round(idleSeconds / 60) + ' min idle');
  $('#agentGrid').innerHTML = currentProviders.map(agentCardHtml).join('');

  $('#agentGrid').querySelectorAll('[data-provider][data-profile]').forEach(button => {
    button.addEventListener('click', () => {
      const provider = currentProviders.find(item => item.id === button.dataset.provider);
      if (!provider) return;
      const profile = profileRows(provider).find(item => item.id === button.dataset.profile) || {
        id: button.dataset.profile,
        name: 'Default',
        signedIn: button.dataset.signedIn === '1'
      };
      openProvider(provider, profile).catch(error => alert(String(error?.message || error)));
    });
  });

  $('#agentGrid').querySelectorAll('[data-google-music]').forEach(button => {
    button.addEventListener('click', async () => {
      const profileId = button.dataset.googleMusic || 'google';
      const original = button.textContent;
      button.disabled = true;
      button.textContent = 'Opening…';
      try {
        await window.teamyra.setChatgptVisible(false).catch(() => {});
        prepareGoogleMediaSurface();
        const result = await window.teamyra.openGoogleMusic(profileId);
        if (result?.music_authorization?.needs_user_action) {
          button.title = 'Complete Google authorization in the Flow Music window';
        }
        refreshAgents().catch(() => {});
      } catch (error) {
        alert('Could not open Flow Music: ' + String(error?.message || error));
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = original;
        }
      }
    });
  });

  $('#agentGrid').querySelectorAll('[data-google-bulk]').forEach(button => {
    button.addEventListener('click', () => openBulkMedia(button.dataset.googleBulk || 'google').catch(error => alert(String(error?.message || error))));
  });

  $('#agentGrid').querySelectorAll('[data-connect-mcp]').forEach(button => {
    button.addEventListener('click', async () => {
      const providerId = button.dataset.connectMcp;
      if (!providerId || button.disabled) return;
      const original = button.textContent;
      button.disabled = true;
      button.textContent = 'Connecting…';
      try {
        const result = await window.teamyra.connectMcp(providerId);
        if (!result?.ok) {
          const detail = result?.error || result?.status?.detail || result?.reason || 'TEAMYRA MCP connection failed';
          throw new Error(detail);
        }
        await refreshAgents();
      } catch (error) {
        alert('Could not connect TEAMYRA MCP: ' + String(error?.message || error));
        button.disabled = false;
        button.textContent = original;
      }
    });
  });

  $('#agentGrid').querySelectorAll('[data-add-account]').forEach(button => {
    button.addEventListener('click', async () => {
      const provider = currentProviders.find(item => item.id === button.dataset.addAccount);
      if (!provider || button.disabled) return;

      const existingNames = new Set(
        profileRows(provider)
          .map(profile => String(profile.name || '').trim().toLowerCase())
          .filter(Boolean)
      );
      let suffix = 2;
      let name = provider.name + ' ' + suffix;
      while (existingNames.has(name.toLowerCase())) {
        suffix += 1;
        name = provider.name + ' ' + suffix;
      }

      const originalText = button.textContent;
      button.disabled = true;
      button.textContent = 'Adding…';
      try {
        const result = await window.teamyra.addAccount(provider.id, name);
        if (!result?.ok) throw new Error(result?.reason || 'Could not create account');

        if (provider.id === 'chatgpt-web') {
          await openChatgptDetail(result.profileId);
        } else if (provider.id === 'google-media') {
          await window.teamyra.setChatgptVisible(false).catch(() => {});
          prepareGoogleMediaSurface();
          await window.teamyra.loginGoogleMedia(result.profileId);
          refreshAgents().catch(() => {});
        } else {
          await openTerminal({
            providerId: provider.id,
            profileId: result.profileId,
            login: true,
            label: provider.name + ' · ' + result.name
          });
          refreshAgents().catch(() => {});
        }
      } catch (error) {
        alert('Could not add account: ' + String(error?.message || error));
        await refreshAgents().catch(() => {});
      } finally {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = originalText;
        }
      }
    });
  });

  populateTaskAgents();
  return currentProviders;
  })();
  try {
    return await agentsRefreshPromise;
  } finally {
    agentsRefreshPromise = null;
  }
}

async function openProvider(provider, profile) {
  if (provider.id === 'google-media') {
    await window.teamyra.setChatgptVisible(false).catch(() => {});
    prepareGoogleMediaSurface();
    if (profile.signedIn) await window.teamyra.openGoogleMedia(profile.id || 'google');
    else await window.teamyra.loginGoogleMedia(profile.id || 'google');
    return;
  }
  await window.teamyra.setGoogleMediaVisible(false).catch(() => {});
  if (provider.id === 'chatgpt-web') {
    await openChatgptDetail(profile.id || 'web');
    return;
  }
  if (!provider.installed) {
    alert(provider.name + ' is not installed on this machine.');
    return;
  }
  await openTerminal({
    providerId: provider.id,
    profileId: profile.id || 'native',
    login: profile.signedIn !== true,
    label: provider.name + ' · ' + (profile.name || 'Default')
  });
}

function populateTaskAgents() {
  const select = $('#taskAgent');
  const previous = select.value || 'auto';
  select.innerHTML = '<option value="auto">Auto · best available</option>';

  for (const provider of currentProviders) {
    for (const profile of profileRows(provider)) {
      const workerId = workerIdForProfile(provider.id, profile.id);
      if (!workerId || profile.signedIn !== true || profile.enabled === false) continue;
      const option = document.createElement('option');
      option.value = workerId;
      option.textContent = provider.name + (profile.name && profile.name !== 'Default' ? ' · ' + profile.name : '');
      select.appendChild(option);
    }
  }
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}

async function openTerminal(options = {}) {
  $('#terminalLabel').textContent = options.label || 'Agent terminal';
  $('#terminalPanel').hidden = false;

  if (!terminal) {
    terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"Cascadia Mono", "SF Mono", Consolas, monospace',
      fontSize: 12,
      theme: {
        background: '#1a1c22',
        foreground: '#ececf0',
        cursor: '#ef6461',
        selectionBackground: 'rgba(239,100,97,.26)'
      }
    });
    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open($('#terminalHost'));
    terminal.onData(data => {
      if (terminalSessionId) window.teamyra.writeTerminal(terminalSessionId, data);
    });
    terminalResizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (!fitAddon || !terminalSessionId) return;
        try {
          fitAddon.fit();
          window.teamyra.resizeTerminal(terminalSessionId, terminal.cols, terminal.rows);
        } catch {}
      });
    });
    terminalResizeObserver.observe($('#terminalHost'));
  }

  if (terminalSessionId) {
    try { await window.teamyra.closeTerminal(terminalSessionId); } catch {}
    terminalSessionId = null;
  }
  terminal.reset();
  const result = await window.teamyra.openTerminal(options);
  if (!result?.ok) throw new Error(result?.reason || 'Terminal unavailable');
  terminalSessionId = result.id;
  requestAnimationFrame(() => {
    try {
      fitAddon.fit();
      window.teamyra.resizeTerminal(terminalSessionId, terminal.cols, terminal.rows);
    } catch {}
  });
}

async function closeTerminal() {
  if (terminalSessionId) {
    try { await window.teamyra.closeTerminal(terminalSessionId); } catch {}
  }
  terminalSessionId = null;
  $('#terminalPanel').hidden = true;
  refreshAgents().catch(() => {});
}

window.teamyra.onTerminalData(payload => {
  if (payload?.id === terminalSessionId && terminal) terminal.write(payload.data || '');
});
window.teamyra.onTerminalExit(payload => {
  if (payload?.id !== terminalSessionId) return;
  terminalSessionId = null;
  terminal?.writeln('\r\n\x1b[90m[session ended]\x1b[0m');
  refreshAgents().catch(() => {});
});

async function refreshChatgptStatus() {
  const [status, workspace] = await Promise.all([
    window.teamyra.chatgptStatus(),
    window.teamyra.chatgptWorkspaceStatus().catch(() => null)
  ]);

  $('#chatgptStatusText').textContent = status.challenged
    ? 'Verification required'
    : status.automationReady
      ? 'Connected'
      : status.loginVisible
        ? 'Sign in required'
        : status.connected
          ? 'Loaded'
          : 'Not opened';

  const path = workspace?.workspace || '';
  $('#chatgptWorkspaceLabel').textContent = path ? path.split(/[\\/]/).filter(Boolean).pop() || path : 'Choose workspace';
  $('#chatgptWorkspaceButton').title = path || 'Choose workspace';

  const permissions = workspace?.permissions || {};
  for (const [name, id] of Object.entries({
    read: 'chatgptPermRead',
    search: 'chatgptPermSearch',
    create: 'chatgptPermCreate',
    write: 'chatgptPermWrite',
    git: 'chatgptPermGit',
    terminal: 'chatgptPermTerminal'
  })) {
    if (Object.prototype.hasOwnProperty.call(permissions, name)) $('#' + id).checked = permissions[name] === true;
  }
  $('#chatgptPermFullAccess').checked = permissions.full_access === true || workspace?.full_access === true;
  $('#chatgptPermDestructive').checked = permissions.destructive_without_confirmation === true;
  syncChatgptAccessUi();

  syncChatgptBounds();
  return { status, workspace };
}

function syncGoogleMediaBounds() {
  if (activeView !== 'agents') return;
  const rect = $('.main').getBoundingClientRect();
  if (rect.width < 50 || rect.height < 50) return;
  window.teamyra.setGoogleMediaBounds({
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }).catch(() => {});
}

function prepareGoogleMediaSurface() {
  activeView = 'agents';
  $('#navAgents').classList.add('active');
  $('#navTasks').classList.remove('active');
  $('#agentsView').hidden = false;
  $('#tasksView').hidden = true;
  setBrowserCloseVisible(true);
  if (!googleMediaBoundsObserver) {
    googleMediaBoundsObserver = new ResizeObserver(syncGoogleMediaBounds);
    googleMediaBoundsObserver.observe($('.main'));
    window.addEventListener('resize', syncGoogleMediaBounds);
  }
  syncGoogleMediaBounds();
}

function syncChatgptBounds() {
  if (activeView !== 'agents' || $('#chatgptDetail').hidden) return;
  const rect = $('#chatgptViewport').getBoundingClientRect();
  if (rect.width < 50 || rect.height < 50) return;
  window.teamyra.setChatgptBounds({
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  }).catch(() => {});
}

async function openChatgptDetail(profileId = 'web') {
  activeChatgptProfileId = profileId || 'web';
  activeView = 'agents';
  $('#agentsShelf').hidden = true;
  $('#chatgptDetail').hidden = false;
  $('#navAgents').classList.add('active');
  $('#navTasks').classList.remove('active');
  $('#agentsView').hidden = false;
  $('#tasksView').hidden = true;

  setBrowserCloseVisible(true);
  await window.teamyra.setChatgptVisible(false).catch(() => {});
  if (!chatgptBoundsObserver) {
    chatgptBoundsObserver = new ResizeObserver(syncChatgptBounds);
    chatgptBoundsObserver.observe($('#chatgptViewport'));
    window.addEventListener('resize', syncChatgptBounds);
  }
  syncChatgptBounds();
  await window.teamyra.openChatgpt(activeChatgptProfileId);
  setTimeout(() => refreshChatgptStatus().catch(() => {}), 800);
}

async function closeChatgptDetail() {
  await window.teamyra.setChatgptVisible(false).catch(() => {});
  setBrowserCloseVisible(false);
  $('#chatgptDetail').hidden = true;
  $('#agentsShelf').hidden = false;
  await refreshAgents();
}

async function selectChatgptWorkspace() {
  const result = await window.teamyra.selectChatgptWorkspace();
  if (!result?.cancelled) await refreshChatgptStatus();
}

function chatgptPermissionsFromUi() {
  const fullAccess = $('#chatgptPermFullAccess').checked;
  return {
    read: $('#chatgptPermRead').checked,
    search: $('#chatgptPermSearch').checked,
    create: $('#chatgptPermCreate').checked,
    write: $('#chatgptPermWrite').checked,
    git: $('#chatgptPermGit').checked,
    terminal: $('#chatgptPermTerminal').checked,
    full_access: fullAccess,
    outside_workspace: fullAccess,
    destructive_without_confirmation: fullAccess && $('#chatgptPermDestructive').checked
  };
}

function syncChatgptAccessUi() {
  const fullAccess = $('#chatgptPermFullAccess').checked;
  $('#chatgptPermDestructive').disabled = !fullAccess;
  if (!fullAccess) $('#chatgptPermDestructive').checked = false;
  $('#chatgptToolsNote').textContent = fullAccess
    ? 'Full PC access is ON: ChatGPT workers can use any path on this PC except credential folders. ' +
      ($('#chatgptPermDestructive').checked ? 'Destructive commands run without confirmation.' : 'Destructive actions remain confirmation-gated.')
    : 'Access always stays inside the selected workspace. Destructive actions remain confirmation-gated.';
}

async function saveChatgptPermissions() {
  const status = await window.teamyra.chatgptWorkspaceStatus();
  if (!status?.workspace) {
    await selectChatgptWorkspace();
    return;
  }
  $('#chatgptToolsError').hidden = true;
  const result = await window.teamyra.configureChatgptWorkspace(status.workspace, chatgptPermissionsFromUi());
  if (result?.cancelled) {
    // The user declined the confirmation dialog: show the stored permissions again.
    await refreshChatgptStatus();
    return;
  }
  const stored = result?.permissions;
  if (stored && $('#chatgptPermFullAccess').checked && stored.full_access !== true) {
    $('#chatgptToolsError').textContent = 'Full PC access was not enabled by the TEAMYRA core.';
    $('#chatgptToolsError').hidden = false;
    await refreshChatgptStatus();
    return;
  }
  $('#chatgptToolsDialog').close();
  await refreshChatgptStatus();
}

async function showChanges() {
  const result = await window.teamyra.chatgptChanges();
  const parts = [];
  if (result.status?.stdout || result.status?.stderr) {
    parts.push('STATUS\n' + (result.status.stdout || result.status.stderr));
  }
  if (result.stagedDiff?.stdout) parts.push('STAGED\n' + result.stagedDiff.stdout);
  if (result.diff?.stdout) parts.push('UNSTAGED\n' + result.diff.stdout);
  $('#changesOutput').textContent = parts.join('\n\n') || 'Working tree clean.';
  $('#changesDialog').showModal();
}

function openNewTask() {
  $('#taskError').hidden = true;
  $('#taskError').textContent = '';
  populateTaskAgents();

  if (!$('#taskWorkspace').value) {
    const remembered = localStorage.getItem('teamyra-task-workspace') || '';
    if (remembered) {
      $('#taskWorkspace').value = remembered;
      $('#taskWorkspaceLabel').textContent = remembered.split(/[\\/]/).filter(Boolean).pop() || remembered;
      $('#taskWorkspacePick').title = remembered;
    }
  }
  $('#newTaskDialog').showModal();
  setTimeout(() => $('#taskPrompt').focus(), 40);
}

async function pickTaskWorkspace() {
  const result = await window.teamyra.pickProject();
  if (result?.cancelled || !result?.path) return;
  $('#taskWorkspace').value = result.path;
  $('#taskWorkspaceLabel').textContent = result.path.split(/[\\/]/).filter(Boolean).pop() || result.path;
  $('#taskWorkspacePick').title = result.path;
  localStorage.setItem('teamyra-task-workspace', result.path);
}

async function submitTask(event) {
  event.preventDefault();
  const task = $('#taskPrompt').value.trim();
  const projectPath = $('#taskWorkspace').value.trim();
  if (!projectPath) {
    $('#taskError').textContent = 'Choose a workspace first.';
    $('#taskError').hidden = false;
    return;
  }
  if (!task) return;

  $('#taskStart').disabled = true;
  $('#taskStart').textContent = 'Starting…';
  $('#taskError').hidden = true;
  try {
    await window.teamyra.startTask({
      task,
      projectPath,
      worker: $('#taskAgent').value || 'auto',
      write: true,
      autoFailover: ($('#taskAgent').value || 'auto') === 'auto'
    });
    $('#newTaskDialog').close();
    $('#taskPrompt').value = '';
    taskFilter = 'active';
    $('#filterActive').classList.add('active');
    $('#filterAll').classList.remove('active');
    setView('tasks');
    await refreshJobs();
  } catch (error) {
    $('#taskError').textContent = String(error?.message || error);
    $('#taskError').hidden = false;
  } finally {
    $('#taskStart').disabled = false;
    $('#taskStart').textContent = 'Start task';
  }
}

function updateUpdateNote(state) {
  const note = $('#updateNote');
  if (!state) return;
  if (state.status === 'downloaded') {
    note.textContent = 'Update ready';
    note.style.cursor = 'pointer';
    note.onclick = () => window.teamyra.installUpdate();
  } else if (state.status === 'downloading') {
    note.textContent = 'Updating ' + Math.round(state.progress || 0) + '%';
    note.onclick = null;
  } else if (state.status === 'error') {
    note.textContent = 'Update check unavailable';
    note.onclick = null;
  } else {
    note.textContent = '';
    note.onclick = null;
  }
}

$('#navTasks').addEventListener('click', () => setView('tasks'));
$('#navAgents').addEventListener('click', () => setView('agents'));
$('#browserClose').addEventListener('click', () => closeAllEmbeddedBrowsers().catch(() => {}));
$('#refresh').addEventListener('click', () => {
  const action = activeView === 'agents'
    ? ($('#chatgptDetail').hidden ? refreshAgents(true) : refreshChatgptStatus())
    : refreshJobs();
  action.catch(error => alert(String(error?.message || error)));
});

$('#filterActive').addEventListener('click', () => {
  taskFilter = 'active';
  $('#filterActive').classList.add('active');
  $('#filterAll').classList.remove('active');
  renderJobs();
});
$('#filterAll').addEventListener('click', () => {
  taskFilter = 'all';
  $('#filterAll').classList.add('active');
  $('#filterActive').classList.remove('active');
  renderJobs();
});

$('#newTask').addEventListener('click', openNewTask);
$('#newTaskClose').addEventListener('click', () => $('#newTaskDialog').close());
$('#newTaskCancel').addEventListener('click', () => $('#newTaskDialog').close());
$('#taskWorkspacePick').addEventListener('click', () => pickTaskWorkspace().catch(error => alert(String(error?.message || error))));
$('#newTaskForm').addEventListener('submit', submitTask);

$('#closeTerminal').addEventListener('click', () => closeTerminal());
$('#chatgptBack').addEventListener('click', () => closeChatgptDetail().catch(() => {}));
$('#chatgptOpen').addEventListener('click', () => openChatgptDetail().catch(error => alert(String(error?.message || error))));
$('#chatgptWorkspaceButton').addEventListener('click', () => selectChatgptWorkspace().catch(error => alert(String(error?.message || error))));
$('#chatgptTools').addEventListener('click', async () => {
  await refreshChatgptStatus().catch(() => {});
  $('#chatgptToolsDialog').showModal();
});
$('#chatgptToolsClose').addEventListener('click', () => $('#chatgptToolsDialog').close());
$('#chatgptPermFullAccess').addEventListener('change', syncChatgptAccessUi);
$('#chatgptPermDestructive').addEventListener('change', syncChatgptAccessUi);
$('#chatgptSavePermissions').addEventListener('click', () => saveChatgptPermissions().catch(error => alert(String(error?.message || error))));
$('#chatgptViewChanges').addEventListener('click', () => showChanges().catch(error => alert(String(error?.message || error))));
$('#changesClose').addEventListener('click', () => $('#changesDialog').close());
$('#chatgptNew').addEventListener('click', () => window.teamyra.newChatgptChat().then(refreshChatgptStatus).catch(error => alert(String(error?.message || error))));
$('#chatgptReload').addEventListener('click', () => window.teamyra.reloadChatgpt().then(refreshChatgptStatus).catch(error => alert(String(error?.message || error))));
$('#chatgptStop').addEventListener('click', () => window.teamyra.stopChatgpt().catch(() => {}));

window.teamyra.onUpdateState(updateUpdateNote);

// --- Bulk Google media ------------------------------------------------------

const BULK_MAX = 50;
const BULK_OPTIONS = {
  video: {
    aspects: [['16:9', '16:9 landscape'], ['9:16', '9:16 portrait']],
    qualities: [['1080p', '1080p upscaled'], ['source', '720p original']],
    duration: true
  },
  image: {
    aspects: [['16:9', '16:9 landscape'], ['9:16', '9:16 portrait'], ['1:1', '1:1 square'], ['4:3', '4:3'], ['3:4', '3:4']],
    qualities: [['prefer_4x_then_2x', '4K, else 2K'], ['2x', '2K upscaled'], ['source', 'Original']],
    duration: false
  },
  sound_effect: { aspects: [], qualities: [], duration: true }
};
const BULK_STATE_LABELS = {
  queued: 'Queued', preparing: 'Preparing', waiting_for_browser: 'Preparing', submitting: 'Submitting',
  generating: 'Generating', processing: 'Processing', downloading: 'Downloading', extracting_audio: 'Extracting',
  organizing: 'Saving', completed: 'Done', failed: 'Failed', cancelled: 'Stopped',
  needs_user_auth: 'Sign in', rate_limited: 'Waiting'
};
const bulkState = { type: 'video', profileId: 'google', projectPath: '', batchId: '', projectOfBatch: '', timer: null, done: false };

function storageGet(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
function storageSet(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch {} }

// One prompt per line, or blocks separated by a line of --- for multi-line prompts.
function bulkPrompts() {
  const text = $('#bulkPrompts').value.replace(/\r\n/g, '\n');
  const separator = /^\s*-{3,}\s*$/m;
  const parts = separator.test(text) ? text.split(separator) : text.split('\n');
  return parts.map(part => part.trim()).filter(Boolean);
}

function bulkCopies() {
  return Math.max(1, Math.min(10, Math.round(Number($('#bulkCopies').value) || 1)));
}

function bulkParallel() {
  return Math.max(1, Math.min(30, Math.round(Number($('#bulkParallel').value) || 10)));
}

function fillSelect(select, options, remembered) {
  select.innerHTML = options.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('');
  if (options.some(([value]) => value === remembered)) select.value = remembered;
}

function setBulkType(type) {
  bulkState.type = BULK_OPTIONS[type] ? type : 'video';
  storageSet('teamyra-bulk-type', bulkState.type);
  document.querySelectorAll('[data-bulk-type]').forEach(button => {
    const active = button.dataset.bulkType === bulkState.type;
    button.classList.toggle('active', active);
    button.setAttribute('aria-checked', active ? 'true' : 'false');
  });
  const options = BULK_OPTIONS[bulkState.type];
  fillSelect($('#bulkAspect'), options.aspects, storageGet('teamyra-bulk-aspect-' + bulkState.type));
  fillSelect($('#bulkQuality'), options.qualities, storageGet('teamyra-bulk-quality-' + bulkState.type));
  $('#bulkAspectField').hidden = !options.aspects.length;
  $('#bulkQualityField').hidden = !options.qualities.length;
  $('#bulkDurationField').hidden = !options.duration;
  updateBulkSummary();
}

function updateBulkSummary() {
  const prompts = bulkPrompts().length;
  const copies = bulkCopies();
  const total = prompts * copies;
  const noun = { video: 'video', image: 'image', sound_effect: 'sound effect' }[bulkState.type];
  const summary = $('#bulkSummary');
  if (!prompts) {
    summary.textContent = 'Add prompts to start.';
  } else if (total > BULK_MAX) {
    summary.textContent = total + ' generations. One batch takes at most ' + BULK_MAX + '; remove prompts or copies.';
  } else {
    const parallel = Math.min(bulkParallel(), total);
    summary.textContent = total + ' ' + noun + (total === 1 ? '' : 's') + ' · ' + prompts + ' prompt' + (prompts === 1 ? '' : 's') +
      (copies > 1 ? ' × ' + copies + ' copies' : '') + ' · up to ' + parallel + ' generating at once';
  }
  $('#bulkStart').disabled = !prompts || total > BULK_MAX || Boolean(bulkState.batchId && !bulkState.done);
}

function setBulkWorkspace(projectPath) {
  bulkState.projectPath = projectPath || '';
  $('#bulkWorkspaceLabel').textContent = projectPath
    ? (projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath)
    : 'Choose project folder';
  $('#bulkWorkspacePick').title = projectPath || '';
}

function showBulkError(message) {
  $('#bulkError').textContent = message || '';
  $('#bulkError').hidden = !message;
}

function remoteMessage(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
}

async function openBulkMedia(profileId = 'google') {
  bulkState.profileId = profileId || 'google';
  // Native browser views draw above the page; hide them so the dialog is visible.
  await window.teamyra.setGoogleMediaVisible(false).catch(() => {});
  await window.teamyra.setChatgptVisible(false).catch(() => {});
  setBrowserCloseVisible(false);
  showBulkError('');
  if (!bulkState.projectPath) {
    setBulkWorkspace(storageGet('teamyra-bulk-workspace') || storageGet('teamyra-task-workspace'));
  }
  const parallel = Number(storageGet('teamyra-bulk-parallel'));
  if (parallel) $('#bulkParallel').value = String(Math.max(1, Math.min(30, parallel)));
  setBulkType(storageGet('teamyra-bulk-type') || bulkState.type);
  if (!bulkState.batchId) {
    const saved = storageGet('teamyra-bulk-batch');
    if (saved) {
      bulkState.batchId = saved;
      bulkState.projectOfBatch = storageGet('teamyra-bulk-batch-project');
      bulkState.done = false;
    }
  }
  $('#bulkMediaDialog').showModal();
  if (bulkState.batchId) refreshBulkProgress().catch(() => {});
  else setTimeout(() => $('#bulkPrompts').focus(), 40);
}

async function pickBulkWorkspace() {
  const result = await window.teamyra.pickProject();
  if (result?.cancelled || !result?.path) return;
  setBulkWorkspace(result.path);
  storageSet('teamyra-bulk-workspace', result.path);
}

async function submitBulkMedia(event) {
  event.preventDefault();
  showBulkError('');
  const prompts = bulkPrompts();
  const copies = bulkCopies();
  const total = prompts.length * copies;
  if (!prompts.length) return;
  if (total > BULK_MAX) { showBulkError('One batch takes at most ' + BULK_MAX + ' generations.'); return; }
  if (!bulkState.projectPath) { showBulkError('Choose a project folder first.'); return; }
  const options = BULK_OPTIONS[bulkState.type];
  const shared = {};
  if (options.aspects.length) shared.aspect_ratio = $('#bulkAspect').value;
  if (options.qualities.length) shared.download_quality = $('#bulkQuality').value;
  if (options.duration && $('#bulkDuration').value) shared.duration = Number($('#bulkDuration').value);
  const requests = [];
  for (const prompt of prompts) for (let copy = 0; copy < copies; copy += 1) requests.push({ ...shared, prompt });
  storageSet('teamyra-bulk-aspect-' + bulkState.type, shared.aspect_ratio || '');
  storageSet('teamyra-bulk-quality-' + bulkState.type, shared.download_quality || '');
  storageSet('teamyra-bulk-parallel', String(bulkParallel()));

  const button = $('#bulkStart');
  button.disabled = true;
  button.textContent = 'Queuing…';
  try {
    const result = await window.teamyra.startMediaBatch({
      type: bulkState.type,
      projectPath: bulkState.projectPath,
      requests,
      maxParallel: bulkParallel(),
      profileId: bulkState.profileId
    });
    bulkState.batchId = result.batch_id;
    bulkState.projectOfBatch = bulkState.projectPath;
    bulkState.done = false;
    storageSet('teamyra-bulk-batch', result.batch_id);
    storageSet('teamyra-bulk-batch-project', bulkState.projectPath);
    if (result.runtime?.error) showBulkError('Queued, but the Google Media browser could not start: ' + result.runtime.error);
    else if (result.runtime && result.runtime.connected === false) showBulkError('Queued. Connect your Google account from the Google Media card to start generating.');
    await refreshBulkProgress();
  } catch (error) {
    showBulkError(remoteMessage(error));
  } finally {
    button.textContent = 'Generate';
    updateBulkSummary();
  }
}

function renderBulkProgress(status) {
  const jobs = Array.isArray(status?.jobs) ? status.jobs : [];
  const counts = status?.counts || {};
  const total = Number(status?.total) || jobs.length;
  const completed = Number(counts.completed) || 0;
  const finished = Number(status?.finished) || 0;
  const working = total - finished - (Number(counts.queued) || 0);
  $('#bulkProgress').hidden = false;
  $('#bulkProgressLabel').textContent = status?.done
    ? (completed === total ? 'All ' + total + ' done' : 'Batch finished')
    : 'Generating ' + total + ' item' + (total === 1 ? '' : 's');
  const parts = [completed + '/' + total + ' done'];
  if (working > 0) parts.push(working + ' in progress');
  if (counts.queued) parts.push(counts.queued + ' queued');
  if (counts.failed) parts.push(counts.failed + ' failed');
  if (counts.cancelled) parts.push(counts.cancelled + ' stopped');
  if (counts.needs_user_auth) parts.push('sign-in needed');
  $('#bulkProgressCounts').textContent = parts.join(' · ');
  $('#bulkBar').style.width = (total ? Math.round(finished / total * 100) : 0) + '%';
  $('#bulkJobs').innerHTML = jobs.map((job, index) => {
    const state = job.status || 'queued';
    const tone = state === 'completed' ? 'done'
      : ['failed', 'cancelled', 'needs_user_auth'].includes(state) ? 'failed'
        : state === 'queued' ? '' : 'working';
    const title = [job.prompt_preview, job.asset?.asset_id, state === 'failed' ? job.error : job.detail].filter(Boolean).join('\n');
    return `<li title="${escapeHtml(title)}">
      <span class="bulk-index">${index + 1}</span>
      <span class="bulk-prompt">${escapeHtml(job.prompt_preview || job.job_id)}</span>
      <span class="bulk-chip ${tone}">${escapeHtml(job.asset?.asset_id || BULK_STATE_LABELS[state] || state)}</span>
    </li>`;
  }).join('');
  bulkState.done = status?.done === true;
  $('#bulkCancelRun').hidden = bulkState.done;
  $('#bulkNew').hidden = !bulkState.done;
  $('#bulkOpenFolder').hidden = !bulkState.projectOfBatch;
  if (bulkState.done) storageSet('teamyra-bulk-batch', '');
  updateBulkSummary();
}

async function refreshBulkProgress() {
  if (bulkState.timer) clearTimeout(bulkState.timer);
  bulkState.timer = null;
  if (!bulkState.batchId) return;
  try {
    renderBulkProgress(await window.teamyra.mediaBatchStatus(bulkState.batchId));
  } catch (error) {
    if (/no such media batch|invalid media batch/i.test(remoteMessage(error))) {
      resetBulkBatch();
      return;
    }
  }
  if (!bulkState.done && $('#bulkMediaDialog').open) {
    bulkState.timer = setTimeout(() => refreshBulkProgress().catch(() => {}), 3000);
  }
}

function resetBulkBatch() {
  if (bulkState.timer) clearTimeout(bulkState.timer);
  bulkState.timer = null;
  bulkState.batchId = '';
  bulkState.done = false;
  storageSet('teamyra-bulk-batch', '');
  $('#bulkProgress').hidden = true;
  $('#bulkJobs').innerHTML = '';
  $('#bulkCancelRun').hidden = true;
  $('#bulkNew').hidden = true;
  $('#bulkOpenFolder').hidden = true;
  updateBulkSummary();
}

document.querySelectorAll('[data-bulk-type]').forEach(button => {
  button.addEventListener('click', () => setBulkType(button.dataset.bulkType));
});
$('#bulkPrompts').addEventListener('input', updateBulkSummary);
$('#bulkCopies').addEventListener('input', updateBulkSummary);
$('#bulkParallel').addEventListener('input', updateBulkSummary);
$('#bulkWorkspacePick').addEventListener('click', () => pickBulkWorkspace().catch(error => showBulkError(remoteMessage(error))));
$('#bulkMediaForm').addEventListener('submit', submitBulkMedia);
$('#bulkMediaClose').addEventListener('click', () => $('#bulkMediaDialog').close());
$('#bulkMediaDialog').addEventListener('close', () => {
  if (bulkState.timer) clearTimeout(bulkState.timer);
  bulkState.timer = null;
});
$('#bulkNew').addEventListener('click', () => {
  resetBulkBatch();
  $('#bulkPrompts').value = '';
  updateBulkSummary();
  $('#bulkPrompts').focus();
});
$('#bulkCancelRun').addEventListener('click', async () => {
  if (!bulkState.batchId) return;
  if (!confirm('Stop every unfinished item in this batch? Generations Flow already started may still use credits.')) return;
  try {
    await window.teamyra.cancelMediaBatch(bulkState.batchId);
    await refreshBulkProgress();
  } catch (error) {
    showBulkError(remoteMessage(error));
  }
});
$('#bulkOpenFolder').addEventListener('click', () => {
  window.teamyra.openMediaFolder(bulkState.projectOfBatch || bulkState.projectPath).catch(error => showBulkError(remoteMessage(error)));
});

function scheduleJobsPoll(delayMs) {
  if (jobsPollTimer) clearTimeout(jobsPollTimer);
  jobsPollTimer = setTimeout(async () => {
    jobsPollTimer = null;
    if (!document.hidden) await refreshJobs().catch(() => {});
    const hasActive = currentJobs.some(isActive);
    const next = document.hidden ? 15000
      : activeView === 'tasks'
        ? (hasActive ? 2500 : 6000)
        : 12000;
    scheduleJobsPoll(next);
  }, Math.max(1000, delayMs));
}

async function boot() {
  document.body.dataset.platform = window.teamyra.platform || '';
  const chatgptAvatar = $('.chatgpt-avatar');
  if (chatgptAvatar) chatgptAvatar.innerHTML = agentIconSvg('openai') || 'GPT';
  window.teamyra.updateStatus().then(updateUpdateNote).catch(() => {});
  await Promise.allSettled([refreshJobs(), refreshAgents(false)]);
  await window.teamyra.setChatgptVisible(false).catch(() => {});
  scheduleJobsPoll(3500);
  setInterval(() => {
    if (!document.hidden && activeView === 'agents' && !$('#chatgptDetail').hidden) {
      refreshChatgptStatus().catch(() => {});
    }
  }, 8000);
}

// Event bindings are ready; background provider/core calls must not gate paint.
window.teamyra.rendererReady();
boot().catch(error => {
  console.error('TEAMYRA renderer boot failed', error);
});
