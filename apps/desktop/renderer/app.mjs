import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

let terminal = null;
let fitAddon = null;
let terminalSessionId = null;
let terminalResizeObserver = null;
let terminalContextKey = '';

let selectedJob = null;
let transcriptOffset = 0;
let transcriptTimer = null;
let currentJobs = [];

let activeView = 'command';
let currentWorktrees = [];
let selectedWorktreeId = null;
let currentUsage = null;
let currentTimeline = [];

const providersEl = document.querySelector('#providers');
const jobsEl = document.querySelector('#jobs');
const providerTpl = document.querySelector('#providerTpl');
const settingsDialog = document.querySelector('#accountSettingsDialog');
const settingsForm = document.querySelector('#accountSettingsForm');
const settingsTitle = document.querySelector('#settingsTitle');
const settingsName = document.querySelector('#settingsName');
const settingsPriority = document.querySelector('#settingsPriority');
const settingsEnabled = document.querySelector('#settingsEnabled');
const settingsModel = document.querySelector('#settingsModel');
const settingsEffort = document.querySelector('#settingsEffort');
const settingsPermission = document.querySelector('#settingsPermission');
const permissionField = document.querySelector('#permissionField');
const settingsError = document.querySelector('#settingsError');
const settingsSave = document.querySelector('#settingsSave');
let settingsContext = null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[ch]));
}

function openAccountSettings(provider, profile) {
  if (!profile.editable) return;
  settingsContext = { providerId: provider.id, profileId: profile.id };
  settingsTitle.textContent = provider.name + ' · ' + profile.name;
  settingsName.value = profile.name || '';
  settingsPriority.value = Number.isFinite(profile.priority) ? profile.priority : 100;
  settingsEnabled.checked = profile.enabled !== false;
  settingsModel.value = profile.model || '';
  settingsEffort.value = profile.effort || '';
  settingsPermission.value = profile.permissionMode || '';
  permissionField.hidden = provider.id !== 'claude';
  settingsError.hidden = true;
  settingsError.textContent = '';
  settingsDialog.showModal();
}

function closeAccountSettings() {
  settingsContext = null;
  if (settingsDialog.open) settingsDialog.close();
}

settingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!settingsContext) return;
  settingsSave.disabled = true;
  settingsError.hidden = true;
  try {
    const result = await window.teamyra.updateAccount(settingsContext.providerId, settingsContext.profileId, {
      name: settingsName.value,
      enabled: settingsEnabled.checked,
      priority: settingsPriority.value,
      model: settingsModel.value,
      effort: settingsEffort.value,
      permissionMode: settingsPermission.value
    });
    if (!result.ok) throw new Error(result.reason || 'Could not update profile');
    closeAccountSettings();
    await refresh();
  } catch (err) {
    settingsError.textContent = String(err?.message || err);
    settingsError.hidden = false;
  } finally {
    settingsSave.disabled = false;
  }
});

document.querySelector('#settingsClose').addEventListener('click', closeAccountSettings);
document.querySelector('#settingsCancel').addEventListener('click', closeAccountSettings);

function renderProviders(providers) {
  providersEl.innerHTML = '';
  for (const provider of providers) {
    const fragment = providerTpl.content.cloneNode(true);
    const card = fragment.querySelector('.provider-card');
    card.dataset.color = provider.color;
    fragment.querySelector('.provider-name h4').textContent = provider.name;
    const state = fragment.querySelector('.provider-name span');
    state.textContent = provider.installed
      ? (provider.signedIn ? 'Installed · signed in' : 'Installed · sign-in needed')
      : 'Not installed';
    if (provider.signedIn) state.classList.add('ok');

    fragment.querySelector('.binary').textContent = provider.binary || 'CLI not found on PATH';
    const plus = fragment.querySelector('.plus');
    plus.disabled = !provider.installed || !provider.managedProfilesVerified;
    plus.addEventListener('click', async () => {
      plus.disabled = true;
      plus.textContent = '…';
      try {
        const requestedName = prompt('Name this ' + provider.name + ' account:', provider.name + ' 2');
        if (requestedName === null) return;
        const result = await window.teamyra.addAccount(provider.id, requestedName);
        if (!result.ok) {
          alert('Managed multi-account isolation is not verified for ' + provider.name + ' yet.');
        } else {
          await openTerminal({
            providerId: provider.id,
            profileId: result.profileId,
            label: provider.name + ' · ' + result.name + ' · Login',
            login: true
          });
        }
      } catch (error) {
        alert('Could not start account login: ' + String(error));
      } finally {
        plus.textContent = '+';
        plus.disabled = !provider.installed || !provider.managedProfilesVerified;
      }
    });

    const accounts = fragment.querySelector('.accounts');
    if (!provider.profiles.length) {
      accounts.innerHTML = '<div class="account"><span class="dot"></span><b>No active account</b><span>—</span></div>';
    } else {
      for (const profile of provider.profiles) {
        const row = document.createElement('div');
        row.className = 'account' + (profile.signedIn ? ' on' : '') + (profile.enabled === false ? ' disabled' : '');
        row.innerHTML = '<span class="dot"></span><b></b><span class="account-kind"></span><span class="account-config"></span><button class="account-settings">Settings</button><button class="account-open">Open</button>';
        row.querySelector('b').textContent = profile.name;
        row.querySelector('.account-kind').textContent = profile.kind;
        const configParts = [];
        if (profile.enabled === false) configParts.push('disabled');
        if (profile.model) configParts.push(profile.model);
        if (profile.effort) configParts.push(profile.effort);
        if (profile.editable && Number.isFinite(profile.priority)) configParts.push('p' + profile.priority);
        row.querySelector('.account-config').textContent = configParts.join(' · ');
        const settingsButton = row.querySelector('.account-settings');
        settingsButton.hidden = !profile.editable;
        settingsButton.addEventListener('click', () => openAccountSettings(provider, profile));
        row.querySelector('.account-open').addEventListener('click', () => {
          openTerminal({ providerId: provider.id, profileId: profile.id, label: provider.name + ' · ' + profile.name })
            .catch(error => alert('Terminal error: ' + String(error)));
        });
        accounts.appendChild(row);
      }
    }

    const foot = fragment.querySelector('.provider-foot');
    if (provider.id === 'antigravity' && provider.installed) {
      foot.textContent = 'Native session detected via Antigravity secure keyring. Multi-account stays disabled until the CLI exposes a verified account/profile selector.';
    } else if (provider.managedProfilesVerified) {
      foot.textContent = 'Managed profile isolation verified. Use + to start a separate provider login.';
    } else if (provider.installed) {
      foot.textContent = 'Native session detection is active. Managed multi-account isolation is not enabled until verified.';
    }

    providersEl.appendChild(fragment);
  }
}

function renderJobs(jobs) {
  currentJobs = jobs;
  if (!jobs.length) {
    jobsEl.innerHTML = '<div class="empty">No TEAMYRA jobs found on this machine yet.</div>';
    return;
  }
  jobsEl.innerHTML = jobs.map(job => `
    <div class="job-row ${selectedJob === job.id ? 'selected' : ''}" data-job-id="${escapeHtml(job.id)}">
      <div><b>${escapeHtml(job.label)}</b><br><small>${escapeHtml(job.cwd)}</small></div>
      <span>${escapeHtml(job.worker)}</span>
      <span class="state ${escapeHtml(job.state)}">${escapeHtml(job.state)}</span>
      <small>${escapeHtml(job.lastEvent || job.reason || job.branch || '')}</small>
    </div>
  `).join('');

  jobsEl.querySelectorAll('.job-row').forEach(row => {
    row.addEventListener('click', () => selectJob(row.dataset.jobId));
  });
}

async function pumpTranscript(reset = false) {
  if (!selectedJob) return;
  const pre = document.querySelector('#transcript');
  if (reset) {
    transcriptOffset = 0;
    pre.textContent = '';
  }
  const result = await window.teamyra.transcript(selectedJob, transcriptOffset);
  if (result.text) {
    const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 32;
    pre.textContent += result.text;
    transcriptOffset = result.next;
    if (stick) pre.scrollTop = pre.scrollHeight;
  }
}

async function selectJob(jobId) {
  selectedJob = jobId;
  transcriptOffset = 0;
  const job = currentJobs.find(item => item.id === jobId);
  if (!job) return;

  document.querySelector('#detailTitle').textContent = job.label;
  const state = document.querySelector('#detailState');
  state.textContent = job.state;
  state.className = 'detail-state ' + job.state;
  document.querySelector('#detailMeta').textContent =
    [job.worker, job.branch || 'no branch', job.cwd].filter(Boolean).join(' · ');

  renderJobs(currentJobs);
  await pumpTranscript(true);

  clearInterval(transcriptTimer);
  transcriptTimer = setInterval(() => pumpTranscript(false).catch(() => {}), 1500);
}

async function refreshJobs() {
  const jobs = await window.teamyra.jobs();
  renderJobs(jobs);

  if (selectedJob) {
    const job = jobs.find(item => item.id === selectedJob);
    if (job) {
      const state = document.querySelector('#detailState');
      state.textContent = job.state;
      state.className = 'detail-state ' + job.state;
      document.querySelector('#detailMeta').textContent =
        [job.worker, job.branch || 'no branch', job.cwd].filter(Boolean).join(' · ');
    }
  }

  document.querySelector('#mRunning').textContent = jobs.filter(x => x.state === 'running' || x.state === 'starting').length;
  document.querySelector('#mJobs').textContent = jobs.length;
  return jobs;
}

async function refresh() {
  const providers = await window.teamyra.providers();
  const jobs = await refreshJobs();

  renderProviders(providers);
  if (selectedJob && !jobs.some(job => job.id === selectedJob)) {
    selectedJob = null;
    transcriptOffset = 0;
    clearInterval(transcriptTimer);
    document.querySelector('#detailTitle').textContent = 'Select a task';
    document.querySelector('#detailState').textContent = '—';
    document.querySelector('#detailMeta').textContent = 'Click a task to inspect its live transcript.';
    document.querySelector('#transcript').textContent = 'No task selected.';
  }

  document.querySelector('#mAgents').textContent = providers.filter(x => x.installed).length;
  document.querySelector('#mAccounts').textContent = providers.reduce(
    (n, x) => n + x.profiles.filter(p => p.signedIn && p.enabled !== false).length,
    0
  );
}

document.querySelector('#refresh').addEventListener('click', () => {
  const action = activeView === 'worktrees'
    ? refreshWorktrees()
    : activeView === 'observability'
      ? refreshObservability()
      : refresh();
  action.catch(error => alert('Refresh failed: ' + String(error?.message || error)));
});
setInterval(() => refreshJobs().catch(() => {}), 3000);
setInterval(() => {
  if (activeView === 'worktrees') refreshWorktrees({ preserveSelection: true }).catch(() => {});
  if (activeView === 'observability') refreshObservability({ preserveFilters: true, lightweight: true }).catch(() => {});
}, 5000);
refresh().catch(err => {
  providersEl.innerHTML = '<div class="empty">Desktop core error: ' + escapeHtml(err) + '</div>';
});


function selectedJobData() {
  return currentJobs.find(item => item.id === selectedJob) || null;
}

function ensureTerminalView() {
  if (terminal) return;
  const host = document.querySelector('#terminalHost');
  terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'Cascadia Mono, Consolas, ui-monospace, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    theme: {
      background: '#090c12',
      foreground: '#d8dee9',
      cursor: '#84dfff',
      selectionBackground: '#33455f'
    }
  });
  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(host);
  fitAddon.fit();

  terminal.onData(data => {
    if (terminalSessionId) window.teamyra.writeTerminal(terminalSessionId, data);
  });

  terminalResizeObserver = new ResizeObserver(() => {
    if (!fitAddon || !terminalSessionId) return;
    try {
      fitAddon.fit();
      window.teamyra.resizeTerminal(terminalSessionId, terminal.cols, terminal.rows);
    } catch {}
  });
  terminalResizeObserver.observe(host);
}

async function openTerminal(options = {}) {
  const panel = document.querySelector('#terminalPanel');
  panel.hidden = false;
  ensureTerminalView();

  const requestedCwd = options.cwd || selectedJobData()?.cwd || '';
  const requestedKey = options.providerId
    ? options.providerId + ':' + (options.profileId || 'native') + (options.login ? ':login' : ':session')
    : 'shell:' + requestedCwd;

  if (terminalSessionId && terminalContextKey === requestedKey) {
    terminal.focus();
    return;
  }
  if (terminalSessionId && terminalContextKey !== requestedKey) {
    try { await window.teamyra.closeTerminal(terminalSessionId); } catch {}
    terminalSessionId = null;
    terminal.clear();
  }

  const job = selectedJobData();
  terminal.clear();
  terminal.write('\x1b[90mStarting TEAMYRA terminal…\x1b[0m\r\n');
  const result = await window.teamyra.openTerminal({
    cwd: requestedCwd,
    providerId: options.providerId || '',
    profileId: options.profileId || 'native',
    login: options.login === true
  });
  if (!result.ok) {
    const reason = result.reason || 'terminal-unavailable';
    terminal.write('\x1b[31mCould not start terminal: ' + reason + '\x1b[0m\r\n');
    return;
  }

  terminalSessionId = result.id;
  terminalContextKey = requestedKey;
  document.querySelector('#terminalLabel').textContent =
    (options.label || ('Terminal · ' + (job?.label || 'TEAMYRA'))) + ' · ' + result.cwd;
  try {
    fitAddon.fit();
    window.teamyra.resizeTerminal(terminalSessionId, terminal.cols, terminal.rows);
  } catch {}
  terminal.focus();
}

async function closeTerminal() {
  if (terminalSessionId) {
    try { await window.teamyra.closeTerminal(terminalSessionId); } catch {}
  }
  terminalSessionId = null;
  terminalContextKey = '';
  if (terminal) terminal.clear();
  document.querySelector('#terminalPanel').hidden = true;
}

window.teamyra.onTerminalData(({ id, data }) => {
  if (terminal && id === terminalSessionId) terminal.write(data);
});

window.teamyra.onTerminalExit(({ id, exitCode }) => {
  if (!terminal || id !== terminalSessionId) return;
  terminal.write('\r\n\x1b[90m[process exited ' + exitCode + ']\x1b[0m\r\n');
  terminalSessionId = null;
  terminalContextKey = '';
});

document.querySelector('#openTerminal').addEventListener('click', () => {
  openTerminal({}).catch(error => alert('Terminal error: ' + String(error)));
});
document.querySelector('#closeTerminal').addEventListener('click', closeTerminal);


const commandView = document.querySelector('#commandView');
const worktreesView = document.querySelector('#worktreesView');
const observabilityView = document.querySelector('#observabilityView');
const navCommand = document.querySelector('#navCommand');
const navWorktrees = document.querySelector('#navWorktrees');
const navObservability = document.querySelector('#navObservability');
const worktreeListEl = document.querySelector('#worktreeList');
const wtDiffEl = document.querySelector('#wtDiff');
const wtSummaryEl = document.querySelector('#wtSummary');
const wtTitleEl = document.querySelector('#wtTitle');
const wtStateEl = document.querySelector('#wtState');
const wtMetaEl = document.querySelector('#wtMeta');
const wtRebaseButton = document.querySelector('#wtRebase');
const wtMergeButton = document.querySelector('#wtMerge');
const wtDiscardButton = document.querySelector('#wtDiscard');
const wtForceDiscardButton = document.querySelector('#wtForceDiscard');
const wtOpenTerminalButton = document.querySelector('#wtOpenTerminal');

const usageCardsEl = document.querySelector('#usageCards');
const timelineListEl = document.querySelector('#timelineList');
const obsProjectEl = document.querySelector('#obsProject');
const obsWorkerEl = document.querySelector('#obsWorker');
const obsSourceEl = document.querySelector('#obsSource');
const obsQueryEl = document.querySelector('#obsQuery');
const logSearchForm = document.querySelector('#logSearchForm');
const logSearchQueryEl = document.querySelector('#logSearchQuery');
const logSearchKindEl = document.querySelector('#logSearchKind');
const logSearchResultsEl = document.querySelector('#logSearchResults');

function setView(view) {
  activeView = ['worktrees', 'observability'].includes(view) ? view : 'command';
  const isCommand = activeView === 'command';
  const isWorktrees = activeView === 'worktrees';
  const isObservability = activeView === 'observability';

  commandView.hidden = !isCommand;
  worktreesView.hidden = !isWorktrees;
  observabilityView.hidden = !isObservability;
  navCommand.classList.toggle('active', isCommand);
  navWorktrees.classList.toggle('active', isWorktrees);
  navObservability.classList.toggle('active', isObservability);

  document.querySelector('#pageEyebrow').textContent = isWorktrees
    ? 'ISOLATED GIT WORKSPACES'
    : isObservability
      ? 'RUNTIME TELEMETRY'
      : 'MULTI-AGENT CONTROL PLANE';
  document.querySelector('#pageTitle').textContent = isWorktrees
    ? 'Worktrees'
    : isObservability
      ? 'Observability'
      : 'Command Desk';
  document.querySelector('#openTerminal').hidden = !isCommand;

  if (isWorktrees) refreshWorktrees({ preserveSelection: true }).catch(error => {
    worktreeListEl.innerHTML = '<div class="empty">Could not load worktrees: ' + escapeHtml(error?.message || error) + '</div>';
  });
  if (isObservability) refreshObservability({ preserveFilters: true }).catch(error => {
    document.querySelector('#timelineList').innerHTML =
      '<div class="empty">Could not load observability: ' + escapeHtml(error?.message || error) + '</div>';
  });
}

function worktreeState(item) {
  if (!item.exists) return 'missing';
  if (item.conflicts?.length) return 'conflict';
  if (item.dirty) return 'dirty';
  if (item.merged_at) return 'merged';
  return 'clean';
}

function renderWorktreeList(items) {
  worktreeListEl.innerHTML = '';
  if (!items.length) {
    worktreeListEl.innerHTML = '<div class="empty">No TEAMYRA-managed worktrees yet.</div>';
    return;
  }

  for (const item of items) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'worktree-card' + (selectedWorktreeId === item.id ? ' selected' : '');
    card.dataset.worktreeId = item.id;

    const top = document.createElement('div');
    top.className = 'worktree-card-top';
    const title = document.createElement('b');
    title.textContent = item.label || item.id;
    const state = document.createElement('span');
    state.className = 'worktree-badge ' + worktreeState(item);
    state.textContent = worktreeState(item);
    top.append(title, state);

    const branch = document.createElement('code');
    branch.textContent = item.branch || 'no branch';

    const meta = document.createElement('small');
    const bits = [];
    bits.push((item.commits?.length || 0) + ' commits');
    if (item.changes?.length) bits.push(item.changes.length + ' changes');
    if (item.conflicts?.length) bits.push(item.conflicts.length + ' conflicts');
    meta.textContent = bits.join(' · ');

    card.append(top, branch, meta);
    card.addEventListener('click', () => selectWorktree(item.id));
    worktreeListEl.appendChild(card);
  }
}

function updateWorktreeMetrics(items) {
  document.querySelector('#wtManaged').textContent = items.length;
  document.querySelector('#wtDirty').textContent = items.filter(item => item.dirty).length;
  document.querySelector('#wtConflicts').textContent = items.filter(item => item.conflicts?.length).length;
}

function setWorktreeActionsEnabled(enabled) {
  wtRebaseButton.disabled = !enabled;
  wtMergeButton.disabled = !enabled;
  wtDiscardButton.disabled = !enabled;
  wtForceDiscardButton.disabled = !enabled;
  wtOpenTerminalButton.disabled = !enabled;
}

function renderWorktreeSummary(item) {
  wtSummaryEl.innerHTML = '';
  const rows = [
    ['Target', item.target_branch || '—'],
    ['Branch', item.branch || '—'],
    ['Base', item.base_commit ? item.base_commit.slice(0, 12) : '—'],
    ['HEAD', item.head ? item.head.slice(0, 12) : '—'],
    ['Path', item.path || '—'],
    ['Commits', String(item.commits?.length || 0)],
    ['Changes', String(item.changes?.length || 0)],
    ['Conflicts', String(item.conflicts?.length || 0)]
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    const key = document.createElement('span');
    const val = document.createElement('code');
    key.textContent = label;
    val.textContent = value;
    row.append(key, val);
    wtSummaryEl.appendChild(row);
  }
}

async function selectWorktree(worktreeId) {
  selectedWorktreeId = worktreeId;
  renderWorktreeList(currentWorktrees);
  wtDiffEl.textContent = 'Loading diff…';
  setWorktreeActionsEnabled(false);

  const [item, diff] = await Promise.all([
    window.teamyra.worktreeStatus(worktreeId),
    window.teamyra.worktreeDiff(worktreeId, 80000)
  ]);

  const index = currentWorktrees.findIndex(row => row.id === worktreeId);
  if (index >= 0) currentWorktrees[index] = item;

  wtTitleEl.textContent = item.label || item.id;
  const state = worktreeState(item);
  wtStateEl.textContent = state;
  wtStateEl.className = 'detail-state ' + state;
  wtMetaEl.textContent = [item.id, item.branch, '→ ' + (item.target_branch || 'target')].filter(Boolean).join(' · ');
  renderWorktreeSummary(item);
  wtDiffEl.textContent = diff.diff || 'No tracked diff against the base commit.';
  if (diff.clipped) {
    wtDiffEl.textContent += '\n\n[Diff clipped at ' + diff.total_chars + ' characters]';
  }
  setWorktreeActionsEnabled(item.exists);
  renderWorktreeList(currentWorktrees);
}

async function refreshWorktrees(options = {}) {
  const preserveSelection = options.preserveSelection === true;
  const items = await window.teamyra.worktrees();
  currentWorktrees = Array.isArray(items) ? items : [];
  updateWorktreeMetrics(currentWorktrees);

  if (!preserveSelection || !currentWorktrees.some(item => item.id === selectedWorktreeId)) {
    selectedWorktreeId = currentWorktrees[0]?.id || null;
  }
  renderWorktreeList(currentWorktrees);

  if (selectedWorktreeId) {
    await selectWorktree(selectedWorktreeId);
  } else {
    wtTitleEl.textContent = 'Select a worktree';
    wtStateEl.textContent = '—';
    wtStateEl.className = 'detail-state';
    wtMetaEl.textContent = 'Choose a managed worktree to inspect its branch and diff.';
    wtSummaryEl.innerHTML = '';
    wtDiffEl.textContent = 'No worktree selected.';
    setWorktreeActionsEnabled(false);
  }
  return currentWorktrees;
}

function selectedWorktreeData() {
  return currentWorktrees.find(item => item.id === selectedWorktreeId) || null;
}


function compactNumber(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  return new Intl.NumberFormat(undefined, {
    notation: Math.abs(number) >= 1000 ? 'compact' : 'standard',
    maximumFractionDigits: 1
  }).format(number);
}

function formatTimelineTime(ts) {
  const value = Number(ts || 0);
  if (!value) return '—';
  try {
    return new Date(value * 1000).toLocaleString([], {
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  } catch {
    return '—';
  }
}

function renderUsageCards(snapshot) {
  currentUsage = snapshot;
  const workers = Array.isArray(snapshot?.workers) ? snapshot.workers : [];
  usageCardsEl.innerHTML = '';

  if (!workers.length) {
    usageCardsEl.innerHTML = '<div class="empty">No worker usage telemetry yet.</div>';
  } else {
    for (const worker of workers) {
      const card = document.createElement('article');
      card.className = 'usage-card' + (worker.ready === false ? ' unavailable' : '');

      const head = document.createElement('div');
      head.className = 'usage-card-head';
      const titleWrap = document.createElement('div');
      const title = document.createElement('b');
      title.textContent = worker.worker || 'worker';
      const subtitle = document.createElement('span');
      subtitle.textContent = [worker.provider, worker.model, worker.effort].filter(Boolean).join(' · ');
      titleWrap.append(title, subtitle);

      const state = document.createElement('span');
      const cooldown = Number(worker.cooldown_seconds || 0);
      const readiness = worker.ready === true ? 'ready' : worker.ready === false ? 'blocked' : 'detected';
      state.className = 'usage-state ' + (cooldown > 0 ? 'blocked' : readiness);
      state.textContent = cooldown > 0
        ? 'cooldown ' + Math.ceil(cooldown / 60) + 'm'
        : worker.ready === true
          ? 'ready'
          : worker.ready === false
            ? 'unavailable'
            : 'detected';

      head.append(titleWrap, state);

      const tokens = worker.tokens || {};
      const stats = document.createElement('div');
      stats.className = 'usage-stats';
      const rows = [
        ['Jobs', worker.jobs || 0],
        ['Input', compactNumber(tokens.input_tokens)],
        ['Cached', compactNumber((tokens.cached_input_tokens || 0) + (tokens.cache_read_tokens || 0))],
        ['Output', compactNumber(tokens.output_tokens)],
        ['Reasoning', compactNumber((tokens.reasoning_output_tokens || 0) + (tokens.thinking_tokens || 0))],
        ['Cache', worker.cache_ratio == null ? '—' : Math.round(worker.cache_ratio * 100) + '%']
      ];
      for (const [label, value] of rows) {
        const cell = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = String(value);
        const small = document.createElement('span');
        small.textContent = label;
        cell.append(strong, small);
        stats.appendChild(cell);
      }

      const foot = document.createElement('div');
      foot.className = 'usage-card-foot';
      const running = Array.isArray(worker.running_jobs) ? worker.running_jobs.length : Number(worker.running || 0);
      foot.textContent = running
        ? running + ' running · latest ' + (worker.latest_job_id || 'job')
        : 'Latest ' + (worker.latest_job_id || 'no persisted job yet');

      card.append(head, stats, foot);
      usageCardsEl.appendChild(card);
    }
  }

  document.querySelector('#obsWorkers').textContent = workers.length;
  document.querySelector('#obsReady').textContent = workers.filter(worker => worker.ready === true && !(worker.cooldown_seconds > 0)).length;
  document.querySelector('#obsRunning').textContent = workers.reduce(
    (sum, worker) => sum + (Array.isArray(worker.running_jobs) ? worker.running_jobs.length : Number(worker.running || 0)),
    0
  );
  document.querySelector('#obsJobs').textContent = Number(snapshot?.jobs || 0);

  const previous = obsWorkerEl.value;
  obsWorkerEl.innerHTML = '<option value="">All workers</option>';
  for (const worker of workers) {
    const option = document.createElement('option');
    option.value = worker.worker || '';
    option.textContent = worker.worker || '';
    obsWorkerEl.appendChild(option);
  }
  if ([...obsWorkerEl.options].some(option => option.value === previous)) {
    obsWorkerEl.value = previous;
  }
}

function renderTimeline(result) {
  currentTimeline = Array.isArray(result?.items) ? result.items : [];
  timelineListEl.innerHTML = '';

  if (!currentTimeline.length) {
    timelineListEl.innerHTML = '<div class="empty">No timeline items match the current filters.</div>';
    return;
  }

  for (const item of currentTimeline) {
    const row = document.createElement(item.job_id ? 'button' : 'div');
    if (item.job_id) row.type = 'button';
    row.className = 'timeline-item' + (item.job_id ? ' clickable' : '');

    const rail = document.createElement('div');
    rail.className = 'timeline-rail';
    const dot = document.createElement('span');
    dot.className = 'timeline-dot ' + (item.source || 'job');
    rail.appendChild(dot);

    const body = document.createElement('div');
    body.className = 'timeline-body';

    const top = document.createElement('div');
    top.className = 'timeline-top';
    const label = document.createElement('b');
    label.textContent = item.label || item.source_id || item.kind || 'event';
    const badge = document.createElement('span');
    badge.className = 'timeline-source ' + (item.source || '');
    badge.textContent = item.source || 'event';
    const time = document.createElement('time');
    time.textContent = formatTimelineTime(item.ts);
    top.append(label, badge, time);

    const message = document.createElement('p');
    message.textContent = item.message || item.kind || '';

    const meta = document.createElement('small');
    meta.textContent = [
      item.kind,
      item.worker,
      item.state,
      item.branch,
      item.node_id
    ].filter(Boolean).join(' · ');

    body.append(top, message, meta);
    row.append(rail, body);

    if (item.job_id) {
      row.addEventListener('click', async () => {
        setView('command');
        if (!currentJobs.some(job => job.id === item.job_id)) {
          try { await refreshJobs(); } catch {}
        }
        if (currentJobs.some(job => job.id === item.job_id)) {
          selectJob(item.job_id).catch(() => {});
        }
      });
    }
    timelineListEl.appendChild(row);
  }
}

function renderLogResults(result) {
  const rows = Array.isArray(result?.results) ? result.results : [];
  logSearchResultsEl.innerHTML = '';

  if (!rows.length) {
    logSearchResultsEl.innerHTML = '<div class="empty">No log matches found.</div>';
    return;
  }

  for (const item of rows) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'log-result';

    const top = document.createElement('div');
    top.className = 'log-result-top';
    const job = document.createElement('b');
    job.textContent = item.label || item.job_id || 'job';
    const file = document.createElement('code');
    file.textContent = (item.file || 'log') + ':' + (item.line || '—');
    top.append(job, file);

    const text = document.createElement('pre');
    text.textContent = item.text || '';
    const meta = document.createElement('small');
    meta.textContent = [item.worker, item.project_path].filter(Boolean).join(' · ');

    row.append(top, text, meta);
    row.addEventListener('click', async () => {
      setView('command');
      if (!currentJobs.some(jobItem => jobItem.id === item.job_id)) {
        try { await refreshJobs(); } catch {}
      }
      if (currentJobs.some(jobItem => jobItem.id === item.job_id)) {
        selectJob(item.job_id).catch(() => {});
      }
    });
    logSearchResultsEl.appendChild(row);
  }
}

async function refreshObservability(options = {}) {
  const filters = {
    projectPath: obsProjectEl.value.trim(),
    worker: obsWorkerEl.value,
    sources: obsSourceEl.value ? [obsSourceEl.value] : [],
    query: obsQueryEl.value.trim(),
    limit: 120
  };

  const timelinePromise = window.teamyra.timeline(filters);
  let usagePromise = null;

  if (!options.lightweight || !currentUsage) {
    usageCardsEl.classList.add('loading');
    usagePromise = window.teamyra.usage({ projectPath: filters.projectPath })
      .then(usage => {
        renderUsageCards(usage);
        return usage;
      })
      .catch(error => {
        if (!currentUsage) {
          usageCardsEl.innerHTML =
            '<div class="empty">Usage telemetry unavailable: ' + escapeHtml(error?.message || error) + '</div>';
        }
        return currentUsage;
      })
      .finally(() => usageCardsEl.classList.remove('loading'));
  }

  const timeline = await timelinePromise;
  renderTimeline(timeline);

  if (usagePromise) {
    usagePromise.catch(() => {});
  }
  return { usage: currentUsage, timeline };
}

async function runLogSearch() {
  const query = logSearchQueryEl.value.trim();
  if (!query) {
    logSearchResultsEl.innerHTML = '<div class="empty">Enter a query to search persisted TEAMYRA logs.</div>';
    return;
  }

  logSearchResultsEl.innerHTML = '<div class="empty">Searching logs…</div>';
  const kind = logSearchKindEl.value;
  const result = await window.teamyra.searchLogs({
    query,
    limit: 80,
    projectPath: obsProjectEl.value.trim(),
    worker: obsWorkerEl.value,
    kinds: kind ? [kind] : []
  });
  renderLogResults(result);
}

let observabilityFilterTimer = null;
function scheduleTimelineRefresh(full = false) {
  clearTimeout(observabilityFilterTimer);
  observabilityFilterTimer = setTimeout(() => {
    refreshObservability({
      preserveFilters: true,
      lightweight: !full
    }).catch(error => {
      timelineListEl.innerHTML = '<div class="empty">Timeline refresh failed: ' + escapeHtml(error?.message || error) + '</div>';
    });
  }, 300);
}


navCommand.addEventListener('click', () => setView('command'));
navWorktrees.addEventListener('click', () => setView('worktrees'));
navObservability.addEventListener('click', () => setView('observability'));

document.querySelector('#refreshObservability').addEventListener('click', () => {
  refreshObservability().catch(error => {
    timelineListEl.innerHTML = '<div class="empty">Observability refresh failed: ' + escapeHtml(error?.message || error) + '</div>';
  });
});
obsProjectEl.addEventListener('change', () => scheduleTimelineRefresh(true));
obsWorkerEl.addEventListener('change', () => scheduleTimelineRefresh(false));
obsSourceEl.addEventListener('change', () => scheduleTimelineRefresh(false));
obsQueryEl.addEventListener('input', () => scheduleTimelineRefresh(false));
logSearchForm.addEventListener('submit', event => {
  event.preventDefault();
  runLogSearch().catch(error => {
    logSearchResultsEl.innerHTML = '<div class="empty">Log search failed: ' + escapeHtml(error?.message || error) + '</div>';
  });
});

document.querySelector('#refreshWorktrees').addEventListener('click', () => {
  refreshWorktrees({ preserveSelection: true }).catch(error => alert('Worktree refresh failed: ' + String(error?.message || error)));
});

document.querySelector('#createWorktree').addEventListener('click', async () => {
  const projectPath = prompt('Repository path for the new worktree:');
  if (!projectPath) return;
  const label = prompt('Worktree label:', 'task');
  if (label === null) return;
  const baseRef = prompt('Base ref:', 'HEAD');
  if (baseRef === null) return;
  try {
    const created = await window.teamyra.createWorktree({
      projectPath,
      label: label || 'task',
      baseRef: baseRef || 'HEAD'
    });
    selectedWorktreeId = created.id;
    await refreshWorktrees({ preserveSelection: true });
  } catch (error) {
    alert('Could not create worktree: ' + String(error?.message || error));
  }
});

wtOpenTerminalButton.addEventListener('click', () => {
  const item = selectedWorktreeData();
  if (!item?.exists) return;
  openTerminal({ cwd: item.path, label: 'Worktree · ' + (item.label || item.id) })
    .catch(error => alert('Terminal error: ' + String(error?.message || error)));
});

wtRebaseButton.addEventListener('click', async () => {
  const item = selectedWorktreeData();
  if (!item) return;
  const message = 'Update branch "' + item.branch + '" onto the latest "' + item.target_branch + '"?\n\nTEAMYRA requires a clean worktree and automatically aborts the rebase if conflicts occur.';
  if (!confirm(message)) return;
  try {
    await window.teamyra.rebaseWorktree(item.id, true);
    await refreshWorktrees({ preserveSelection: true });
    alert('Worktree branch updated successfully.');
  } catch (error) {
    alert('Update branch blocked: ' + String(error?.message || error));
  }
});

wtMergeButton.addEventListener('click', async () => {
  const item = selectedWorktreeData();
  if (!item) return;
  const message = 'Merge branch "' + item.branch + '" into "' + item.target_branch + '"?\n\nTEAMYRA will refuse dirty worktrees, dirty targets, or unresolved conflicts.';
  if (!confirm(message)) return;
  try {
    await window.teamyra.mergeWorktree(item.id, true);
    await refreshWorktrees({ preserveSelection: true });
    alert('Worktree merged successfully.');
  } catch (error) {
    alert('Merge blocked: ' + String(error?.message || error));
  }
});

wtDiscardButton.addEventListener('click', async () => {
  const item = selectedWorktreeData();
  if (!item) return;
  if (!confirm('Remove this worktree after verifying its branch is already merged?\n\n' + item.branch)) return;
  try {
    await window.teamyra.discardWorktree(item.id, { confirm: true, force: false });
    selectedWorktreeId = null;
    await refreshWorktrees();
  } catch (error) {
    alert('Discard blocked: ' + String(error?.message || error));
  }
});

wtForceDiscardButton.addEventListener('click', async () => {
  const item = selectedWorktreeData();
  if (!item) return;
  const phrase = prompt(
    'Force discard can permanently delete unmerged/uncommitted work in this worktree.\nType DISCARD to continue:'
  );
  if (phrase !== 'DISCARD') return;
  if (!confirm('Final confirmation: permanently force-discard ' + item.branch + '?')) return;
  try {
    await window.teamyra.discardWorktree(item.id, { confirm: true, force: true });
    selectedWorktreeId = null;
    await refreshWorktrees();
  } catch (error) {
    alert('Force discard failed: ' + String(error?.message || error));
  }
});
