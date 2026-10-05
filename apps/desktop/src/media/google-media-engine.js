const { callCore } = require('../core-api');
const { GoogleMediaSessionManager, safeProfileId } = require('./google-media-session-manager');
const { MediaDownloadManager } = require('./media-download-manager');
const { GoogleFlowProvider } = require('./google-flow-provider');
const { GoogleFlowMusicProvider } = require('./google-flow-music-provider');
const { MediaJobConsumer } = require('./media-job-consumer');

const GOOGLE_LOGIN_URL = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fflow.google.com%2F';
const STATUS_CACHE_MS = 15000;

class GoogleMediaProfileRuntime {
  constructor({ window, profileId }) {
    this.window = window;
    this.profileId = safeProfileId(profileId);
    this.sessionManager = new GoogleMediaSessionManager(this.profileId);
    this.downloadManager = new MediaDownloadManager(this.sessionManager);
    this.visual = new GoogleFlowProvider({ window, sessionManager: this.sessionManager });
    this.music = new GoogleFlowMusicProvider({ window, sessionManager: this.sessionManager });
    this.visualConsumer = new MediaJobConsumer({
      surface: 'visual',
      workerName: 'google-media-' + this.profileId + '-visual',
      provider: this.visual,
      downloadManager: this.downloadManager,
      profileId: this.profileId
    });
    this.musicConsumer = new MediaJobConsumer({
      surface: 'music',
      workerName: 'google-media-' + this.profileId + '-music',
      provider: this.music,
      downloadManager: this.downloadManager,
      profileId: this.profileId
    });
    this.started = false;
    this.visualConsumerStarted = false;
    this.musicConsumerStarted = false;
    this.unloadTimer = null;
    this.refreshPromise = null;
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

  setConsumerState(kind, enabled) {
    if (kind === 'visual') {
      if (enabled && !this.visualConsumerStarted) {
        this.visualConsumer.start();
        this.visualConsumerStarted = true;
      } else if (!enabled && this.visualConsumerStarted) {
        this.visualConsumer.stop();
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

  scheduleUnload(delayMs = 3000) {
    this.cancelUnload();
    this.unloadTimer = setTimeout(() => {
      this.unloadTimer = null;
      if (this.visualConsumer.busy || this.musicConsumer.busy) {
        this.scheduleUnload(3000);
        return;
      }
      if (this.visual.visible || this.music.visible) return;
      this.visual.destroy();
      this.music.destroy();
    }, Math.max(1000, Number(delayMs) || 3000));
    this.unloadTimer.unref?.();
  }

  snapshot() {
    return {
      ...this.lastStatus,
      visible: this.visual.visible || this.music.visible,
      busy: this.visualConsumer.busy || this.musicConsumer.busy,
      visual_busy: this.visualConsumer.busy,
      music_busy: this.musicConsumer.busy,
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
        const inspection = await this.visual.inspect(force ? 15000 : 8000).catch(() => ({
          status: { loaded: true, signedIn: false },
          capabilities: {}
        }));
        visualStatus = inspection.status || { loaded: true, signedIn: false };
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
        const inspection = await this.music.inspect(force ? 15000 : 8000).catch(() => ({
          status: { loaded: true, signedIn: false },
          capabilities: {}
        }));
        musicStatus = inspection.status || { loaded: true, signedIn: false };
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
        visual_detected_signed_in: visualStatus.signedIn === true,
        music_probe_ok: musicStatus.probe_ok === true,
        music_probe_error: musicStatus.probe_error || '',
        music_detected_signed_in: musicStatus.signedIn === true,
        detail: connected ? 'Google Media account connected' : 'Google sign-in required'
      };
      return this.snapshot();
    })();

    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  wake(surface = 'visual') {
    this.cancelUnload();
    const target = surface === 'music' ? this.music : this.visual;
    target.ensureView();
    void target.ensureLoaded().then(async () => {
      await this.refreshConnection({ force: true, allowLoad: false }).catch(() => {});
      this.setConsumerState(surface === 'music' ? 'music' : 'visual', true);
      if (!this.visual.visible && !this.music.visible) this.scheduleUnload(30000);
    }).catch(() => {
      if (!this.visual.visible && !this.music.visible) this.scheduleUnload(10000);
    });
    return { ...this.snapshot(), waking: true, wake_surface: surface };
  }

  async open() {
    this.cancelUnload();
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
      const currentUrl = this.music.view?.webContents?.getURL?.() || musicStatus.url || '';
      const signedInNow = (await this.music.status().catch(() => musicStatus)).signedIn === true;
      this.lastStatus = {
        ...this.lastStatus,
        music_signed_in: signedInNow,
        music_needs_user_auth: !signedInNow,
        music_url: currentUrl
      };
      this.lastRefreshAt = Date.now();
      callCore('media.connection-update', { patch: {
        connected: this.lastStatus.connected === true,
        needs_user_auth: this.lastStatus.connected !== true,
        challenged: this.lastStatus.challenged === true,
        flow_ready: this.lastStatus.flow_ready === true,
        music_signed_in: signedInNow,
        music_ready: this.lastStatus.music_ready === true,
        capabilities: this.lastStatus.capabilities || {},
        detail: this.lastStatus.connected ? 'Google Media account connected' : 'Google sign-in required'
      }}).catch(() => {});
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
    this.music.destroy();
    this.started = false;
  }
}

class GoogleMediaEngine {
  constructor({ window }) {
    this.window = window;
    this.profiles = new Map();
    this.activeProfileId = 'google';
    this.started = false;
  }

  ensureProfile(profileId = 'google') {
    const id = safeProfileId(profileId);
    let runtime = this.profiles.get(id);
    if (!runtime) {
      runtime = new GoogleMediaProfileRuntime({ window: this.window, profileId: id });
      runtime.initialize();
      this.profiles.set(id, runtime);
    }
    return runtime;
  }

  initialize() {
    if (this.started) return;
    this.started = true;
    const runtime = this.ensureProfile('google');
    callCore('media.connection-status', {}).then(saved => {
      if (!saved || saved.provider !== 'google-media') return;
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
    }).catch(() => {});
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

module.exports = { GoogleMediaEngine, GoogleMediaProfileRuntime, GOOGLE_LOGIN_URL };
