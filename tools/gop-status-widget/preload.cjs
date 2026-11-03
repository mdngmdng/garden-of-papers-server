const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('gop', {
  state: () => ipcRenderer.invoke('state'),
  refresh: () => ipcRenderer.invoke('refresh'),
  save: value => ipcRenderer.invoke('settings', value),
  action: value => ipcRenderer.invoke('action', value),
  subscribe: callback => { const handler = (_, state) => callback(state); ipcRenderer.on('status', handler); return () => ipcRenderer.removeListener('status', handler); },
});
