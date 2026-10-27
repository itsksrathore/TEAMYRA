const fs = require('node:fs');
const path = require('node:path');
const { callCore } = require('../core-api');
const { profileRoot } = require('../provider-registry');
const { GoogleMediaSessionManager, safeProfileId } = require('./google-media-session-manager');
const { MediaDownloadManager } = require('./media-download-manager');
const { GoogleFlowProvider } = require('./google-flow-provider');
const { GoogleFlowMusicProvider } = require('./google-flow-music-provider');
const { MediaJobConsumer } = require('./media-job-consumer');

const HUNG_RELOAD_GAP_MS = 3 * 60 * 1000;
// Bulk work runs in several hidden Flow tabs ("lanes"), each with its own
// page and its own Flow project per folder, so submissions, result watching
// and downloads in one tab do not wait for another. TEAMYRA_FLOW_LANES=1
// turns this off.
const DEFAULT_FLOW_LANES = 3;
const MAX_FLOW_LANES = 4;

function flowLaneCount(value = globalThis.process?.env?.TEAMYRA_FLOW_LANES) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number >= 1 ? Math.min(MAX_FLOW_LANES, number) : DEFAULT_FLOW_LANES;
}

// A probe that failed (page busy, navigating or hung) says nothing about the
// Google session. Keep the last known sign-in state instead of reporting a
// logout, which would park every job in needs_user_auth.
function observedStatus(status = {}, last = {}, surface = 'visual') {
  if (status.probe_ok !== false) return status;
  const visual = surface !== 'music';
  return {
    ...status,
    loaded: true,
    unknown: true,
    signedIn: visual ? last.connected === true : last.music_signed_in === true,
    challenged: visual ? last.challenged === true : false,
    promptFound: visual ? last.flow_ready === true : last.music_ready === true
  };
}

const GOOGLE_LOGIN_URL = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fflow.google.com%2F';
const STATUS_CACHE_MS = 15000;
const BROWSER_IDLE_MS = 45000;
// A saved connection status older than this is re-probed at startup.
const STALE_STATUS_MS = 10 * 60 * 1000;
// An account that ran out of Flow credits takes no new work for this long
// while other accounts can (its accepted generations still finish).
const CREDITS_PARK_MS = 30 * 60 * 1000;
// One whose Flow upload terms are not accepted is tried again after this, or
// as soon as the user opens it in TEAMYRA (where they can accept them).
const TERMS_PARK_MS = 20 * 60 * 1000;

// Every Google Media account: the built-in one and those added in Settings,
// with the enabled flag and priority kept in their teamyra-profile.json.
function mediaProfiles(root = profileRoot('google-media')) {
  const profiles = [{ id: 'google', enabled: true, priority: 250 }];
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch {}
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'google' || safeProfileId(entry.name) !== entry.name) continue;
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(root, entry.name, 'teamyra-profile.json'), 'utf8')) || {}; } catch {}
    const priority = Number(meta.priority);
    profiles.push({ id: entry.name, enabled: meta.enabled !== false, priority: Number.isFinite(priority) ? priority : 100 });
  }
  return profiles;
}

class GoogleMediaProfileRuntime {
  constructor({ window, profileId, ready = Promise.resolve(), engine = null }) {
    this.window = window;
    this.engine = engine;
    this.profileId = safeProfileId(profileId);
    this.parkedUntil = 0;
    this.parkReason = '';
    const accountHooks = {
      isMain: () => !this.engine || this.engine.mainProfileId() === this.profileId,
      onAccountProblem: (kind, reason) => this.accountProblem(kind, reason)
    };
    this.sessionManager = new GoogleMediaSessionManager(this.profileId);
    this.downloadManager = new MediaDownloadManager(this.sessionManager);
    this.visual = new GoogleFlowProvider({ window, sessionManager: this.sessionManager });
    this.music = new GoogleFlowMusicProvider({ window, sessionManager: this.sessionManager });
    const lanes = flowLaneCount();
    this.visualConsumer = new MediaJobConsumer({
      surface: 'visual',
      workerName: 'google-media-' + this.profileId + '-visual',
      provider: this.visual,
      downloadManager: this.downloadManager,
      profileId: this.profileId,
      ready,
      onActivity: () => this.touch(),
      lane: 0,
      lanes,
      ...accountHooks
    });
    // Extra tabs are never shown; the download manager tells their downloads
    // apart by the tab that started them.
    this.extraLanes = [];
    for (let lane = 1; lane < lanes; lane += 1) {
      const provider = new GoogleFlowProvider({ window, sessionManager: this.sessionManager });
      this.extraLanes.push({
        provider,
        consumer: new MediaJobConsumer({
          surface: 'visual',
          workerName: 'google-media-' + this.profileId + '-visual-tab' + (lane + 1),
          provider,
          downloadManager: this.downloadManager,
          profileId: this.profileId,
          ready,
          onActivity: () => this.touch(),
          lane,
          lanes,
          ...accountHooks
        })
      });
    }
    this.musicConsumer = new MediaJobConsumer({
      surface: 'music',
      workerName: 'google-media-' + this.profileId + '-music',
      provider: this.music,
      downloadManager: this.downloadManager,
      profileId: this.profileId,
      ready,
      onActivity: () => this.touch()
    });
    this.started = false;
    this.visualConsumerStarted = false;
    this.musicConsumerStarted = false;
    this.unloadTimer = null;
    this.activityUntil = 0;
    this.wakingCount = 0;
    this.refreshPromise = null;
    this.signInWatch = null;
    this.lastRefreshAt = 0;
    this.lastStatus = {
      profile_id: this.profileId,
      connected: false,
      signed_in: false,
      needs_user_auth: true,
      challenged: false,
      flow_ready: false,
      music_signed_in: false,
      music_needs_user_auth: true,
      music_ready: false,
      capabilities: { visual: {}, music: {} },
      visual_url: '',
      music_url: '',
      detail: 'Google Media session has not been verified yet'
    };
  }

  initialize() {
    if (this.started) return;
    this.started = true;
    this.sessionManager.initialize();
  }

  visualConsumers() {
    return [this.visualConsumer, ...this.extraLanes.map(lane => lane.consumer)];
  }

  setConsumerState(kind, enabled) {
    if (kind === 'visual') {
      if (enabled && !this.visualConsumerStarted) {
        for (const consumer of this.visualConsumers()) consumer.start();
        this.visualConsumerStarted = true;
      } else if (!enabled && this.visualConsumerStarted) {
        for (const consumer of this.visualConsumers()) consumer.stop();
        this.visualConsumerStarted = false;
      }
      return;
    }
    if (enabled && !this.musicConsumerStarted) {
      this.musicConsumer.start();
      this.musicConsumerStarted = true;
    } else if (!enabled && this.musicConsumerStarted) {
      this.musicConsumer.stop();
      this.musicConsumerStarted = false;
    }
  }

  stopConsumers() {
    this.setConsumerState('visual', false);
    this.setConsumerState('music', false);
  }

  cancelUnload() {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    this.unloadTimer = null;
  }

  touch() {
    this.activityUntil = Date.now() + BROWSER_IDLE_MS;
    this.cancelUnload();
    this.scheduleUnload(BROWSER_IDLE_MS);
  }

  scheduleUnload(delayMs = BROWSER_IDLE_MS) {
    this.cancelUnload();
    this.unloadTimer = setTimeout(() => {
      this.unloadTimer = null;
      // An idle extra tab is released even while other tabs keep working.
      for (const lane of this.extraLanes) if (!lane.consumer.busy) lane.provider.destroy();
      if (this.visualConsumers().some(consumer => consumer.busy) || this.musicConsumer.busy || this.wakingCount > 0 || this.refreshPromise || Date.now() < this.activityUntil) {
        this.scheduleUnload(BROWSER_IDLE_MS);
        return;
      }
      if (this.visual.visible || this.music.visible) return;
      this.visual.destroy();
      this.music.destroy();
    }, Math.max(1000, Number(delayMs) || BROWSER_IDLE_MS));
    this.unloadTimer.unref?.();
  }

  // Can this account take new Flow work now?
  working() {
    return this.visualConsumerStarted && this.lastStatus.connected === true &&
      this.lastStatus.challenged !== true && Date.now() >= this.parkedUntil;
  }

  // A consumer found this account unable to take new work. Park it only when
  // another account is working, so its unsubmitted jobs move there; alone, it
  // keeps the old behaviour (jobs wait in needs_user_auth for the user).
  accountProblem(kind, reason = '') {
    if (!this.engine?.otherWorking(this.profileId)) return false;
    console.warn('[google-media] account ' + this.profileId + ' parked: ' + kind + ' (' + reason + ')');
    this.parkReason = String(reason || kind);
    if (kind === 'credits' || kind === 'upload_terms') {
      this.parkedUntil = Date.now() + (kind === 'credits' ? CREDITS_PARK_MS : TERMS_PARK_MS);
      for (const consumer of this.visualConsumers()) {
        consumer.pausedUntil = Math.max(consumer.pausedUntil, this.parkedUntil);
        consumer.pauseReason = this.parkReason;
      }
      return true;
    }
    this.lastStatus = { ...this.lastStatus, connected: false, signed_in: false, needs_user_auth: true,
      challenged: kind === 'challenged', detail: this.parkReason };
    this.setConsumerState('visual', false);
    return true;
  }

  unpark() {
    if (!this.parkedUntil) return;
    this.parkedUntil = 0;
    for (const consumer of this.visualConsumers()) consumer.pausedUntil = 0;
  }

  pipelineSnapshot() {
    const lanes = this.visualConsumers().map(consumer => consumer.pipelineStatus());
    const sum = key => lanes.reduce((total, lane) => total + (Number(lane[key]) || 0), 0);
    return {
      ...lanes[0],
      profile_id: this.profileId,
      in_flight: sum('in_flight'),
      downloads_active: sum('downloads_active'),
      downloads_waiting: sum('downloads_waiting'),
      tabs: lanes.length,
      lanes
    };
  }

  snapshot() {
    const visualBusy = this.visualConsumers().some(consumer => consumer.busy);
    return {
      ...this.lastStatus,
      visible: this.visual.visible || this.music.visible,
      busy: visualBusy || this.musicConsumer.busy,
      visual_busy: visualBusy,
      music_busy: this.musicConsumer.busy,
      visual_pipeline: this.pipelineSnapshot(),
      working: this.working(),
      parked_until: this.parkedUntil > Date.now() ? this.parkedUntil / 1000 : null,
      park_reason: this.parkedUntil > Date.now() || !this.lastStatus.connected ? this.parkReason : '',
      visual_audio_muted: this.visual.view?.webContents?.isAudioMuted?.() ?? null,
      music_audio_muted: this.music.view?.webContents?.isAudioMuted?.() ?? null,
      current_url: this.visual.view?.webContents?.getURL?.()
        || this.music.view?.webContents?.getURL?.()
        || this.lastStatus.current_url
        || ''
    };
  }

  async refreshConnection({ force = false, allowLoad = false } = {}) {
    this.initialize();
    const now = Date.now();
    if (!force && this.lastRefreshAt && now - this.lastRefreshAt < STATUS_CACHE_MS) return this.snapshot();
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      let visualStatus = { loaded: false, signedIn: false };
      let musicStatus = { loaded: false, signedIn: false };
      let visualCapabilities = this.lastStatus.capabilities?.visual || {};
      let musicCapabilities = this.lastStatus.capabilities?.music || {};

      if (!this.visual.view && allowLoad) {
        await this.visual.ensureLoaded().catch(() => {});
      }
      if (this.visual.view) {
        const inspection = await this.visual.inspect(force ? 15000 : 8000).catch(error => ({
          status: { loaded: true, probe_ok: false, probe_error: String(error?.message || error) },
          capabilities: {}
        }));
        if (inspection.status?.probe_ok === false) this.recoverHungPage(this.visual, inspection.status.probe_error);
        visualStatus = observedStatus(inspection.status || { loaded: true, signedIn: false }, this.lastStatus, 'visual');
        if (force || this.visual.visible || !Object.keys(visualCapabilities).length) {
          visualCapabilities = Object.keys(inspection.capabilities || {}).length
            ? inspection.capabilities
            : visualCapabilities;
        }
      } else if (!allowLoad) {
        visualStatus = {
          loaded: false,
          signedIn: this.lastStatus.connected === true,
          challenged: this.lastStatus.challenged === true,
          promptFound: this.lastStatus.flow_ready === true,
          url: this.lastStatus.visual_url || ''
        };
      }

      if (this.music.view) {
        const inspection = await this.music.inspect(force ? 15000 : 8000).catch(error => ({
          status: { loaded: true, probe_ok: false, probe_error: String(error?.message || error) },
          capabilities: {}
        }));
        if (inspection.status?.probe_ok === false) this.recoverHungPage(this.music, inspection.status.probe_error);
        musicStatus = observedStatus(inspection.status || { loaded: true, signedIn: false }, this.lastStatus, 'music');
        if (force || this.music.visible || !Object.keys(musicCapabilities).length) {
          musicCapabilities = Object.keys(inspection.capabilities || {}).length
            ? inspection.capabilities
            : musicCapabilities;
        }
      } else {
        musicStatus = {
          loaded: false,
          signedIn: this.lastStatus.music_signed_in === true,
          challenged: false,
          promptFound: this.lastStatus.music_ready === true,
          url: this.lastStatus.music_url || ''
        };
      }

      const visualChallenged = visualStatus.challenged === true;
      const musicChallenged = musicStatus.challenged === true;
      const connected = visualStatus.signedIn === true && !visualChallenged;
      const musicConnected = musicStatus.signedIn === true && !musicChallenged;
      const challenged = visualChallenged || musicChallenged;

      this.setConsumerState('visual', connected);
      this.setConsumerState('music', musicConnected);

      this.lastRefreshAt = Date.now();
      this.lastStatus = {
        profile_id: this.profileId,
        connected,
        signed_in: connected,
        needs_user_auth: !connected || visualChallenged,
        challenged,
        flow_ready: visualStatus.promptFound === true,
        music_signed_in: musicConnected,
        music_needs_user_auth: !musicConnected,
        music_ready: musicConnected && musicStatus.promptFound === true,
        capabilities: { visual: visualCapabilities, music: musicCapabilities },
        current_url: visualStatus.url || musicStatus.url || '',
        visual_url: visualStatus.url || this.lastStatus.visual_url || '',
        music_url: musicStatus.url || this.lastStatus.music_url || '',
        visual_probe_ok: visualStatus.probe_ok === true,
        visual_probe_error: visualStatus.probe_error || '',
        visual_detected_signed_in: visualStatus.unknown ? null : visualStatus.signedIn === true,
        music_probe_ok: musicStatus.probe_ok === true,
        music_probe_error: musicStatus.probe_error || '',
        music_detected_signed_in: musicStatus.unknown ? null : musicStatus.signedIn === true,
        detail: connected ? 'Google Media account connected' : 'Google sign-in required'
      };
      if (visualStatus.loaded || musicStatus.loaded) {
        // Persist the live observation so a stale challenged/signed-out flag
        // from an earlier day cannot outlive the real session state.
        callCore('media.connection-update', { profile_id: this.profileId, patch: {
          connected, needs_user_auth: !connected || visualChallenged, challenged,
          flow_ready: this.lastStatus.flow_ready, music_signed_in: musicConnected, music_ready: this.lastStatus.music_ready,
          capabilities: this.lastStatus.capabilities, detail: this.lastStatus.detail
        } }).catch(() => {});
      }
      return this.snapshot();
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  // requireConnected: start taking jobs only once this account is verified
  // signed in (used when several accounts are woken; a signed-out one would
  // otherwise claim jobs only to park them in needs_user_auth).
  wake(surface = 'visual', { requireConnected = false } = {}) {
    this.touch();
    this.wakingCount++;
    const target = surface === 'music' ? this.music : this.visual;
    target.ensureView();
    void target.ensureLoaded().then(async () => {
      await this.refreshConnection({ force: true, allowLoad: false }).catch(() => {});
      const connected = surface === 'music' ? this.lastStatus.music_signed_in : this.lastStatus.connected && !this.lastStatus.challenged;
      if (!requireConnected || connected) this.setConsumerState(surface === 'music' ? 'music' : 'visual', true);
    }).catch(() => {}).finally(() => {
      this.wakingCount = Math.max(0, this.wakingCount - 1);
      if (!this.visual.visible && !this.music.visible) this.scheduleUnload(BROWSER_IDLE_MS);
    });
    const snapshot = { ...this.snapshot(), waking: true, wake_surface: surface };
    if (!this.lastRefreshAt) {
      // Nothing has been checked yet in this process: unknown, not signed out.
      snapshot.needs_user_auth = null;
      snapshot.status_checked = false;
    }
    return snapshot;
  }

  async open() {
    this.cancelUnload();
    this.unpark();
    this.music.setVisible(false);
    this.visual.ensureView();
    this.visual.setVisible(false);
    void this.visual.ensureLoaded().then(async () => {
      this.visual.setVisible(true);
      const status = await this.refreshConnection({ force: true, allowLoad: false }).catch(() => null);
      if (status?.connected) await callCore('media.resume-auth', {}).catch(() => {});
    }).catch(() => {
      this.visual.setVisible(false);
    });
    return { ...this.snapshot(), opening: true };
  }

  async login() {
    this.cancelUnload();
    this.unpark();
    this.music.setVisible(false);
    const view = this.visual.ensureView();
    this.visual.setVisible(false);
    view.webContents.loadURL(GOOGLE_LOGIN_URL).catch(() => {});
    void (async () => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && view.webContents.isLoading()) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      this.visual.setVisible(true);
      this.watchSignIn();
    })();
    return {
      profile_id: this.profileId,
      connected: false,
      needs_user_auth: true,
      login_open: true,
      visible: true,
      detail: 'Google sign-in is opening in TEAMYRA'
    };
  }

  // After Connect/login, re-probe until the account is signed in (an account
  // that already is gets redirected to Flow at once), then resume blocked jobs.
  watchSignIn(timeoutMs = 5 * 60 * 1000) {
    if (this.signInWatch) return;
    const deadline = Date.now() + timeoutMs;
    this.signInWatch = (async () => {
      try {
        while (Date.now() < deadline && this.visual.view) {
          await new Promise(resolve => setTimeout(resolve, 4000));
          const status = await this.refreshConnection({ force: true, allowLoad: false }).catch(() => null);
          if (status?.connected) {
            await callCore('media.resume-auth', {}).catch(() => {});
            return;
          }
        }
      } finally {
        this.signInWatch = null;
      }
    })();
  }

  async showMusic() {
    this.cancelUnload();
    this.visual.setVisible(false);
    this.music.ensureView();
    this.music.setVisible(false);
    void this.music.ensureLoaded().then(async () => {
      this.music.setVisible(true);
      const musicStatus = await this.music.status().catch(() => ({
        signedIn: false,
        url: this.music.view?.webContents?.getURL?.() || ''
      }));
      let authorization = null;
      if (musicStatus.signedIn !== true) {
        authorization = await this.music.adapter?.beginGoogleAuthorization().catch(() => ({
          authorized: false, started: false, needs_user_action: true
        }));
      }
      // Re-probe both surfaces; the refresh persists the live state (it used to
      // push the visual status remembered from before, however old it was).
      await this.refreshConnection({ force: true, allowLoad: false }).catch(() => null);
      void authorization;
    }).catch(() => {
      this.music.setVisible(false);
    });
    return {
      ...this.snapshot(),
      music_opening: true,
      music_authorization: null
    };
  }

  close() {
    this.visual.close();
    this.music.close();
    this.scheduleUnload();
  }

  setVisible(value) {
    this.visual.setVisible(value === true);
    this.music.setVisible(false);
  }

  setBounds(bounds) {
    this.visual.setBounds(bounds);
    this.music.setBounds(bounds);
  }

  // A page script that timed out means the Flow renderer is hung; a reload
  // alone cannot reach it, so end the renderer and load the page again.
  recoverHungPage(provider, error) {
    if (!/timed out/i.test(String(error || ''))) return;
    const contents = provider.view?.webContents;
    if (!contents || contents.isDestroyed()) return;
    if (Date.now() - (provider.hungRecoveredAt || 0) < HUNG_RELOAD_GAP_MS) return;
    provider.hungRecoveredAt = Date.now();
    console.warn('[google-media] page did not answer a status probe; restarting its renderer');
    try { contents.forcefullyCrashRenderer(); } catch {}
    try { contents.reload(); } catch {}
  }

  async reconnect() {
    await this.visual.ensureLoaded();
    this.visual.view.webContents.reload();
    if (this.music.view) this.music.view.webContents.reload();
    this.lastRefreshAt = 0;
    return this.refreshConnection({ force: true, allowLoad: true });
  }

  destroy() {
    this.cancelUnload();
    this.stopConsumers();
    this.visual.destroy();
    for (const lane of this.extraLanes) lane.provider.destroy();
    this.music.destroy();
    this.started = false;
  }
}

class GoogleMediaEngine {
  constructor({ window, listProfiles = mediaProfiles }) {
    this.window = window;
    this.listProfiles = () => { try { return listProfiles(); } catch { return [{ id: 'google', enabled: true, priority: 250 }]; } };
    this.profiles = new Map();
    this.activeProfileId = 'google';
    this.started = false;
    this.recoveryDone = () => {};
    // Workers claim nothing until the previous process's jobs are recovered.
    this.ready = new Promise(resolve => { this.recoveryDone = resolve; });
  }

  ensureProfile(profileId = 'google') {
    const id = safeProfileId(profileId);
    let runtime = this.profiles.get(id);
    if (!runtime) {
      runtime = new GoogleMediaProfileRuntime({ window: this.window, profileId: id, ready: this.ready, engine: this });
      runtime.initialize();
      this.profiles.set(id, runtime);
    }
    return runtime;
  }

  // Enabled Google Media accounts, by priority (the built-in one first on ties).
  enabledProfiles() {
    return this.listProfiles().filter(item => item.enabled)
      .sort((a, b) => (b.priority - a.priority) || (a.id === 'google' ? -1 : b.id === 'google' ? 1 : a.id.localeCompare(b.id)))
      .map(item => item.id);
  }

  // The account that takes single jobs (they stay in the folder's main Flow
  // project): the active account while it works, else the first working one.
  mainProfileId() {
    const active = this.profiles.get(this.activeProfileId);
    if (active?.working()) return this.activeProfileId;
    return this.enabledProfiles().find(id => this.profiles.get(id)?.working()) || this.activeProfileId;
  }

  otherWorking(profileId) {
    return [...this.profiles.values()].some(runtime => runtime.profileId !== profileId && runtime.working());
  }

  initialize() {
    if (this.started) return;
    this.started = true;
    const ids = this.enabledProfiles();
    if (!ids.includes('google')) ids.unshift('google');
    for (const id of ids) this.ensureProfile(id);
    // Jobs the previous desktop process left mid-flight are requeued (or marked
    // for reconciliation if Generate may have run) before any worker claims.
    // A submitted job keeps its account and tab, and only they resume it.
    callCore('media.recover-incomplete', {}, { timeout: 30000 }).catch(() => null)
      .finally(() => this.recoveryDone())
      .then(() => callCore('media.connection-status', {})).then(saved => {
      if (!saved || saved.provider !== 'google-media') return;
      for (const id of ids) this.restoreProfile(this.profiles.get(id), saved);
    }).catch(() => {});
  }

  // Every account resumes from its last saved state; one never checked, signed
  // out, challenged or stale is probed again.
  restoreProfile(runtime, saved) {
    if (!runtime) return;
    const own = saved.profiles?.[runtime.profileId];
    if (!own && runtime.profileId !== 'google') {
      runtime.refreshConnection({ force: true, allowLoad: true }).catch(() => {});
      return;
    }
    // The built-in account's state was kept at the top level before accounts
    // had their own records.
    saved = own ? { ...own, capabilities: saved.capabilities } : saved;
    runtime.lastStatus = {
      ...runtime.lastStatus,
      connected: saved.connected === true,
      signed_in: saved.connected === true,
      needs_user_auth: saved.connected !== true,
      challenged: saved.challenged === true,
      flow_ready: saved.flow_ready === true,
      music_signed_in: saved.music_signed_in === true,
      music_needs_user_auth: saved.music_signed_in !== true,
      music_ready: saved.music_ready === true,
      capabilities: saved.capabilities || runtime.lastStatus.capabilities,
      detail: saved.detail || runtime.lastStatus.detail
    };
    runtime.lastRefreshAt = Date.now();
    runtime.setConsumerState('visual', runtime.lastStatus.connected);
    runtime.setConsumerState('music', runtime.lastStatus.music_signed_in);
    const savedAt = Number(saved.updated_at || 0) * 1000;
    if (saved.challenged === true || saved.connected !== true || Date.now() - savedAt > STALE_STATUS_MS) {
      runtime.lastRefreshAt = 0;
      runtime.refreshConnection({ force: true, allowLoad: true }).catch(() => {});
    }
  }

  async refreshProfile(profileId = 'google', options = {}) {
    const runtime = this.ensureProfile(profileId);
    const status = await runtime.refreshConnection(options);
    if (status.connected && options.force) await callCore('media.resume-auth', {}).catch(() => {});
    return status;
  }

  async profileStatus(profileId = 'google', force = false) {
    const runtime = this.ensureProfile(profileId);
    if (!force) return runtime.snapshot();
    return this.refreshProfile(profileId, { force: true, allowLoad: runtime.visual.visible || runtime.music.visible });
  }

  aggregateSnapshot() {
    const statuses = [...this.profiles.values()].map(runtime => runtime.snapshot());
    const active = statuses.find(item => item.profile_id === this.activeProfileId) || statuses[0] || {};
    const connectedProfiles = statuses.filter(item => item.connected);
    return {
      provider: 'google-media',
      connected: connectedProfiles.length > 0,
      needs_user_auth: connectedProfiles.length === 0,
      challenged: statuses.some(item => item.challenged),
      flow_ready: statuses.some(item => item.flow_ready),
      music_ready: statuses.some(item => item.music_ready),
      music_signed_in: statuses.some(item => item.music_signed_in),
      capabilities: active.capabilities || {},
      detail: connectedProfiles.length
        ? connectedProfiles.length + ' Google Media account' + (connectedProfiles.length === 1 ? '' : 's') + ' connected'
        : 'Connect a Google account to use Google Media',
      updated_at: Date.now() / 1000,
      visible: statuses.some(item => item.visible),
      busy: statuses.some(item => item.busy),
      active_profile_id: this.activeProfileId,
      profiles: statuses
    };
  }

  async status(profileId = null, force = false) {
    if (profileId) return this.profileStatus(profileId, force);
    const aggregate = this.aggregateSnapshot();
    callCore('media.connection-update', { patch: aggregate }).catch(() => {});
    return aggregate;
  }

  wake(surface = 'visual', profileId = 'google') {
    const id = safeProfileId(profileId || 'google');
    this.activeProfileId = id;
    return this.ensureProfile(id).wake(surface === 'music' ? 'music' : 'visual');
  }

  // Bulk Flow work runs in every enabled Google account at once, each with its
  // own tabs and Flow projects; all claim from one queue. Flow Music stays on
  // the active account. An account not verified signed in starts taking jobs
  // only once a probe confirms it, unless no account is known to work (then
  // the active one starts as before, so jobs report that sign-in is needed).
  wakeAll(surface = 'visual') {
    if (surface === 'music') return this.wake('music', this.activeProfileId);
    const ids = this.enabledProfiles();
    const anyWorking = ids.some(id => this.profiles.get(id)?.lastStatus.connected === true);
    const accounts = ids.map(id => {
      const fallback = !anyWorking && id === this.activeProfileId;
      const snapshot = this.ensureProfile(id).wake('visual', { requireConnected: !fallback });
      return { profile_id: id, connected: snapshot.connected === true, challenged: snapshot.challenged === true,
        needs_user_auth: snapshot.needs_user_auth, status_checked: snapshot.status_checked !== false };
    });
    return {
      provider: 'google-media', waking: true, wake_surface: 'visual',
      accounts, tabs_per_account: flowLaneCount(),
      connected: accounts.some(item => item.connected),
      needs_user_auth: accounts.every(item => item.needs_user_auth === true)
    };
  }

  async open(profileId = 'google') {
    this.activeProfileId = safeProfileId(profileId);
    for (const [id, runtime] of this.profiles) {
      if (id !== this.activeProfileId) runtime.setVisible(false);
    }
    return this.ensureProfile(this.activeProfileId).open();
  }

  async login(profileId = 'google') {
    this.activeProfileId = safeProfileId(profileId);
    for (const [id, runtime] of this.profiles) {
      if (id !== this.activeProfileId) runtime.setVisible(false);
    }
    return this.ensureProfile(this.activeProfileId).login();
  }

  close() {
    for (const runtime of this.profiles.values()) runtime.close();
    return { ok: true, visible: false, active_profile_id: this.activeProfileId };
  }

  async reconnect(profileId = null) {
    return this.ensureProfile(profileId || this.activeProfileId).reconnect();
  }

  setVisible(value) {
    for (const [id, runtime] of this.profiles) {
      runtime.setVisible(value === true && id === this.activeProfileId);
    }
    return this.aggregateSnapshot();
  }

  setBounds(bounds) {
    for (const runtime of this.profiles.values()) runtime.setBounds(bounds);
    return bounds;
  }

  async showMusic(profileId = null) {
    const id = safeProfileId(profileId || this.activeProfileId);
    this.activeProfileId = id;
    for (const [otherId, runtime] of this.profiles) {
      if (otherId !== id) runtime.setVisible(false);
    }
    return this.ensureProfile(id).showMusic();
  }

  destroy() {
    for (const runtime of this.profiles.values()) runtime.destroy();
    this.profiles.clear();
    this.started = false;
  }
}

module.exports = { GoogleMediaEngine, GoogleMediaProfileRuntime, GOOGLE_LOGIN_URL, observedStatus, flowLaneCount, mediaProfiles };
