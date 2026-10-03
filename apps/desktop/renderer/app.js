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
        const result = await window.teamyra.addAccount(provider.id);
        if (!result.ok) {
          alert('Managed multi-account isolation is not verified for ' + provider.name + ' yet.');
        } else {
          alert('Login started for ' + provider.name + '. Complete the provider sign-in, then press Refresh.');
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
  if (!jobs.length) {
    jobsEl.innerHTML = '<div class="empty">No TEAMYRA jobs found on this machine yet.</div>';
    return;
  }
  jobsEl.innerHTML = jobs.map(job => `
    <div class="job-row">
      <div><b>${escapeHtml(job.label)}</b><br><small>${escapeHtml(job.cwd)}</small></div>
      <span>${escapeHtml(job.worker)}</span>
      <span class="state ${escapeHtml(job.state)}">${escapeHtml(job.state)}</span>
      <small>${escapeHtml(job.lastEvent || job.reason || job.branch || '')}</small>
    </div>
  `).join('');
}

async function refresh() {
  const [providers, jobs] = await Promise.all([
    window.teamyra.providers(),
    window.teamyra.jobs()
  ]);

  renderProviders(providers);
  renderJobs(jobs);

  document.querySelector('#mAgents').textContent = providers.filter(x => x.installed).length;
  document.querySelector('#mAccounts').textContent = providers.reduce((n, x) => n + x.profiles.filter(p => p.signedIn).length, 0);
  document.querySelector('#mRunning').textContent = jobs.filter(x => x.state === 'running' || x.state === 'starting').length;
  document.querySelector('#mJobs').textContent = jobs.length;
}

document.querySelector('#refresh').addEventListener('click', refresh);
refresh().catch(err => {
  providersEl.innerHTML = '<div class="empty">Desktop core error: ' + escapeHtml(err) + '</div>';
});
