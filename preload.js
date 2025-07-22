const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  // --- Connection --- 
  connect: (serverId) => ipcRenderer.invoke('connect', serverId),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  onConnectionState: (callback) => ipcRenderer.on('connection-state', (_event, value) => callback(value)),
  onUptimeUpdate: (callback) => ipcRenderer.on('uptime-update', (_event, value) => callback(value)),

  // --- Servers ---
  getServers: () => ipcRenderer.invoke('get-servers'),
  addServer: (url) => ipcRenderer.invoke('add-server', url),
  deleteServer: (id) => ipcRenderer.invoke('delete-server', id),
  setActiveServer: (id) => ipcRenderer.invoke('set-active-server', id),
  pingServer: (server) => ipcRenderer.invoke('ping-server', server),

  // --- Settings ---
  getAutoFailover: () => ipcRenderer.invoke('get-auto-failover'),
  setAutoFailover: (enabled) => ipcRenderer.invoke('set-auto-failover', enabled),

  // --- Notifications ---
  onShowNotification: (callback) => ipcRenderer.on('show-notification', (_event, value) => callback(value)),
});

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld(
  'api', {
    // VPN operations
    getStatus: () => ipcRenderer.invoke('vpn:status'),
    connect: (serverId) => ipcRenderer.invoke('vpn:connect', serverId),
    disconnect: () => ipcRenderer.invoke('vpn:disconnect'),
    switchServer: (serverId) => ipcRenderer.invoke('vpn:switch-server', serverId),
    getDiagnostics: () => ipcRenderer.invoke('vpn:diagnostics'),
    
    // Server management
    getServers: () => ipcRenderer.invoke('vpn:getServers'),
    addServer: (serverUrl) => ipcRenderer.invoke('vpn:addServer', serverUrl),
    deleteServer: (serverId) => ipcRenderer.invoke('vpn:deleteServer', serverId),
    setActiveServer: (serverId) => ipcRenderer.invoke('vpn:setActiveServer', serverId),
    pingServer: (server) => ipcRenderer.invoke('ping-server', server),
    
    // Auto-failover settings
    getAutoFailoverStatus: () => ipcRenderer.invoke('vpn:getAutoFailoverStatus'),
    setAutoFailover: (enabled) => ipcRenderer.invoke('vpn:setAutoFailover', enabled),
    
    // Event listeners
    onStatusChange: (callback) => ipcRenderer.on('vpn:status-change', (_, ...args) => callback(...args)),
    onAutoFailover: (callback) => ipcRenderer.on('vpn:auto-failover', (_, ...args) => callback(...args)),
    onConnectionSuccess: (callback) => ipcRenderer.on('vpn:connected', (_, ...args) => callback(...args)),
    onConnectionError: (callback) => ipcRenderer.on('vpn:connection-error', (_, ...args) => callback(...args)),
    onDisconnect: (callback) => ipcRenderer.on('vpn:disconnected', (_, ...args) => callback(...args)),
    onServersUpdated: (callback) => ipcRenderer.on('vpn:servers-updated', (_, ...args) => callback(...args)),
    
    // Utility functions
    parseVLESSUrl: (url) => ipcRenderer.invoke('vpn:parseVLESSUrl', url),
    fetchJson: (url, options) => ipcRenderer.invoke('vpn:fetchJson', url, options),
    getCountryName: (countryCode) => ipcRenderer.invoke('vpn:getCountryName', countryCode),
    
    // Media access for QR scanning
    requestMediaAccess: () => ipcRenderer.invoke('media:requestPermission')
  }
);
