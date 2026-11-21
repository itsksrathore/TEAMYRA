const path = require('node:path');
const { callCore } = require('../core-api');
const { SunoView, SunoDownloads, partitionForSuno, safeProfileId, sunoProfiles, SUNO_HOME, SUNO_LIBRARY, BUILTIN_PROFILE } = require('./suno-provider');
const { SunoJobConsumer } = require('./suno-job-consumer');
const { SunoAdapter, clipSummary } = require('./suno-adapter');

const ANONYMOUS_COOKIE = /^(statsig|ajs_|suno_device_id|suno_sidenav|__stripe|stripe_|g_state|_ga|_gcl|_fbp|__cf|cf_|mineos|cmp|consent|OptanonConsent|_ttp|__hstc|hubspot)/i;

// Suno in TEAMYRA Desktop: one runtime per Suno account (built-in "suno" and
// profiles/suno/<id>), each with its own persistent session. The user opens an
// account from the Agents panel and signs in there; only signed-in, enabled
// accounts take queued Suno jobs. Workers start when the core wakes the "suno"
// surface and stop again after being idle.
class SunoAccountRuntime {
  constructor({ window, profileId, engine, core = callCore, session = null }) {
    this.window = window;
    this.engine = engine;
    this.profileId = safeProfileId(profileId);
    this.core = core;
    this.partition = partitionForSuno(this.profileId);
    this.session = session || require('electron').session.fromPartition(this.partition, { cache: true });
    this.display = new SunoView({ window, session: this.session, visible: true, signIn: true });
    this.worker = new SunoView({ window, session: this.session });
    this.downloads = new SunoDownloads(this.session, { isUserView: id => id === this.display.webContentsId });
    this.status = { signedIn: null, credits: null, checkedAt: 0, detail: '' };
    this.consumer = new SunoJobConsumer({
      workerName: 'suno-' + this.profileId, provider: this.worker, profileId: this.profileId, downloads: this.downloads,
      mayClaim: () => this.mayWork(),
      onSignedIn: (value, detail) => this.setSignedIn(value, detail),
      onActivity: () => {}
    });
  }

  meta() { return this.engine?.accountMeta(this.profileId) || { enabled: true }; }
  mayWork() { return this.meta().enabled !== false && this.status.signedIn === true; }

  setSignedIn(value, detail = '', credits = undefined) {
    const changed = this.status.signedIn !== value;
    this.status = { ...this.status, signedIn: value, checkedAt: Date.now(), detail: String(detail || '').slice(0, 300),
      ...(credits !== undefined ? { credits } : {}) };
    if (changed || credits !== undefined) {
      this.core('media.suno-account-status', { profile_id: this.profileId, patch: { signed_in: value === true,
        credits: this.status.credits, detail: this.status.detail } }, { timeout: 10000 }).catch(() => {});
      this.engine?.invalidate?.();
    }
  }

  // A quick cookie check; the page itself (hidden worker tab) when unsure.
  // Signed out, suno.com holds only anonymous cookies (device id, analytics,
  // Stripe, consent); any other cookie may be a sign-in, which the page decides.
  async refreshStatus({ page = false } = {}) {
    let anonymous = false;
    try {
      const cookies = await this.session.cookies.get({ domain: 'suno.com' });
      anonymous = cookies.every(cookie => ANONYMOUS_COOKIE.test(cookie.name));
    } catch {}
    if (!page) {
      if (anonymous) { this.setSignedIn(false, 'not signed in'); return this.status; }
      if (this.status.pageCheckedAt && Date.now() - this.status.pageCheckedAt < 10 * 60 * 1000) return this.status;
    }
    if (this.consumer.busy) return this.status;
    const view = this.worker;
    try {
      await view.load(SUNO_HOME);
      const adapter = view.adapter || (view.adapter = new SunoAdapter(view.view.webContents));
      const result = await adapter.signedIn();
      this.status.pageCheckedAt = Date.now();
      this.setSignedIn(result.signedIn === true, result.signedIn ? '' : 'not signed in', result.credits ?? null);
    } catch (error) {
      this.status = { ...this.status, detail: String(error?.message || error).slice(0, 300) };
    }
    return this.status;
  }

  async open() {
    await this.display.load(SUNO_HOME);
    this.display.setVisible(true);
    // The user may sign in now; check again shortly after.
    setTimeout(() => this.refreshStatus({ page: false }).catch(() => {}), 30000).unref?.();
    return { profile_id: this.profileId, url: this.display.view?.webContents?.getURL?.() || SUNO_HOME };
  }

  startWorker() { if (this.mayWork()) this.consumer.start(); }

  snapshot() {
    return { profile_id: this.profileId, name: this.meta().name || this.profileId, enabled: this.meta().enabled !== false,
      signed_in: this.status.signedIn === true, signed_in_known: this.status.signedIn !== null, credits: this.status.credits,
      detail: this.status.detail, busy: this.consumer.busy, worker: this.consumer.status(), partition: this.partition };
  }

  // Recent clips as the Library page shows them, with the data its API returned.
  async listClips(limit = 20) {
    const view = new SunoView({ window: this.window, session: this.session });
    try {
      view.ensureView();
      const adapter = new SunoAdapter(view.view.webContents);
      await adapter.startCapture().catch(() => null);
      await view.load(SUNO_LIBRARY);
      const state = await adapter.ready().catch(error => ({ error }));
      if (state.error) {
        if (/login_required/.test(String(state.error.message))) this.setSignedIn(false, 'not signed in');
        return { signed_in: false, clips: [], error: String(state.error.message || state.error) };
      }
      this.setSignedIn(true, '', state.credits ?? undefined);
      await adapter.sleep(2500);
      const rows = await adapter.clipRows(limit).catch(() => []);
      const clips = rows.map(row => {
        const data = adapter.clips.get(row.clip_id) || {};
        return { clip_id: row.clip_id, title: data.title || row.title, status: data.status || null, duration: data.duration || null,
          duration_text: row.duration_text, model: data.model || row.model_text || null, style: data.style || null,
          created_at: data.created_at || null, url: 'https://suno.com/song/' + row.clip_id };
      });
      // Clips the page's API listed but the rows did not show yet.
      for (const [id, data] of adapter.clips) {
        if (clips.length >= limit || clips.some(item => item.clip_id === id)) continue;
        clips.push({ clip_id: id, title: data.title, status: data.status, duration: data.duration, model: data.model, style: data.style,
          created_at: data.created_at, url: 'https://suno.com/song/' + id });
      }
      return { signed_in: true, credits: state.credits ?? null, clips: clips.slice(0, limit),
        source: adapter.clips.size ? 'page+network' : 'page' };
    } finally {
      view.destroy({ force: true });
    }
  }

  destroy() {
    this.consumer.stop();
    this.display.destroy({ force: true });
    this.worker.destroy({ force: true });
  }
}

class SunoEngine {
  constructor({ window, root, profilesRoot = null, builtinFile = null, core = callCore, Runtime = SunoAccountRuntime }) {
    this.window = window;
    this.root = root;
    this.profilesRoot = profilesRoot || path.join(root, 'profiles', 'suno');
    this.builtinFile = builtinFile || path.join(this.profilesRoot, 'builtin-suno.json');
    this.core = core;
    this.Runtime = Runtime;
    this.accounts = new Map();
    this.activeProfileId = null;
    this.visible = false;
    this.bounds = null;
    this.onChange = () => {};
  }

  profiles() { return sunoProfiles(this.profilesRoot, this.builtinFile); }
  accountMeta(id) { return this.profiles().find(item => item.id === id) || { id, enabled: false }; }
  invalidate() { try { this.onChange(); } catch {} }

  ensure(profileId = BUILTIN_PROFILE) {
    const id = safeProfileId(profileId);
    if (!this.profiles().some(item => item.id === id)) throw new Error('Unknown Suno account: ' + id);
    let runtime = this.accounts.get(id);
    if (!runtime) {
      runtime = new this.Runtime({ window: this.window, profileId: id, engine: this, core: this.core });
      this.accounts.set(id, runtime);
      if (this.bounds) runtime.display.setBounds(this.bounds);
    }
    return runtime;
  }

  initialize() {
    // Cookie checks only (no page loads) so start-up stays light.
    for (const profile of this.profiles()) this.ensure(profile.id).refreshStatus().catch(() => {});
    return this;
  }

  async open(profileId = BUILTIN_PROFILE) {
    const runtime = this.ensure(profileId);
    for (const [id, other] of this.accounts) if (id !== runtime.profileId) other.display.setVisible(false);
    this.activeProfileId = runtime.profileId;
    this.visible = true;
    if (this.bounds) runtime.display.setBounds(this.bounds);
    return runtime.open();
  }

  setVisible(value) {
    this.visible = value === true;
    for (const [id, runtime] of this.accounts) runtime.display.setVisible(this.visible && id === this.activeProfileId);
    return { visible: this.visible, profile_id: this.activeProfileId };
  }

  setBounds(bounds = {}) {
    this.bounds = { x: Math.round(bounds.x || 0), y: Math.round(bounds.y || 0), width: Math.max(50, Math.round(bounds.width || 0)),
      height: Math.max(50, Math.round(bounds.height || 0)) };
    for (const runtime of this.accounts.values()) runtime.display.setBounds(this.bounds);
    return this.bounds;
  }

  close() {
    this.setVisible(false);
    // The open account may have just signed in.
    if (this.activeProfileId) this.accounts.get(this.activeProfileId)?.refreshStatus({ page: false }).catch(() => {});
    return { visible: false };
  }

  // Sign-in checked again now, with the page (not only cookies).
  async refresh(profileId = BUILTIN_PROFILE) {
    const runtime = this.ensure(profileId);
    await runtime.refreshStatus({ page: true });
    return runtime.snapshot();
  }

  // Developer only (gated by the caller): a script in the account's worker
  // page, after loading a Suno URL if given. Not used while a job runs there.
  async debugEval(profileId, script, url = '') {
    const runtime = this.ensure(profileId);
    if (runtime.consumer.busy) throw new Error('the Suno worker is busy with a job');
    const view = runtime.worker;
    if (url) await view.load(url);
    else view.ensureView();
    return view.view.webContents.executeJavaScript(script, true);
  }

  async profileStatus(profileId) {
    const runtime = this.ensure(profileId);
    if (!runtime.status.checkedAt) await runtime.refreshStatus().catch(() => {});
    return runtime.snapshot();
  }

  status() {
    return { accounts: this.profiles().map(profile => this.ensure(profile.id).snapshot()), active_profile_id: this.activeProfileId };
  }

  // The core queued Suno work: check the accounts and start their workers.
  async wakeAll() {
    const results = [];
    for (const profile of this.profiles()) {
      const runtime = this.ensure(profile.id);
      if (profile.enabled !== false && runtime.status.signedIn !== true) await runtime.refreshStatus({ page: true }).catch(() => {});
      runtime.startWorker();
      results.push({ profile_id: runtime.profileId, signed_in: runtime.status.signedIn === true, enabled: profile.enabled !== false,
        working: runtime.consumer.running });
    }
    return { surface: 'suno', accounts: results, tabs_per_account: 1,
      needs_user_auth: !results.some(item => item.signed_in && item.enabled) };
  }

  // For the core's wake call (it waits only a few seconds): answer quickly while
  // page checks of not-yet-known accounts go on.
  async wake({ waitMs = 3500 } = {}) {
    const pending = this.wakeAll();
    pending.catch(() => {});
    const quick = new Promise(resolve => setTimeout(() => resolve(null), waitMs));
    const done = await Promise.race([pending, quick]);
    if (done) return done;
    const accounts = this.profiles().map(profile => {
      const runtime = this.ensure(profile.id);
      return { profile_id: runtime.profileId, signed_in: runtime.status.signedIn === true, enabled: profile.enabled !== false,
        working: runtime.consumer.running };
    });
    return { surface: 'suno', waking: true, accounts, tabs_per_account: 1, needs_user_auth: false,
      note: 'Checking Suno sign-in in the background' };
  }

  async clips(profileId = BUILTIN_PROFILE, limit = 20) {
    const runtime = this.ensure(profileId);
    return { profile_id: runtime.profileId, ...(await runtime.listClips(Math.max(1, Math.min(100, Number(limit) || 20)))) };
  }

  busy() { return [...this.accounts.values()].some(runtime => runtime.consumer.busy); }

  destroy() {
    for (const runtime of this.accounts.values()) { try { runtime.destroy(); } catch {} }
    this.accounts.clear();
  }
}

module.exports = { SunoEngine, SunoAccountRuntime, clipSummary };
