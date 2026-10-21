'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 历史条目
  list: (opts) => ipcRenderer.invoke('items:list', opts),
  paste: (id, opts) => ipcRenderer.invoke('item:paste', id, opts),
  copy: (id) => ipcRenderer.invoke('item:copy', id),
  pin: (id) => ipcRenderer.invoke('item:pin', id),
  remove: (id) => ipcRenderer.invoke('item:delete', id),
  contextMenu: (id) => ipcRenderer.invoke('item:menu', id),

  // 标签
  tags: () => ipcRenderer.invoke('tags:list'),
  tagAdd: (id, name) => ipcRenderer.invoke('tag:add', id, name),
  tagRemove: (id, name) => ipcRenderer.invoke('tag:remove', id, name),

  // 设置与备份
  stats: () => ipcRenderer.invoke('app:stats'),
  settings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),

  // 应用级
  togglePause: () => ipcRenderer.invoke('app:togglePause'),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  setView: (view) => ipcRenderer.invoke('view:set', view),
  hide: () => ipcRenderer.invoke('overlay:hide'),
  quit: () => ipcRenderer.invoke('app:quit'),

  onShown: (cb) => ipcRenderer.on('overlay:shown', () => cb()),
  onHidden: (cb) => ipcRenderer.on('overlay:hidden', () => cb()),
  onOpenSettings: (cb) => ipcRenderer.on('settings:open', (_e, payload) => cb(payload)),
  onChanged: (cb) => ipcRenderer.on('items:changed', () => cb()),
  onStatus: (cb) => ipcRenderer.on('app:status', (_e, payload) => cb(payload))
});
