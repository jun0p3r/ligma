'use strict';
// Title bar bridge only; Figma tabs get no preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ligma', {
  command: (name, arg) => ipcRenderer.send('ligma:command', name, arg),
  onState: (callback) => ipcRenderer.on('ligma:state', (_event, state) => callback(state)),
});
