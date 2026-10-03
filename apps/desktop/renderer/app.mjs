import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

const $ = selector => document.querySelector(selector);

let activeView = 'tasks';
let taskFilter = 'active';
let currentJobs = [];
let currentProviders = [];
let terminal = null;
let fitAddon = null;
let terminalSessionId = null;
let terminalResizeObserver = null;
let chatgptBoundsObserver = null;
const transcriptCache = new Map();

const ACTIVE_STATES = new Set(['queued', 'starting', 'running', 'waiting_for_desktop', 'waiting']);
const WORKER_META = {
  claude: { code: 'CL', cls: 'claude', label: 'Claude' },
  codex: { code: 'CX', cls: 'codex', label: 'Codex' },
  antigravity: { code: 'AG', cls: 'antigravity', label: 'Antigravity' },
  chatgpt: { code: 'GPT', cls: 'chatgpt', label: 'ChatGPT' },
  other: { code: 'AI', cls: '', label: 'Agent' }
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
  if (providerId === 'chatgpt-web') return 'chatgpt-normal';
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

  if (activeView === 'tasks') refreshJobs().catch(() => {});
  else refreshAgents().catch(() => {});
}

function updateLiveBadge() {
  const active = currentJobs.filter(isActive).length;
  $('#liveBadge').hidden = active === 0;
  $('#liveLabel').textContent = active === 1 ? '1 live' : active + ' live';
}

async function loadTranscriptPreview(job) {
  try {
    const result = await window.teamyra.transcript(job.id, 0);
    const text = String(result?.text || '').trim();
    const preview = text ? text.slice(-9000) : String(job.lastEvent || '').trim();
    transcriptCache.set(job.id, preview || 'Waiting for agent output…');
  } catch (error) {
    transcriptCache.set(job.id, String(job.lastEvent || error?.message || 'No output yet.'));
  }
  const output = document.querySelector('[data-task-output="' + CSS.escape(job.id) + '"]');
  if (output) {
    output.textContent = transcriptCache.get(job.id);
    output.classList.toggle('empty', !String(transcriptCache.get(job.id) || '').trim());
    output.scrollTop = output.scrollHeight;
  }
}

function taskCardHtml(job) {
  const meta = workerMeta(job.worker);
  const active = isActive(job);
  const preview = transcriptCache.get(job.id) || job.lastEvent || (active ? 'Agent is starting…' : 'No transcript preview.');
  return `
    <article class="task-card ${active ? 'running' : ''}" data-job-id="${escapeHtml(job.id)}">
      <div class="task-head">
        <span class="agent-avatar ${meta.cls}">${meta.code}</span>
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
    if (isActive(job) || !transcriptCache.has(job.id)) loadTranscriptPreview(job);
  }
}

async function refreshJobs() {
  currentJobs = await window.teamyra.jobs();
  updateLiveBadge();
  renderJobs();
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
  if (provider.id === 'chatgpt-web') return 'Open';
  return profile.signedIn ? 'Open' : 'Connect';
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
            <span>${profile.signedIn ? 'ready' : provider.id === 'chatgpt-web' ? 'embedded session' : 'not connected'}</span>
          </div>
          <button class="profile-action" type="button"
            data-provider="${escapeHtml(provider.id)}"
            data-profile="${escapeHtml(profile.id)}"
            data-signed-in="${profile.signedIn ? '1' : '0'}">${profileActionLabel(provider, profile)}</button>
        </div>
      `).join('')
    : '<div class="profile-row"><div class="profile-name"><strong>No account available</strong><span>Install or connect this agent first</span></div></div>';

  return `
    <article class="agent-card" data-provider-card="${escapeHtml(provider.id)}">
      <div class="agent-card-head">
        <span class="agent-avatar ${meta.cls}">${meta.code}</span>
        <div class="agent-card-title">
          <strong>${escapeHtml(provider.name)}</strong>
          <span>${escapeHtml(status)}</span>
        </div>
        <i class="agent-state ${connected ? 'ready' : ''}"></i>
      </div>
      <div class="profile-list">${rows}</div>
      <div class="agent-card-foot">
        ${provider.managedProfilesVerified && provider.installed
          ? `<button class="profile-action" type="button" data-add-account="${escapeHtml(provider.id)}">+ Account</button>`
          : ''}
      </div>
    </article>
  `;
}

async function refreshAgents() {
  currentProviders = await window.teamyra.providers();
  const connected = currentProviders.filter(provider =>
    provider.id === 'chatgpt-web'
      ? provider.signedIn === true
      : profileRows(provider).some(profile => profile.signedIn)
  ).length;

  $('#agentSummary').textContent = connected + ' connected · ' + currentProviders.length + ' available';
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

  $('#agentGrid').querySelectorAll('[data-add-account]').forEach(button => {
    button.addEventListener('click', async () => {
      const provider = currentProviders.find(item => item.id === button.dataset.addAccount);
      if (!provider) return;
      const name = prompt('Account name:', provider.name + ' 2');
      if (!name) return;
      button.disabled = true;
      try {
        const result = await window.teamyra.addAccount(provider.id, name);
        if (!result?.ok) throw new Error(result?.reason || 'Could not create account');
        await openTerminal({
          providerId: provider.id,
          profileId: result.profileId,
          login: true,
          label: provider.name + ' · ' + result.name
        });
      } finally {
        button.disabled = false;
        refreshAgents().catch(() => {});
      }
    });
  });

  populateTaskAgents();
}

async function openProvider(provider, profile) {
  if (provider.id === 'chatgpt-web') {
    await openChatgptDetail();
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
        ? 'Sign in inside the panel'
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

  syncChatgptBounds();
  return { status, workspace };
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

async function openChatgptDetail() {
  activeView = 'agents';
  $('#agentsShelf').hidden = true;
  $('#chatgptDetail').hidden = false;
  $('#navAgents').classList.add('active');
  $('#navTasks').classList.remove('active');
  $('#agentsView').hidden = false;
  $('#tasksView').hidden = true;

  await window.teamyra.setChatgptVisible(true);
  if (!chatgptBoundsObserver) {
    chatgptBoundsObserver = new ResizeObserver(syncChatgptBounds);
    chatgptBoundsObserver.observe($('#chatgptViewport'));
    window.addEventListener('resize', syncChatgptBounds);
  }
  syncChatgptBounds();
  await window.teamyra.openChatgpt();
  await refreshChatgptStatus();
}

async function closeChatgptDetail() {
  await window.teamyra.setChatgptVisible(false).catch(() => {});
  $('#chatgptDetail').hidden = true;
  $('#agentsShelf').hidden = false;
  await refreshAgents();
}

async function selectChatgptWorkspace() {
  const result = await window.teamyra.selectChatgptWorkspace();
  if (!result?.cancelled) await refreshChatgptStatus();
}

function chatgptPermissionsFromUi() {
  return {
    read: $('#chatgptPermRead').checked,
    search: $('#chatgptPermSearch').checked,
    create: $('#chatgptPermCreate').checked,
    write: $('#chatgptPermWrite').checked,
    git: $('#chatgptPermGit').checked,
    terminal: $('#chatgptPermTerminal').checked,
    outside_workspace: false,
    destructive_without_confirmation: false
  };
}

async function saveChatgptPermissions() {
  const status = await window.teamyra.chatgptWorkspaceStatus();
  if (!status?.workspace) {
    await selectChatgptWorkspace();
    return;
  }
  await window.teamyra.configureChatgptWorkspace(status.workspace, chatgptPermissionsFromUi());
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
$('#refresh').addEventListener('click', () => {
  const action = activeView === 'agents'
    ? ($('#chatgptDetail').hidden ? refreshAgents() : refreshChatgptStatus())
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
$('#chatgptSavePermissions').addEventListener('click', () => saveChatgptPermissions().catch(error => alert(String(error?.message || error))));
$('#chatgptViewChanges').addEventListener('click', () => showChanges().catch(error => alert(String(error?.message || error))));
$('#changesClose').addEventListener('click', () => $('#changesDialog').close());
$('#chatgptNew').addEventListener('click', () => window.teamyra.newChatgptChat().then(refreshChatgptStatus).catch(error => alert(String(error?.message || error))));
$('#chatgptReload').addEventListener('click', () => window.teamyra.reloadChatgpt().then(refreshChatgptStatus).catch(error => alert(String(error?.message || error))));
$('#chatgptStop').addEventListener('click', () => window.teamyra.stopChatgpt().catch(() => {}));

window.teamyra.onUpdateState(updateUpdateNote);
window.teamyra.updateStatus().then(updateUpdateNote).catch(() => {});

await Promise.allSettled([refreshJobs(), refreshAgents()]);
await window.teamyra.setChatgptVisible(false).catch(() => {});
setInterval(() => refreshJobs().catch(() => {}), 2800);
setInterval(() => {
  if (activeView === 'agents' && !$('#chatgptDetail').hidden) refreshChatgptStatus().catch(() => {});
}, 5000);
