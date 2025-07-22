// Register IPC handlers
function registerIpcHandlers() {
  console.log('Registering IPC handlers');
  
  // VPN operations
  ipcMain.handle('vpn:status', getStatus);
  ipcMain.handle('vpn:connect', connectVPN);
  ipcMain.handle('vpn:disconnect', disconnectVPN);
  ipcMain.handle('vpn:diagnostics', getDiagnostics);
  
  // Server management
  ipcMain.handle('vpn:getServers', () => {
    console.log('Get servers called, returning:', serversData.servers);
    return serversData.servers || [];
  });
  ipcMain.handle('vpn:addServer', (_, serverUrl) => addServer(serverUrl));
  ipcMain.handle('vpn:deleteServer', (_, serverId) => deleteServer(serverId));
  ipcMain.handle('vpn:setActiveServer', (_, serverId) => setActiveServer(serverId));
  ipcMain.handle('vpn:parseVLESSUrl', (_, url) => serverManager.parseVLESSUrl(url));
}
