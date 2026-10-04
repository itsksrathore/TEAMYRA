const { callCore } = require('../core-api');
const { GoogleMediaSessionManager, safeProfileId } = require('./google-media-session-manager');
const { MediaDownloadManager } = require('./media-download-manager');
const { GoogleFlowProvider } = require('./google-flow-provider');
const { GoogleFlowMusicProvider } = require('./google-flow-music-provider');
const { MediaJobConsumer } = require('./media-job-consumer');

const GOOGLE_LOGIN_URL = 'https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fflow.google.com%2F';

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

  async refreshConnection() {
    this.initialize();
    let visualStatus = { loaded: false, signedIn: false };
    let musicStatus = { loaded: false };
    let visualCapabilities = {};
    let musicCapabilities = {};

    // Connection is verified against the real Flow surface, never inferred from
    // cookies alone. Google sets pre-auth cookies on login pages too.
    if (!this.visual.view) {
      await this.visual.ensureLoaded().catch(() => {});
    }
    if (this.visual.view) {
      visualStatus = await this.visual.status().catch(() => ({ loaded: true, signedIn: false }));
      visualCapabilities = await this.visual.adapter?.capabilities().catch(() => ({})) || {};
    }
    if (this.music.view) {
      musicStatus = await this.music.status().catch(() => ({ loaded: true }));
      musicCapabilities = await this.music.adapter?.capabilities().catch(() => ({})) || {};
    }
    const visualChallenged = visualStatus.challenged === true;
    const musicChallenged = musicStatus.challenged === true;
    const connected = visualStatus.signedIn === true && !visualChallenged;
    const musicConnected = musicStatus.signedIn === true && !musicChallenged;
    const challenged = visualChallenged || musicChallenged;
    const needsAuth = !connected || visualChallenged;
    this.setConsumerState('visual', connected);
    this.setConsumerState('music', musicConnected);
    return {
      profile_id: this.profileId,
      connected,
      signed_in: connected,
      needs_user_auth: needsAuth,
      challenged,
      flow_ready: visualStatus.promptFound === true,
      music_signed_in: musicConnected,
      music_needs_user_auth: !musicConnected,
      music_ready: musicConnected && musicStatus.promptFound === true,
      capabilities: { visual: visualCapabilities, music: musicCapabilities },
      visible: this.visual.visible || this.music.visible,
      busy: this.visualConsumer.busy || this.musicConsumer.busy,
      visual_busy: this.visualConsumer.busy,
      music_busy: this.musicConsumer.busy,
      current_url: visualStatus.url || musicStatus.url || '',
      detail: connected ? 'Google Media account connected' : 'Google sign-in required'
    };
  }

  async open() {
    this.music.setVisible(false);
    await this.visual.open();
    return this.refreshConnection();
  }

  async login() {
    this.music.setVisible(false);
    const view = this.visual.ensureView();
    this.visual.setVisible(true);
    view.webContents.loadURL(GOOGLE_LOGIN_URL).catch(() => {});
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
    this.visual.setVisible(false);
    await this.music.open();
    const musicStatus = await this.music.status().catch(() => ({ signedIn: false }));
    let authorization = null;
    if (musicStatus.signedIn !== true) {
      authorization = await this.music.adapter?.beginGoogleAuthorization().catch(() => ({
        authorized: false, started: false, needs_user_action: true
      }));
    }
    const status = await this.refreshConnection();
    return { ...status, music_authorization: authorization };
  }

  close() {
    this.visual.close();
    this.music.close();
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
    return this.refreshConnection();
  }

  destroy() {
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
    this.ensureProfile('google');
    this.refreshProfile('google').catch(() => {});
  }

  async refreshProfile(profileId = 'google') {
    const runtime = this.ensureProfile(profileId);
    const status = await runtime.refreshConnection();
    if (status.connected) await callCore('media.resume-auth', {}).catch(() => {});
    return status;
  }

  async profileStatus(profileId = 'google') {
    return this.refreshProfile(profileId);
  }

  async status(profileId = null) {
    if (profileId) return this.refreshProfile(profileId);
    const statuses = [];
    for (const id of this.profiles.keys()) {
      statuses.push(await this.refreshProfile(id).catch(() => ({ profile_id: id, connected: false })));
    }
    const active = statuses.find(item => item.profile_id === this.activeProfileId) || statuses[0] || {};
    const connectedProfiles = statuses.filter(item => item.connected);
    const aggregate = {
      provider: 'google-media',
      connected: connectedProfiles.length > 0,
      needs_user_auth: connectedProfiles.length === 0,
      challenged: statuses.some(item => item.challenged),
      flow_ready: statuses.some(item => item.flow_ready),
      music_ready: statuses.some(item => item.music_ready),
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
    await callCore('media.connection-update', { patch: aggregate }).catch(() => {});
    return aggregate;
  }

  async open(profileId = 'google') {
    this.activeProfileId = safeProfileId(profileId);
    for (const [id, runtime] of this.profiles) {
      if (id !== this.activeProfileId) runtime.setVisible(false);
    }
    const runtime = this.ensureProfile(this.activeProfileId);
    await runtime.open();
    return this.status();
  }

  async login(profileId = 'google') {
    this.activeProfileId = safeProfileId(profileId);
    for (const [id, runtime] of this.profiles) {
      if (id !== this.activeProfileId) runtime.setVisible(false);
    }
    const runtime = this.ensureProfile(this.activeProfileId);
    return runtime.login();
  }

  close() {
    for (const runtime of this.profiles.values()) runtime.close();
    return { ok: true, visible: false, active_profile_id: this.activeProfileId };
  }

  async reconnect(profileId = null) {
    return this.ensureProfile(profileId || this.activeProfileId).reconnect();
  }

  setVisible(value) {
    for (const [id, runtime] of this.profiles) runtime.setVisible(value === true && id === this.activeProfileId);
    return this.status();
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
    const musicResult = await this.ensureProfile(id).showMusic();
    const aggregate = await this.status();
    return { ...aggregate, music_authorization: musicResult?.music_authorization || null };
  }

  destroy() {
    for (const runtime of this.profiles.values()) runtime.destroy();
    this.profiles.clear();
    this.started = false;
  }
}

module.exports = { GoogleMediaEngine, GoogleMediaProfileRuntime, GOOGLE_LOGIN_URL };
