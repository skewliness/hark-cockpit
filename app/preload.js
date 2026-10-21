const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cockpit', {
  add: (o) => ipcRenderer.invoke('add', o),
  switchTo: (id) => ipcRenderer.invoke('switch', id),
  rename: (id, name) => ipcRenderer.invoke('rename', { id, name }),
  reload: (id) => ipcRenderer.invoke('reload', id),
  remove: (id) => ipcRenderer.invoke('remove', id),
  getState: () => ipcRenderer.invoke('getState'),
  installUpdate: () => ipcRenderer.invoke('installUpdate'),
  checkUpdate: () => ipcRenderer.invoke('checkUpdate'),
  version: () => ipcRenderer.invoke('version'),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, s) => cb(s)),
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
});
