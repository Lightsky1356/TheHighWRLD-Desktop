'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let Client = null;
try {
  const mod = require('@xhayper/discord-rpc');
  Client = mod.Client || mod.default || (typeof mod === 'function' ? mod : null);
  if (Client) console.log('[DRP] Loaded @xhayper/discord-rpc, Client:', typeof Client);
} catch (e) {
  console.error('[DRP] @xhayper/discord-rpc failed:', e.message);
}
if (!Client) {
  try {
    const mod = require('discord-rpc');
    Client = mod.Client || (mod.default && mod.default.Client) || (typeof mod === 'function' ? mod : null);
    if (Client) console.log('[DRP] Fallback to discord-rpc, Client:', typeof Client);
  } catch (e2) {
    console.error('[DRP] discord-rpc fallback failed:', e2.message);
  }
}

const CLIENT_ID = process.env.THEHIGHWRLD_DISCORD_CLIENT_ID || '1533294159039827988';
const POLL_MS = 1000;
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
const RECONNECT_BACKOFF_MULTIPLIER = 2;

function readSettings() {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')); } catch (e) { return {}; }
}
function writeSettings(patch) {
  try {
    const next = Object.assign(readSettings(), patch);
    fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify(next, null, 2), 'utf8');
    return next;
  } catch (e) { return patch; }
}

let client = null;
let enabled = false;
let loggedIn = false;
let available = false;
let winRef = null;
let pollTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let destroying = false;
let lastKey = '';

let prevTrack = '';
let prevArtist = '';
let prevAlbumTag = '';
let prevDuration = 0;
let prevPlaying = false;
let lastSentState = '';
let lastSentAt = 0;
const SEEK_REFRESH_MS = 1000;

const COVER_BASE = 'https://raw.githubusercontent.com/Lightsky1356/TheHighWRLD/main/Covers/';

function getCoverUrl(trackTitle) {
  if (!trackTitle) return '';
  let name = String(trackTitle)
    .replace(/\s*\(.*?\)\s*/g, ' ')
    .replace(/[^\w\s\-.,']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) return '';
  return COVER_BASE + encodeURIComponent(name) + '.png';
}

function getActivity(trackTitle, playing, artist, albumTag, currentTime, duration) {
  if (!trackTitle) return null;

  let state = '';
  if (artist) state = 'By ' + artist;

  const activity = {
    name: 'TheHighWRLD Dashboard',
    type: 2,
    details: trackTitle || 'TheHighWRLD Dashboard',
    state: state || 'By Unknown',
    largeImageKey: getCoverUrl(trackTitle || ''),
    largeImageText: albumTag || '',
    instance: false,
  };

  if (duration > 0 && isFinite(duration) && currentTime >= 0 && isFinite(currentTime)) {
    // Real track length known: send a correct start/end so Discord shows the true
    // seek position instead of a fake fixed bar.
    const now = Date.now();
    activity.startTimestamp = Math.floor(now - (currentTime * 1000));
    activity.endTimestamp = Math.floor(activity.startTimestamp + (duration * 1000));
  } else {
    // Duration not loaded yet (audio preload="none"/metadata pending). Do NOT send a
    // hardcoded end timestamp (that caused the fake "1:00" seek bar on every song).
    // Send only a start timestamp so Discord shows elapsed time without a wrong bar.
    activity.startTimestamp = Math.floor(Date.now() - Math.max(0, currentTime || 0) * 1000);
  }

  return { key: trackTitle, activity };
}

async function observeState(win) {
  if (!win || win.isDestroyed()) return null;
  try {
    return await win.webContents.executeJavaScript(`(() => {
      // Prefer the site's LIVE player state. The WRLD player uses a JS-created
      // \`new Audio()\` object + top-level vars (trackList, currentTrackIndex,
      // isPlaying), NOT the static <audio> element. Reading those globals is the
      // only reliable source of truth for the currently-playing track and its
      // real duration/seek position.
      const live = (() => {
        try {
          const idx = typeof currentTrackIndex === 'number' ? currentTrackIndex : -1;
          const list = (typeof trackList !== 'undefined' && trackList) ? trackList : [];
          const t = (idx >= 0 && list[idx]) ? list[idx] : null;
          if (!t || !t.title) return null;
          let duration = 0, currentTime = 0, paused = true, playing = false;
          const aobj = (typeof audio !== 'undefined' && audio) ? audio : null;
          if (aobj) {
            duration = (aobj.duration && isFinite(aobj.duration) && aobj.duration > 0) ? aobj.duration : 0;
            currentTime = aobj.currentTime || 0;
            paused = aobj.paused;
            playing = !paused;
          }
          if (typeof isPlaying === 'boolean') playing = isPlaying;
          let albumTag = '';
          if (t.tag) albumTag = String(t.tag).trim();
          else if (t.album) albumTag = String(t.album).trim();
          else if (typeof getTrackAlbum === 'function' && getTrackAlbum(t)) albumTag = String(getTrackAlbum(t)).trim();
          return {
            trackTitle: String(t.title).trim() || '',
            artist: (t.artist ? String(t.artist) : '').trim(),
            albumTag: albumTag,
            currentTime: currentTime,
            duration: duration,
            paused: paused,
            playing: !!playing,
          };
        } catch (_) { return null; }
      })();
      if (live) return live;

      // Fallback: read from the DOM (main-player #track-title etc).
      let trackTitle = '', artist = '', albumTag = '', currentTime = 0, duration = 0, paused = true;
      const t = document.getElementById('track-title');
      if (t) trackTitle = (t.textContent || '').trim();
      const a = document.getElementById('track-artist');
      if (a) artist = (a.textContent || '').trim();
      const tag = document.getElementById('track-tag');
      if (tag) albumTag = (tag.textContent || '').trim();
      const ae = document.getElementById('audio-preview') || document.querySelector('audio');
      if (ae) {
        duration = ae.duration && isFinite(ae.duration) && ae.duration > 0 ? ae.duration : 0;
        currentTime = ae.currentTime || 0;
        paused = ae.paused;
      }
      if (!trackTitle) return null;
      return { trackTitle, artist, albumTag, currentTime, duration, paused, playing: !paused };
    })()`, true).catch((e) => { console.error('[DRP] observeState JS error:', e.message); return null; });
  } catch (e) { console.error('[DRP] observeState error:', e.message); return null; }
}

async function setActivity(activity) {
  if (!client) { console.log('[DRP] setActivity: no client'); return; }
  try {
    let result = false;
    if (client.user && typeof client.user.setActivity === 'function') {
      try { result = await client.user.setActivity(activity); } catch (e) { console.log('[DRP] client.user.setActivity error:', e.message); }
      if (result) { console.log('[DRP] Activity set via client.user.setActivity:', activity.details, '|', activity.state); }
    }
    if (!result && typeof client.setActivity === 'function') {
      try { result = await client.setActivity(activity); } catch (e) { console.log('[DRP] client.setActivity error:', e.message); }
      if (result) { console.log('[DRP] Activity set via client.setActivity:', activity.details, '|', activity.state); }
    }
    if (!result) {
      console.log('[DRP] setActivity completed (result may be false due to Discord state)');
    }
  } catch (e) {
    console.error('[DRP] setActivity error:', e.message || e);
  }
}

async function clearActivity() {
  if (!client) return;
  try {
    if (client.user && typeof client.user.clearActivity === 'function') {
      await client.user.clearActivity();
    } else if (typeof client.clearActivity === 'function') {
      await client.clearActivity();
    }
    console.log('[DRP] Activity cleared');
  } catch (e) {
    console.error('[DRP] clearActivity error:', e.message || e);
  }
}

function destroyClient() {
  if (destroying) return;
  destroying = true;
  console.log('[DRP] destroyClient: destroying old client');
  if (client) {
    try { client.removeAllListeners(); } catch (_) {}
    try { client.destroy(); } catch (_) { console.log('[DRP] destroyClient: destroy() error'); }
    client = null;
  }
  loggedIn = false;
  available = false;
  destroying = false;
}

function stopReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  reconnectAttempts = 0;
  console.log('[DRP] stopReconnect: cleared reconnect timer');
}

function scheduleReconnect() {
  if (!enabled) {
    console.log('[DRP] scheduleReconnect: DRP disabled, not reconnecting');
    stopReconnect();
    return;
  }
  stopReconnect();
  const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(RECONNECT_BACKOFF_MULTIPLIER, reconnectAttempts), RECONNECT_MAX_DELAY);
  reconnectAttempts++;
  console.log('[DRP] scheduleReconnect: reconnecting in', delay, 'ms (attempt', reconnectAttempts, ')');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!enabled) {
      console.log('[DRP] scheduleReconnect: DRP disabled during reconnect delay');
      return;
    }
    console.log('[DRP] scheduleReconnect: reconnect timeout fired, calling reconnect()');
    reconnect();
  }, delay);
}

async function reconnect() {
  console.log('[DRP] reconnect: starting reconnection');
  // IMPORTANT: Always tear down any previous client instance so no stale
  // OAuth/session state or accumulated listeners can carry over between runs.
  destroyClient();

  if (!Client) {
    console.error('[DRP] reconnect: No Client class available');
    scheduleReconnect();
    return;
  }

  try {
    console.log('[DRP] reconnect: creating fresh client with clientId:', CLIENT_ID);
    client = new Client({ clientId: CLIENT_ID, transport: 'ipc' });

    client.on('ready', () => {
      console.log('[DRP] reconnect: ready event fired! User:', client.user ? client.user.username : 'unknown');
      loggedIn = true;
      available = true;
      reconnectAttempts = 0;
      lastSentState = '';
      lastSentAt = 0;
      prevTrack = '';
      prevArtist = '';
      prevAlbumTag = '';
      prevDuration = 0;
      prevPlaying = false;
      restoreActivity();
    });

    client.on('connected', () => {
      console.log('[DRP] reconnect: connected event fired (IPC handshake ok, no OAuth needed)');
    });

    client.on('disconnected', () => {
      console.log('[DRP] reconnect: disconnected event fired from Discord');
      loggedIn = false;
      available = false;
      console.log('[DRP] reconnect: scheduling reconnection after disconnect');
      scheduleReconnect();
    });

    client.on('error', (err) => {
      console.error('[DRP] reconnect: client error:', err && err.message ? err.message : err);
      loggedIn = false;
      available = false;
      scheduleReconnect();
    });

    // Enable debug logging from the library to surface the exact IPC flow/errors.
    try {
      client.on('debug', (msg, extra) => {
        console.log('[DRP][lib]', msg, extra !== undefined ? extra : '');
      });
    } catch (_) {}

    console.log('[DRP] reconnect: fresh client created, calling login() (unauthenticated IPC, no OAuth token)');
    // login() with no scopes connects to the LOCAL running Discord desktop client
    // over the RPC pipe using the configured Application ID, then emits 'ready'.
    // No OAuth access token / authorization session is required for basic RPC.
    await client.login();
    console.log('[DRP] reconnect: login() resolved without throwing');

  } catch (err) {
    console.error('[DRP] reconnect: exact connection error:', err && err.message ? err.message : JSON.stringify(err));
    // The library emits a CUSTOM_RPC_ERROR_CODE (e.g. COULD_NOT_CONNECT /
    // CONNECTION_TIMEOUT) when Discord is not reachable. Log the code too.
    if (err && err.code !== undefined) console.error('[DRP] reconnect: error code:', err.code);
    scheduleReconnect();
  }
}

async function restoreActivity() {
  if (!client || !loggedIn) {
    console.log('[DRP] restoreActivity: skipped, client or loggedIn not ready');
    return;
  }
  try {
    const st = await observeState(winRef);
    if (st && st.trackTitle) {
      const built = getActivity(st.trackTitle, !st.paused, st.artist, st.albumTag, st.currentTime, st.duration);
      if (built) {
        lastSentState = st.trackTitle + '|' + (st.artist || '') + '|' + (st.albumTag || '') + '|' + (!st.paused);
        lastSentAt = Date.now();
        prevTrack = st.trackTitle;
        prevArtist = st.artist || '';
        prevAlbumTag = st.albumTag || '';
        prevDuration = st.duration || 0;
        prevPlaying = !st.paused;
        await setActivity(built.activity);
        console.log('[DRP] restoreActivity: activity restored after reconnect');
      }
    } else {
      await clearActivity();
      console.log('[DRP] restoreActivity: cleared activity (nothing playing)');
    }
  } catch (e) {
    console.error('[DRP] restoreActivity error:', e.message || e);
  }
}

async function sampleAndPush() {
  if (!enabled || !client) {
    return;
  }
  if (!loggedIn) {
    console.log('[DRP] sampleAndPush: not loggedIn, skipping');
    return;
  }

  console.log('[DRP] sampleAndPush ENTER');

  observeState(winRef).then((st) => {
    if (!st) {
      // No track is loaded yet (or #track-title is momentarily empty during a
      // transition). Do NOT fall back to prevTrack here — that froze Discord on
      // the OLD song. Just skip this cycle; the next poll picks up the fresh state.
      console.log('[DRP] observeState null, skipping this poll cycle');
      return;
    }

    const playing = st.playing !== undefined ? st.playing : !st.paused;

    // Dedup key uses TRACK IDENTITY (title/artist/album/playing) — NOT currentTime.
    // Changing songs always produces a new key, so Discord updates immediately.
    const identityKey = st.trackTitle + '|' + (st.artist || '') + '|' + (st.albumTag || '') + '|' + playing;

    // For the SAME track, still refresh periodically so the seek position and any
    // newly-available duration get pushed to Discord (this keeps the seek bar in
    // sync without a fake fixed timestamp).
    const forceRefresh = (lastSentAt === 0) || (Date.now() - lastSentAt >= SEEK_REFRESH_MS);

    if (identityKey === lastSentState && !forceRefresh) {
      console.log('[DRP] Duplicate state, skipping | observed=', st.trackTitle, '| dur=', st.duration, '| cur=', st.currentTime);
      return;
    }

    console.log('[DRP] Pushing activity | observed=', st.trackTitle, '| artist=', st.artist, '| dur=', st.duration, '| cur=', st.currentTime, '| playing=', playing);

    prevTrack = st.trackTitle;
    prevArtist = st.artist || '';
    prevAlbumTag = st.albumTag || '';
    prevDuration = st.duration || 0;
    prevPlaying = playing;

    const built = getActivity(st.trackTitle, playing, st.artist, st.albumTag, st.currentTime, st.duration);
    if (!built) {
      console.log('[DRP] getActivity null');
      return;
    }

    lastSentState = identityKey;
    lastSentAt = Date.now();
    lastKey = built.key;

    console.log('[DRP] Setting activity:', built.activity.details, '|', built.activity.state, '| duration=', st.duration);
    return setActivity(built.activity);
  }).catch((e) => {
    console.error('[DRP] sampleAndPush error:', e.message || e);
  });
}

async function start() {
  enabled = true;
  stopReconnect();
  destroyClient();
  lastSentState = '';
  lastSentAt = 0;
  prevTrack = '';
  prevArtist = '';
  prevAlbumTag = '';
  prevDuration = 0;
  prevPlaying = false;

  if (!Client) {
    console.error('[DRP] start: No Client class available');
    return;
  }

  console.log('[DRP] start: initiating fresh reconnection');
  await reconnect();
}

async function stop(immediate) {
  console.log('[DRP] stop: disabling DRP');
  enabled = false;
  stopReconnect();
  destroyClient();

  if (immediate && client) {
    await clearActivity();
  }
}

function startPolling(win) {
  winRef = win;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(sampleAndPush, POLL_MS);
  console.log('[DRP] startPolling: polling every', POLL_MS, 'ms');
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

const rpc = {
  isEnabled: () => readSettings().richPresenceEnabled === true,
  getStatus: () => ({
    enabled,
    available,
    loggedIn: loggedIn && !!client,
    clientId: CLIENT_ID,
    keyboardShortcutsEnabled: readSettings().keyboardShortcutsEnabled === true,
  }),
  enable(win) {
    writeSettings({ richPresenceEnabled: true });
    console.log('[DRP] enable: turning DRP ON');
    enabled = true;
    stopReconnect();
    destroyClient();
    lastSentState = '';
    lastSentAt = 0;
    prevTrack = '';
    prevArtist = '';
    prevAlbumTag = '';
    prevDuration = 0;
    prevPlaying = false;
    winRef = win;
    startPolling(win);
    reconnect();
    return rpc.getStatus();
  },
  async disable(immediate) {
    console.log('[DRP] disable: turning DRP OFF');
    writeSettings({ richPresenceEnabled: false });
    stopReconnect();
    stopPolling();
    await stop(immediate);
    return rpc.getStatus();
  },
  attach(win) {
    winRef = win;
    console.log('[DRP] attach: win attached');
    if (readSettings().richPresenceEnabled) {
      console.log('[DRP] attach: DRP enabled, starting');
      enabled = true;
      stopReconnect();
      destroyClient();
      lastSentState = '';
      lastSentAt = 0;
      prevTrack = '';
      prevArtist = '';
      prevAlbumTag = '';
      prevDuration = 0;
      prevPlaying = false;
      reconnect();
    }
    startPolling(win);
  },
  setKeyboardShortcutsEnabled(win, on) {
    writeSettings({ keyboardShortcutsEnabled: !!on });
    return rpc.getStatus();
  },
  stopPolling,
  setLogHandler() {},
};

module.exports = rpc;