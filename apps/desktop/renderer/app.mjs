import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

let terminal = null;
let fitAddon = null;
let terminalSessionId = null;
let terminalResizeObserver = null;

let selectedJob = null;
let transcriptOffset = 0;
let transcriptTimer = null;
let currentJobs = [];

const providersEl = document.querySelector('#providers');
const jobsEl = document.querySelector('#jobs');
const providerTpl = document.querySelector('#providerTpl');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[ch]));
}

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
          alert('Login started for ' + result.name + '. Complete the provider sign-in, then press Refresh.');
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
        row.className = 'account' + (profile.signedIn ? ' on' : '');
        row.innerHTML = '<span class="dot"></span><b></b><span></span>';
        row.querySelector('b').textContent = profile.name;
        row.querySelector('span').textContent = profile.kind;
        accounts.appendChild(row);
      }
    }

    const foot = fragment.querySelector('.provider-foot');
    if (provider.managedProfilesVerified) {
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
  document.querySelector('#mAccounts').textContent = providers.reduce((n, x) => n + x.profiles.filter(p => p.signedIn).length, 0);
}

document.querySelector('#refresh').addEventListener('click', refresh);
setInterval(() => refreshJobs().catch(() => {}), 3000);
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

async function openTerminal() {
  const panel = document.querySelector('#terminalPanel');
  panel.hidden = false;
  ensureTerminalView();

  if (terminalSessionId) {
    terminal.focus();
    return;
  }

  const job = selectedJobData();
  terminal.clear();
  terminal.write('\x1b[90mStarting TEAMYRA terminal…\x1b[0m\r\n');
  const result = await window.teamyra.openTerminal({ cwd: job?.cwd || '' });
  if (!result.ok) {
    terminal.write('\x1b[31mPTY unavailable. Install desktop dependencies and restart TEAMYRA.\x1b[0m\r\n');
    return;
  }

  terminalSessionId = result.id;
  document.querySelector('#terminalLabel').textContent =
    'Terminal · ' + (job?.label || 'TEAMYRA') + ' · ' + result.cwd;
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
});

document.querySelector('#openTerminal').addEventListener('click', () => {
  openTerminal().catch(error => alert('Terminal error: ' + String(error)));
});
document.querySelector('#closeTerminal').addEventListener('click', closeTerminal);
