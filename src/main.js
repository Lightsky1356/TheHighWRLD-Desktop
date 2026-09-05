'use strict';

const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const rpc = require('./rpc');

const DASHBOARD_URL = process.env.THEHIGHWRLD_DASHBOARD_URL || 'https://thehighwrlddashboard.pages.dev';

let win = null;
let settingsWin = null;
let keyboardShortcutsEnabled = false;

app.whenReady().then(() => {
  try { keyboardShortcutsEnabled = !!rpc.getStatus().keyboardShortcutsEnabled; } catch(e) { keyboardShortcutsEnabled = false; }
  createWindow();
  Menu.setApplicationMenu(null);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  rpc.stopPolling();
  rpc.disable(false);
  app.quit();
});

function performKeyboardAction(action) {
  if (!win || win.isDestroyed()) return;
  const js = `(() => {
    const audio = document.getElementById('audio-preview');
    const mp = document.getElementById('mini-player');
    if (!mp || mp.classList.contains('hidden')) return null;
    switch (action) {
      case 'play-pause': {
        if (!audio) return 'no-audio';
        if (audio.paused) audio.play(); else audio.pause();
        return 'toggled';
      }
      case 'next': { const b = document.getElementById('mini-next'); if (b) b.click(); return 'next'; }
      case 'prev': { const b = document.getElementById('mini-prev'); if (b) b.click(); return 'prev'; }
      case 'vol-up': { if (!audio) return 'no-audio'; audio.volume = Math.min(1, (audio.volume||0) + 0.1); return 'vol-up-' + Math.round(audio.volume*100); }
      case 'vol-down': { if (!audio) return 'no-audio'; audio.volume = Math.max(0, (audio.volume||0) - 0.1); return 'vol-down-' + Math.round(audio.volume*100); }
      case 'mute': { if (!audio) return 'no-audio'; audio.muted = !audio.muted; return 'mute-' + audio.muted; }
      default: return 'unknown';
    }
  })()`;
  win.webContents.executeJavaScript(js).catch(() => {});
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 640,
    title: 'TheHighWRLD', backgroundColor: '#0a0a19', autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: true },
  });
  win.loadURL(DASHBOARD_URL + '?v=' + Date.now());
  win.removeMenu();

  win.webContents.on('did-finish-load', () => {
    rpc.attach(win);
    broadcastStatus();
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (!keyboardShortcutsEnabled) return;
    const key = input.key;
    if (input.isComposing) return;
    const tag = (input.target && input.target.type) || '';
    if (tag === 'textarea' || tag === 'text' || tag === 'search' || tag === 'url' || tag === 'password') return;
    if (key === 'v' || key === 'V') return;
    switch (key) {
      case ' ': event.preventDefault(); performKeyboardAction('play-pause'); break;
      case 'ArrowRight': event.preventDefault(); performKeyboardAction('next'); break;
      case 'ArrowLeft': event.preventDefault(); performKeyboardAction('prev'); break;
      case 'ArrowUp': event.preventDefault(); performKeyboardAction('vol-up'); break;
      case 'ArrowDown': event.preventDefault(); performKeyboardAction('vol-down'); break;
      case 'm': case 'M': event.preventDefault(); performKeyboardAction('mute'); break;
    }
  });

  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      require('electron').shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

function openSettings() {
  if (settingsWin) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 460, height: 380, resizable: false,
    title: 'TheHighWRLD Settings', backgroundColor: '#0f0f20',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, '..', 'settings.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
}

function broadcastStatus() {
  const status = rpc.getStatus();
  for (const target of [win, settingsWin]) {
    if (target && !target.isDestroyed()) target.webContents.send('rp:status', status);
  }
}

ipcMain.handle('rp:get-status', () => ({ ...rpc.getStatus(), isNative: true }));

ipcMain.handle('rp:set-enabled', async (_evt, enabled) => {
  if (enabled === true) await rpc.enable(win); else await rpc.disable(true);
  broadcastStatus(); return rpc.getStatus();
});

ipcMain.handle('rp:set-keyboard-shortcuts', async (_evt, on) => {
  keyboardShortcutsEnabled = !!on;
  rpc.setKeyboardShortcutsEnabled(win, on);
  broadcastStatus();
  return { enabled: keyboardShortcutsEnabled, isNative: true };
});

ipcMain.handle('rp:get-keyboard-shortcuts', () => ({ enabled: !!rpc.getStatus().keyboardShortcutsEnabled, isNative: true }));

ipcMain.on('rp:open-settings', () => openSettings());

let lastPage = null;
setInterval(() => {
  if (!win || win.isDestroyed()) return;
  broadcastStatus();
  win.webContents.executeJavaScript(`(() => { const e = document.querySelector('.app-page.active'); return e ? e.id : 'home'; })()`, true)
    .then((id) => { if (id && id !== lastPage) { lastPage = id; } }).catch(() => {});
}, 3000);
