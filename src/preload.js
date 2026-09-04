'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('highwrld', {
  getStatus: () => ipcRenderer.invoke('rp:get-status'),
  setEnabled: (enabled) => ipcRenderer.invoke('rp:set-enabled', enabled),
  setKeyboardShortcutsEnabled: (enabled) => ipcRenderer.invoke('rp:set-keyboard-shortcuts', enabled),
  getKeyboardShortcutsEnabled: () => ipcRenderer.invoke('rp:get-keyboard-shortcuts'),
  onStatus: (cb) => {
    const listener = (_evt, status) => cb(status);
    ipcRenderer.on('rp:status', listener);
    return () => ipcRenderer.removeListener('rp:status', listener);
  },
});