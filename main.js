const { app, BrowserWindow, ipcMain, Tray, Menu, session, systemPreferences } = require('electron');

// Disable console.log in production for user privacy
if (app.isPackaged) {
  console.log = function() {};
}
const dns = require('dns').promises;
const tcpp = require('tcp-ping');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { exec, spawn, execSync } = require('child_process');
const axios = require('axios');
const serverManager = require('./serverManager');
const networkMonitor = require('./networkMonitor');

// App paths
const configPath = path.join(app.getPath('userData'), 'xray_config.json');
const serversPath = path.join(app.getPath('userData'), 'servers.json');
const binDir = path.join(__dirname, 'bin');

// Global variables
let mainWindow = null;
let tray = null;
let xrayProcess = null;
let isConnected = false;
let connectionStartTime = null;
let serversData = { servers: [], activeServer: null };
let autoReconnectEnabled = true; // Auto-reconnect enabled by default
let isAutoFailoverInProgress = false;
let isReconnectionInProgress = false; // Flag to prevent simultaneous reconnections
let lastConnectedIP = null;
let lastReconnectTime = 0; // Timestamp of last reconnection attempt
let sessionFailedServers = []; // Tracks servers that fail in the current session

// --- IPC HANDLER FOR PINGING SERVERS ---
ipcMain.handle('ping-server', async (event, { host, port }) => {
  try {
    // Resolve hostname to IP address first, as requested
    const { address: ip } = await dns.lookup(host);

    return new Promise((resolve) => {
      tcpp.ping({ address: ip, port: port, timeout: 2000, attempts: 1 }, (err, data) => {
        if (err || isNaN(data.avg)) {
          resolve(null); // Return null on failure or if ping is NaN
        } else {
          resolve(Math.round(data.avg));
        }
      });
    });
  } catch (error) {
    console.error(`Ping error for ${host}:${port}:`, error.message);
    return null; // Return null if DNS lookup or ping fails
  }
});

// Find Xray binary
function findXrayBinary() {
  // In development mode, binaries are in the project directory
  // In production mode, binaries are in resources/bin
  let possiblePaths = [];
  
  // Check if we're running in dev or production
  if (app.isPackaged) {
    // Production paths
    const resourcesPath = process.resourcesPath;
    possiblePaths = [
      path.join(resourcesPath, 'bin', 'xray'),
      path.join(resourcesPath, 'bin/xray')
    ];
  } else {
    // Development paths
    possiblePaths = [
      path.join(binDir, 'xray'),
      path.join(__dirname, 'bin/xray')
    ];
  }
  
  // Add common system paths as fallback
  possiblePaths.push('/usr/local/bin/xray');
  
  for (const binPath of possiblePaths) {
    try {
      if (fs.existsSync(binPath)) {
        console.log(`Found Xray binary at: ${binPath}`);
        return binPath;
      }
    } catch (error) {
      console.error(`Error checking ${binPath}:`, error.message);
    }
  }
  
  console.error('Xray binary not found! Checked paths:', possiblePaths);
  return null;
}

// Create the browser window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 400,
    height: 640,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      enableRemoteModule: false,
      webSecurity: true
    },
    icon: path.join(__dirname, 'assets/icons/logo.png'),
    title: 'StealthLynk',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0c0c16',
    movable: true,
    center: true
  });

  mainWindow.loadFile('index.html');
  
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
  
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Create system tray
function createTray() {
  try {
    const iconPath = process.platform === 'win32'
      ? path.join(__dirname, 'assets/icons/logo.png')
      : path.join(__dirname, 'assets/icons/logo.png');
      
    // Create tray with icon if it exists, otherwise use a blank icon
    tray = new Tray(iconPath);
    updateTray();
    
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow();
      }
    });
    
    console.log('Tray created successfully');
  } catch (error) {
    console.error('Error creating tray:', error);
  }
}

// Update tray icon and menu
function updateTray() {
  if (!tray) return;
  
  try {
    const activeServer = serversData.servers.find(s => s.id === serversData.activeServer);
    const contextMenu = Menu.buildFromTemplate([
      { label: `Xray Reality VPN ${isConnected ? '(Connected)' : '(Disconnected)'}`, enabled: false },
      { type: 'separator' },
      { 
        label: activeServer ? `Server: ${activeServer.name}` : 'No server selected', 
        enabled: false 
      },
      { type: 'separator' },
      { 
        label: isConnected ? 'Disconnect' : 'Connect', 
        click: async () => {
          if (isConnected) {
            await disconnectVPN();
          } else {
            await connectVPN();
          }
        } 
      },
      { type: 'separator' },
      { label: 'Show App', click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createWindow();
        }
      }},
      { label: 'Quit', click: async () => {
        if (isConnected) {
          await disconnectVPN();
        }
        app.quit();
      }}
    ]);
    
    tray.setContextMenu(contextMenu);
    tray.setToolTip(`Xray Reality VPN - ${isConnected ? 'Connected' : 'Disconnected'}`);
  } catch (error) {
    console.error('Error updating tray:', error);
  }
}

// Register IPC handlers
function registerIpcHandlers() {
  console.log('Registering IPC handlers');
  
  // Auto-failover settings
  ipcMain.handle('vpn:getAutoFailoverStatus', () => {
    return { enabled: autoReconnectEnabled };
  });
  
  ipcMain.handle('vpn:setAutoFailover', (event, enabled) => {
    console.log(`[IPC] Setting auto-reconnect to: ${enabled}`);
    autoReconnectEnabled = enabled;
    // The network monitor will check this flag when it matters, so we just set the state here.
    return { success: true, enabled: autoReconnectEnabled };
  });
  
  // Media request permission handler
  ipcMain.handle('media:requestPermission', async () => {
    console.log('Media permission requested');
    try {
      // For macOS Big Sur and older versions on Intel Macs
      if (process.platform === 'darwin') {
        const cameraStatus = systemPreferences.getMediaAccessStatus('camera');
        console.log('Camera status on request:', cameraStatus);
        
        if (cameraStatus !== 'granted') {
          const granted = await systemPreferences.askForMediaAccess('camera');
          console.log('Camera access request result:', granted);
          return { success: granted };
        }
      }
      return { success: true };
    } catch (error) {
      console.error('Media permission error:', error);
      return { success: false, message: error.message };
    }
  });
  
  // VPN operations
  ipcMain.handle('vpn:status', getStatus);
  ipcMain.handle('vpn:connect', connectVPN);
  ipcMain.handle('vpn:disconnect', disconnectVPN);
  ipcMain.handle('vpn:diagnostics', getDiagnostics);
  
  // Server management
  ipcMain.handle('vpn:getServers', () => {
    console.log('Get servers called, returning:', serversData);
    // Return both the servers array AND the activeServer ID
    return serversData || { servers: [], activeServer: null };
  });
  ipcMain.handle('vpn:addServer', (_, serverUrl) => addServer(serverUrl));
  ipcMain.handle('vpn:deleteServer', (_, serverId) => deleteServer(serverId));
  ipcMain.handle('vpn:setActiveServer', (_, serverId) => setActiveServer(serverId));
  ipcMain.handle('vpn:parseVLESSUrl', (_, url) => serverManager.parseVLESSUrl(url));
  ipcMain.handle('vpn:getCountryName', (_, countryCode) => serverManager.getCountryName(countryCode));
  
  // JSON fetching (for proxied requests)
  ipcMain.handle('vpn:fetchJson', async (_, url, options = {}) => {
    console.log(`Fetching JSON from ${url}`);
    try {
      const response = await axios.get(url, options);
      return response.data;
    } catch (error) {
      console.error(`Error fetching JSON from ${url}:`, error.message);
      throw new Error(`Failed to fetch data: ${error.message}`);
    }
  });
}

// Add server
async function addServer(serverUrl) {
  try {
    console.log('Adding server from URL:', serverUrl);
    
    // Remember the active server if connected to preserve it
    const wasConnected = isConnected;
    const previousActiveServerId = serversData?.activeServer;

    const result = await serverManager.addServer(serverUrl);
    
    if (result.success) {
      // Reload servers data after adding
      serversData = serverManager.loadServers();
      
      // If we were connected, ensure the active server is preserved
      if (wasConnected && previousActiveServerId) {
        serverManager.setActiveServer(previousActiveServerId);
        serversData = serverManager.loadServers(); // Reload again to reflect correct active server
      }
      
      updateTray();
      console.log('Server added successfully:', result.server?.name);
      
      // Notify the renderer that the server list has been updated
      if (mainWindow) {
        mainWindow.webContents.send('vpn:servers-updated', {
          servers: serversData.servers,
          activeServer: serversData.activeServer,
          source: 'addServer' // Indicate the source of the update
        });
      }
    } else {
      console.error('Failed to add server:', result.message);
    }
    
    return result;
  } catch (error) {
    console.error('Error adding server:', error);
    return { success: false, message: error.message };
  }
}

// Delete server
function deleteServer(serverId) {
  try {
    console.log('Deleting server:', serverId);
    const result = serverManager.deleteServer(serverId);
    
    if (result.success) {
      // Reload servers data after deletion
      serversData = serverManager.loadServers();
      updateTray();
      console.log('Server deleted successfully');
    } else {
      console.error('Failed to delete server:', result.message);
    }
    
    return result;
  } catch (error) {
    console.error('Error deleting server:', error);
    return { success: false, message: error.message };
  }
}

// Set active server
// Set active server and handle reconnection
async function setActiveServer(serverId) {
  console.log(`Setting active server to: ${serverId}`);

  // Stop monitoring during the switch to prevent false failovers
  networkMonitor.stopMonitoring();

  const wasConnected = isConnected;

  try {
    // If already connected, disconnect gracefully first
    if (wasConnected) {
      console.log('Disconnecting from current server before switching...');
      await disconnectVPN(true); // silent disconnect
    }

    // Set the new server as active in the config
    const setResult = serverManager.setActiveServer(serverId);
    if (!setResult.success) {
      throw new Error(setResult.message);
    }

    // Reload server data to get the new active server config
    serversData = serverManager.loadServers();
    updateTray();
    
    const activeServer = serversData.servers.find(s => s.id === serverId);
    console.log(`Active server is now: ${activeServer.name}`);

    // If the VPN was on before, automatically reconnect to the new server
    if (wasConnected) {
      console.log('Reconnecting to new server...');
      // Use a timeout to allow the old process to fully terminate
      await new Promise(resolve => setTimeout(resolve, 500));
      await connectVPN();
    }
    
    return { success: true, server: activeServer };

  } catch (error) {
    console.error('Error setting active server:', error);
    // Attempt to restore previous state if something went wrong
    if (wasConnected) {
      console.log('Attempting to reconnect to the original server after failure...');
      await connectVPN();
    }
    return { success: false, message: error.message };
  }
}

// Get active server
function getActiveServer() {
  try {
    console.log('Getting active server...');
    if (!serversData || !serversData.servers || !serversData.activeServer) {
      console.log('No active server found');
      return null;
    }
    
    const activeServer = serversData.servers.find(server => server.id === serversData.activeServer);
    console.log('Active server:', activeServer ? activeServer.name : 'Not found');
    return activeServer || null;
  } catch (error) {
    console.error('Error getting active server:', error);
    return null;
  }
}

// App ready event
app.whenReady().then(async () => {
  try {
    // Handle media permission requests specifically for the camera
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      console.log(`Permission requested: ${permission}, Details: ${JSON.stringify(details)}`);
      // The permission type for getUserMedia is 'media'
      if (permission === 'media') {
        // We only want to grant access to the camera, not the microphone
        if (details.mediaTypes.includes('video')) {
          console.log('Granting video permission.');
          callback(true);
        } else {
          console.log('Denying non-video media permission.');
          callback(false);
        }
      } else {
        // Deny all other permission requests
        console.log(`Denying permission for '${permission}'.`);
        callback(false);
      }
    });
    
    // Explicitly request camera permissions for Big Sur on Intel Macs
    if (process.platform === 'darwin') {
      try {
        // Check current camera permission status
        const cameraStatus = systemPreferences.getMediaAccessStatus('camera');
        console.log('Initial camera access status:', cameraStatus);
        
        // Explicitly request camera access if not already granted
        if (cameraStatus !== 'granted') {
          console.log('Requesting camera permission for Big Sur...');
          const granted = await systemPreferences.askForMediaAccess('camera');
          console.log('Camera access granted:', granted);
          
          // If permission is still not granted, show message in main window when it's ready
          if (!granted) {
            setTimeout(() => {
              if (mainWindow) {
                mainWindow.webContents.send('show-notification', {
                  message: 'Please enable camera access in System Preferences > Security & Privacy > Camera',
                  type: 'warning'
                });
              }
            }, 2000);
          }
        }
      } catch (err) {
        console.error('Error requesting camera permissions:', err);
      }
    }
    
    // Load servers
    serversData = serverManager.loadServers();
    
    // Create window and tray
    createWindow();
    createTray();
    
    // Register IPC handlers
    registerIpcHandlers();
    
    // Remove quarantine attribute on macOS
    if (process.platform === 'darwin') {
      const xrayPath = path.join(binDir, 'xray');
      if (fs.existsSync(xrayPath)) {
        try {
          execSync(`xattr -d com.apple.quarantine "${xrayPath}"`, { stdio: 'ignore' });
          console.log('Removed quarantine attribute from Xray binary');
        } catch (error) {
          // Ignore errors - might not be quarantined
        }
      }
    }
  } catch (error) {
    console.error('Error initializing app:', error);
  }
});
// Request admin privileges with user prompt (without multiple password requests)
async function requestAdminAccess() {
  try {
    // Use a subtle AppleScript prompt just once
    const script = `
    tell application "System Events"
      return "Success"
    end tell
    `;
    execSync(`osascript -e '${script}'`);
    return true;
  } catch (error) {
    console.log('AppleScript test failed:', error.message);
    return false;
  }
}

// Configure system proxy using command-line only (no UI)
async function configureProxy(enable) {
  try {
    if (process.platform === 'darwin') {
      console.log(`${enable ? 'Enabling' : 'Disabling'} proxy settings...`);
      
      // Get active network services
      const servicesOutput = execSync('networksetup -listallnetworkservices').toString();
      const services = servicesOutput.split('\n')
        .filter(service => service && !service.includes('*'));
      
      console.log('Found network services:', services);
      
      // Filter to prioritize Wi-Fi and Ethernet services first
      const prioritizedServices = services.sort((a, b) => {
        if (a.includes('Wi-Fi')) return -1;
        if (b.includes('Wi-Fi')) return 1;
        if (a.includes('Ethernet')) return -1;
        if (b.includes('Ethernet')) return 1;
        return 0;
      });
      
      // Focus on key services - specifically Wi-Fi and Ethernet
      const primaryServices = prioritizedServices.filter(service => {
        return service.includes('Wi-Fi') || service.includes('Ethernet');
      });
      
      if (primaryServices.length === 0) {
        // Fallback to top two services if no Wi-Fi or Ethernet found
        primaryServices = prioritizedServices.slice(0, Math.min(2, prioritizedServices.length));
      }
      
      console.log('Configuring services:', primaryServices);
      
      // Request admin access once to avoid multiple password prompts
      await requestAdminAccess();

      // --- Chrome Secure DNS Policy ---
      if (enable) {
        // Disable Chrome's Secure DNS (DNS-over-HTTPS) to prevent IP leaks.
        try {
          execSync('defaults write com.google.Chrome DnsOverHttpsMode -string "off"');
          console.log('Chrome Secure DNS disabled.');
        } catch (error) {
          console.error('Failed to disable Chrome Secure DNS. This may require admin rights.', error);
        }
      } else {
        // Re-enable Chrome's Secure DNS by deleting the policy override.
        try {
          execSync('defaults delete com.google.Chrome DnsOverHttpsMode');
          console.log('Chrome Secure DNS restored.');
        } catch (error) {
          // Ignore errors if the key doesn't exist
        }
      }
      
      let configuredSuccessfully = false;
      
      for (const service of primaryServices) {
        try {
          console.log(`Configuring ${service} service...`);
          
          if (enable) {
            // SOCKS proxy - use synchronous commands
            console.log(`Enabling SOCKS proxy for ${service}`);
            try {
              execSync(`networksetup -setsocksfirewallproxy "${service}" 127.0.0.1 10808`);
              execSync(`networksetup -setsocksfirewallproxystate "${service}" on`);
              console.log(`SOCKS proxy enabled for ${service}`);
              configuredSuccessfully = true;
            } catch (err) {
              console.error(`Error enabling SOCKS for ${service}:`, err.message);
            }
            
            // HTTP proxy - use synchronous commands
            console.log(`Enabling HTTP proxy for ${service}`);
            try {
              execSync(`networksetup -setwebproxy "${service}" 127.0.0.1 10809`);
              execSync(`networksetup -setwebproxystate "${service}" on`);
              console.log(`HTTP proxy enabled for ${service}`);
            } catch (err) {
              console.error(`Error enabling HTTP for ${service}:`, err.message);
            }
            
            // HTTPS proxy - use synchronous commands
            console.log(`Enabling HTTPS proxy for ${service}`);
            try {
              execSync(`networksetup -setsecurewebproxy "${service}" 127.0.0.1 10809`);
              execSync(`networksetup -setsecurewebproxystate "${service}" on`);
              console.log(`HTTPS proxy enabled for ${service}`);
            } catch (err) {
              console.error(`Error enabling HTTPS for ${service}:`, err.message);
            }
          } else {
            // Disable all proxy types using command-line only - no UI automation
            console.log(`Disabling all proxies for ${service}`);
            
            try {
              // SOCKS
              execSync(`networksetup -setsocksfirewallproxystate "${service}" off`);
              console.log(`SOCKS proxy disabled for ${service}`);
              configuredSuccessfully = true;
            } catch (err) {
              console.error(`Error disabling SOCKS proxy for ${service}:`, err.message);
            }
            
            // HTTP
            try {
              execSync(`networksetup -setwebproxystate "${service}" off`);
              console.log(`HTTP proxy disabled for ${service}`);
            } catch (err) {
              console.error(`Error disabling HTTP proxy for ${service}:`, err.message);
            }
            
            // HTTPS
            try {
              execSync(`networksetup -setsecurewebproxystate "${service}" off`);
              console.log(`HTTPS proxy disabled for ${service}`);
            } catch (err) {
              console.error(`Error disabling HTTPS proxy for ${service}:`, err.message);
            }
          }
        } catch (serviceErr) {
          console.error(`Error configuring ${service}:`, serviceErr.message);
        }
      }
      
      // Update Electron app proxy settings
      session.defaultSession.setProxy({
        proxyRules: enable ? "socks5://127.0.0.1:10808" : "",
        pacScript: "",
        proxyBypassRules: "localhost,127.0.0.1"
      });
      
      return { success: configuredSuccessfully };
    } else if (process.platform === 'win32') {
      // Windows proxy configuration - use synchronous execution for reliability
      try {
        if (enable) {
          execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 1 /f');
          execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer /t REG_SZ /d "socks=127.0.0.1:1080" /f');
          console.log('Windows proxy enabled');
        } else {
          execSync('reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f');
          console.log('Windows proxy disabled');
        }
        
        // Update Electron app proxy settings
        session.defaultSession.setProxy({
          proxyRules: enable ? "socks5://127.0.0.1:1080" : "",
          pacScript: "",
          proxyBypassRules: "localhost,127.0.0.1"
        });
        
        return { success: true };
      } catch (winError) {
        console.error('Windows proxy error:', winError);
        return { success: false, message: `Windows proxy error: ${winError.message}` };
      }
    } else if (process.platform === 'linux') {
      // Linux (GNOME) proxy configuration - use synchronous execution for reliability
      try {
        if (enable) {
          execSync('gsettings set org.gnome.system.proxy mode "manual"');
          execSync('gsettings set org.gnome.system.proxy.socks host "127.0.0.1"');
          execSync('gsettings set org.gnome.system.proxy.socks port 1080');
          console.log('Linux proxy enabled');
        } else {
          execSync('gsettings set org.gnome.system.proxy mode "none"');
          console.log('Linux proxy disabled');
        }
        
        // Update Electron app proxy settings
        session.defaultSession.setProxy({
          proxyRules: enable ? "socks5://127.0.0.1:1080" : "",
          pacScript: "",
          proxyBypassRules: "localhost,127.0.0.1"
        });
        
        return { success: true };
      } catch (linuxError) {
        console.error('Linux proxy error:', linuxError);
        return { success: false, message: `Linux proxy error: ${linuxError.message}` };
      }
    }
    
    // Platform not supported
    return { success: false, message: `Platform ${process.platform} not supported` };
  } catch (error) {
    console.error('Error configuring proxy:', error);
    return { success: false, message: `Error configuring proxy: ${error.message}` };
  }
}
// Ultra-fast IP detection for all scenarios
async function testConnection() {
  // Only use the fastest services with minimal timeout
  const ipServices = [
    { url: 'https://api.ipify.org', type: 'text' },
    { url: 'https://ifconfig.me/ip', type: 'text' }
  ];
  
  // Use Promise.race to get the first response that succeeds
  const requestPromises = []; 
  
  // Attempt all services in parallel with short timeout
  try {
    const socksStatus = execSync('networksetup -getsocksfirewallproxy Wi-Fi').toString();
    console.log('SOCKS Proxy Status:', socksStatus);
    
    const webStatus = execSync('networksetup -getwebproxy Wi-Fi').toString();
    console.log('Web Proxy Status:', webStatus);
  } catch (err) {
    console.error('Error checking proxy status:', err.message);
  }
  
  // Configure the HTTP client to use our SOCKS proxy
  const SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
  const socksAgent = new SocksProxyAgent('socks5://127.0.0.1:10808', {
    timeout: 15000,
    keepAlive: true
  });
  
  console.log('Testing VPN connection to detect IP address...');
  console.log('Using SOCKS proxy at socks5://127.0.0.1:10808');
  
  try {
    const socksStatus = execSync('networksetup -getsocksfirewallproxy Wi-Fi').toString();
    console.log('SOCKS Proxy Status:', socksStatus);
    
    const webStatus = execSync('networksetup -getwebproxy Wi-Fi').toString();
    console.log('Web Proxy Status:', webStatus);
  } catch (err) {
    console.error('Error checking proxy status:', err.message);
  }
  
  // Create promises for all services - run them in parallel
  console.log('Starting parallel IP detection requests');
  const allPromises = ipServices.map(service => {
    return new Promise(async (resolve) => {
      try {
        // Create axios instance with very short timeout
        const axiosInstance = axios.create({
          baseURL: service.url,
          httpsAgent: socksAgent,
          httpAgent: socksAgent,
          timeout: 2000, // Extremely short timeout for fast response
          maxRedirects: 3,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          }
        });
        
        // Make the request
        const response = await axiosInstance.get('');
        
        // Process the response based on type
        let ip;
        if (service.type === 'json' && service.field) {
          ip = response.data[service.field];
        } else {
          ip = response.data;
        }
        
        // If we got a valid IP, resolve with it
        if (ip && typeof ip === 'string') {
          console.log(`IP detected via ${service.url}: ${ip.trim()}`);
          resolve(ip.trim());
        } else {
          resolve(null);
        }
      } catch (err) {
        console.log(`IP detection via ${service.url} failed`);
        resolve(null);
      }
    });
  });

  // Use Promise.race to get the first valid response
  try {
    const results = await Promise.allSettled(allPromises);
    const successfulResults = results
      .filter(result => result.status === 'fulfilled' && result.value)
      .map(result => result.value);
    
    if (successfulResults.length > 0) {
      return successfulResults[0];
    }
  } catch (err) {
    console.error('All parallel IP detection requests failed');
  }
  
  // Fallback - try each service sequentially with longer timeout as last resort
  for (const service of ipServices) {
    try {
      console.log(`Fallback: Attempting to detect IP using ${service.url}`);

      // Method 1: SOCKS proxy agent
      try {
        const axiosInstance = axios.create({
          baseURL: service.url,
          httpsAgent: socksAgent,
          httpAgent: socksAgent,
          timeout: 3000,
          headers: {
            'User-Agent': 'Mozilla/5.0'
          }
        });
        const response = await axiosInstance.get('');
        let ip;
        if (service.type === 'json' && service.field) {
          ip = response.data[service.field];
        } else {
          ip = response.data;
        }
        if (ip && typeof ip === 'string') {
          console.log(`Successfully detected VPN IP: ${ip}`);
          return ip.trim();
        }
      } catch (proxyError) {
        console.log(`SOCKS proxy method 1 failed: ${proxyError.message}`);
      }

      // Method 2: Alternate SOCKS config
      try {
        const response = await axios.get(service.url, {
          proxy: {
            protocol: 'socks5:',
            host: '127.0.0.1',
            port: 10808
          },
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          }
        });
        let ip;
        if (service.type === 'json' && service.field) {
          ip = response.data[service.field];
        } else {
          ip = response.data;
        }
        if (ip && typeof ip === 'string') {
          console.log(`Successfully detected VPN IP using method 2: ${ip}`);
          return ip.trim();
        }
      } catch (socksError2) {
        console.log(`SOCKS proxy method 2 failed: ${socksError2.message}`);
      }

      // Method 3: HTTP proxy
      try {
        const { HttpsProxyAgent } = require('https-proxy-agent');
        const { HttpProxyAgent } = require('http-proxy-agent');
        const httpsProxyAgent = new HttpsProxyAgent('http://127.0.0.1:10809');
        const httpProxyAgent = new HttpProxyAgent('http://127.0.0.1:10809');
        const response = await axios.get(service.url, {
          httpsAgent: httpsProxyAgent,
          httpAgent: httpProxyAgent,
          timeout: 10000,
          maxRedirects: 5,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
          }
        });
        let ip;
        if (service.type === 'json' && service.field) {
          ip = response.data[service.field];
        } else {
          ip = response.data;
        }
        if (ip && typeof ip === 'string') {
          console.log(`Successfully detected VPN IP via HTTP proxy: ${ip}`);
          return ip.trim();
        }
      } catch (httpProxyError) {
        console.log(`HTTP proxy attempt failed: ${httpProxyError.message}`);
      }
    } catch (error) {
      console.error(`Error with ${service.url}:`, error.message);
      // Continue to next service
    }
  }

  console.error('All IP detection services failed');
  return null;
}

// Get connection status
async function getStatus() {
  try {
    const originalIp = await getOriginalIP();
    
    const status = {
      connected: isConnected,
      originalIp
    };
    
    if (isConnected) {
      status.proxyIp = await testConnection() || 'Unknown';
      
      if (connectionStartTime) {
        const uptime = Math.floor((Date.now() - connectionStartTime) / 1000);
        status.uptime = {
          hours: Math.floor(uptime / 3600).toString().padStart(2, '0'),
          minutes: Math.floor((uptime % 3600) / 60).toString().padStart(2, '0'),
          seconds: Math.floor(uptime % 60).toString().padStart(2, '0')
        };
      }
    }
    
    return status;
  } catch (error) {
    console.error('Error getting status:', error);
    return { connected: isConnected, error: error.message };
  }
}

// Get original IP
async function getOriginalIP() {
  try {
    const response = await axios.get('https://api.ipify.org', { timeout: 5000 });
    return response.data;
  } catch (error) {
    console.error('Error getting original IP:', error);
    return 'Unknown';
  }
}

// Get diagnostics
async function getDiagnostics() {
  try {
    const diagnostics = {
      app: {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch
      },
      xray: {
        path: findXrayBinary() || 'Not found',
        version: null
      },
      network: {
        originalIp: await getOriginalIP(),
        connected: isConnected
      }
    };
    
    // Try to get Xray version
    const xrayBinary = findXrayBinary();
    if (xrayBinary) {
      try {
        const versionOutput = execSync(`"${xrayBinary}" --version`).toString();
        diagnostics.xray.version = versionOutput.trim();
      } catch (error) {
        diagnostics.xray.version = `Error getting version: ${error.message}`;
      }
    }
    
    // Add proxy IP if connected
    if (isConnected) {
      diagnostics.network.proxyIp = await testConnection() || 'Unknown';
    }
    
    return diagnostics;
  } catch (error) {
    console.error('Error getting diagnostics:', error);
    return { error: error.message };
  }
}

// Update server country info based on IP
async function updateServerCountryInfo(serverId, ip) {
  // Load the current server data at the beginning.
  let currentServersData = serverManager.loadServers();

  if (!ip || ip === 'Connecting...' || ip === 'Unknown') {
    console.log('Skipping country update for invalid IP:', ip);
    return currentServersData; // Return current data if IP is invalid
  }

  try {
    console.log(`Fetching country info for IP: ${ip}`);
    const response = await axios.get(`http://ip-api.com/json/${ip}`);
    const geo = response.data;

    if (geo.status === 'success' && geo.countryCode) {
      const countryCode = geo.countryCode;
      const countryName = serverManager.getCountryName(countryCode);
      const flag = serverManager.getFlagEmoji(countryCode);

      const serverIndex = currentServersData.servers.findIndex(s => s.id === serverId);

      if (serverIndex !== -1) {
        console.log(`Updating server ${serverId} with country: ${countryName} (${countryCode})`);
        currentServersData.servers[serverIndex].countryCode = countryCode;
        currentServersData.servers[serverIndex].countryName = countryName;
        currentServersData.servers[serverIndex].flag = flag;
        
        // Save the updated data
        serverManager.saveServers(currentServersData);
      }
    } else {
      console.log('Failed to get country info for IP:', ip, 'Response:', geo);
    }
  } catch (error) {
    console.error('Error updating server country info:', error.message);
  }
  
  // Always return the latest data, whether it was updated or not.
  return currentServersData;
}

// Ultra-fast emergency IP detection
async function fastIpDetection() {
  // Use single fastest service with minimal timeout
  try {
    // Setup SOCKS proxy agent
    const SocksProxyAgent = require('socks-proxy-agent').SocksProxyAgent;
    const agent = new SocksProxyAgent('socks5://127.0.0.1:10808', { timeout: 1500 });
    
    // Make request with minimal timeout
    const response = await axios.get('https://api.ipify.org', {
      httpsAgent: agent, 
      timeout: 1500,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    
    if (response.data && typeof response.data === 'string') {
      console.log(`Fast IP detection success: ${response.data.trim()}`);
      return response.data.trim();
    }
  } catch (err) {
    console.log('Fast IP detection failed');
  }
  return null;
}

// Function to wait for proxy with active retry
function waitForProxy(port, host, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const tryConnect = () => {
      if (Date.now() - startTime > timeout) {
        reject(new Error(`Proxy connection timed out after ${timeout}ms`));
        return;
      }
      const socket = net.createConnection({ port, host }, () => {
        console.log(`Proxy at ${host}:${port} is ready.`);
        socket.end();
        resolve();
      });
      socket.on('error', (err) => {
        setTimeout(tryConnect, 200); // Retry after a short delay
      });
    };
    tryConnect();
  });
}

// Connect VPN
async function connectVPN(isEmergencyReconnect = false) {
  if (isConnected) {
    console.log('Already connected, aborting new connection request.');
    return { success: false, message: 'Already connected' };
  }

  console.log('Connecting to VPN...');
  const activeServerConfig = getActiveServer();

  if (!activeServerConfig) {
    console.log('No active server selected');
    return { success: false, message: 'No active server selected' };
  }

  // Stop any lingering monitor
  networkMonitor.stopMonitoring();

  try {
    const SOCKS_PORT = 10808;
    const HTTP_PORT = 10809;
    const xrayConfig = serverManager.generateXrayConfig(activeServerConfig, SOCKS_PORT, HTTP_PORT);
    fs.writeFileSync(configPath, JSON.stringify(xrayConfig, null, 2));

    const xrayBinary = findXrayBinary();
    if (!xrayBinary) {
      throw new Error('Xray binary not found.');
    }

    console.log(`Starting Xray for server: ${activeServerConfig.name}`);
    xrayProcess = spawn(xrayBinary, ['-c', configPath]);

    xrayProcess.stdout.on('data', (data) => console.log(`Xray: ${data.toString().trim()}`));
    xrayProcess.stderr.on('data', (data) => console.error(`Xray ERROR: ${data.toString().trim()}`));
    xrayProcess.on('close', (code) => {
      console.log(`Xray process exited with code ${code}`);
      if (isConnected) {
        disconnectVPN(true); // Ensure cleanup if process dies unexpectedly
      }
    });

    // CRITICAL: Wait for Xray to initialize and open ports
    console.log('Waiting for Xray to initialize with active retry...');
    try {
      await waitForProxy(10808, '127.0.0.1');
      console.log('Proxy on port 10808 is ready');
    } catch (error) {
      console.error('Error waiting for proxy:', error.message);
      throw new Error('Failed to establish proxy connection: ' + error.message);
    }

    console.log('Configuring system proxy...');
    await configureProxy(true);

    console.log('Verifying connection by detecting proxy IP...');
    const proxyIp = await testConnection();

    if (!proxyIp) {
      throw new Error('Could not verify connection. IP detection failed after starting proxy.');
    }

    // --- Connection Successful ---
    console.log(`VPN Connected. Detected IP: ${proxyIp}`);
    isConnected = true;
    connectionStartTime = Date.now();
    lastConnectedIP = proxyIp;
    updateTray();

    // Update server country info and UI
    const updatedServers = await updateServerCountryInfo(activeServerConfig.id, proxyIp);
    if (mainWindow) {
      mainWindow.webContents.send('vpn:connected', {
        ip: proxyIp,
        servers: updatedServers
      });
    }

    // --- Connection Successful ---
    // If this is a manual connection, not a failover, reset the failed server list.
    if (!isEmergencyReconnect) {
      sessionFailedServers = [];
      console.log('[FAILOVER] Session failed server list has been reset on manual connect.');
    }
    if (autoReconnectEnabled) {
      console.log(`Starting network monitor for IP: ${proxyIp}`);
      networkMonitor.startMonitoring(proxyIp, handleConnectionFailure);
    } else {
      console.log('Auto-reconnect is disabled. Network monitor will not be started.');
    }

    return { success: true, message: 'Connected successfully', status: await getStatus() };

  } catch (error) {
    console.error('Error connecting to VPN:', error.message);
    await disconnectVPN(true); // Cleanup on failure
    return { success: false, message: `Failed to connect: ${error.message}` };
  }
}

// Continuous monitoring and failover loop
async function handleConnectionFailure() {
  if (!autoReconnectEnabled || isAutoFailoverInProgress) {
    if (isAutoFailoverInProgress) console.log('[FAILOVER] Failover already in progress.');
    return;
  }

  console.log('[FAILOVER] Connection failure detected. Initiating failover sequence.');
  isAutoFailoverInProgress = true;

  try {
    const lastActiveServerId = serverManager.getActiveServerId();
    if (lastActiveServerId) {
      sessionFailedServers.push(lastActiveServerId);
      console.log(`[FAILOVER] Added server ${lastActiveServerId} to the session failed list.`);
    }

    await disconnectVPN(true); // Disconnect from the failed server

    const allServers = serverManager.getServers().servers;
    const availableServers = allServers.filter(s => !sessionFailedServers.includes(s.id));

    if (availableServers.length === 0) {
      console.log('[FAILOVER] No other servers to try. All have failed this session. Stopping.');
      sessionFailedServers = []; // Reset for the next manual connection attempt
      return;
    }

    console.log(`[FAILOVER] Ranking ${availableServers.length} available servers by latency...`);
    const rankedServers = await networkMonitor.getRankedServers(availableServers);

    if (rankedServers.length === 0) {
      console.log('[FAILOVER] No available servers responded to ping. Cannot failover.');
      return;
    }

    let connected = false;
    for (const nextServer of rankedServers) {
      console.log(`[FAILOVER] Attempting to connect to the next fastest server: ${nextServer.name}`);
      serverManager.setActiveServer(nextServer.id);
      const result = await connectVPN(true);

      if (result.success) {
        console.log(`[FAILOVER] Successfully connected to ${nextServer.name}.`);
        if (mainWindow) {
          mainWindow.webContents.send('vpn:auto-failover', { success: true, server: nextServer });
        }
        connected = true;
        break;
      }

      console.log(`[FAILOVER] Failed to connect to ${nextServer.name}. Adding to failed list and trying next server...`);
      sessionFailedServers.push(nextServer.id);
      await disconnectVPN(true);
    }

    if (!connected) {
      console.error('[FAILOVER] All failover attempts failed. Could not establish a new connection.');
    }
  } catch (error) {
    console.error('[FAILOVER] An unexpected error occurred during the failover process:', error);
  } finally {
    isAutoFailoverInProgress = false;
    console.log('[FAILOVER] Failover sequence finished.');
  }
}

// Disconnect VPN
async function disconnectVPN(silent = false) {
  try {
    if (!isConnected) {
      return { success: true, message: 'Not connected' };
    }
    
    // Kill Xray process
    if (xrayProcess) {
      console.log('Stopping Xray process');
      xrayProcess.kill();
      xrayProcess = null;
    }
    
    // Disable system proxy
    console.log('Disabling system proxy');
    await configureProxy(false);
    
    // Update connection state
    isConnected = false;
    connectionStartTime = null;
    
    // Stop monitoring the connection
    networkMonitor.stopMonitoring();
    
    updateTray();
    
    if (mainWindow) {
      // Send two events for better handling of disconnection:
      // 1. The general status change
      // 2. A specific disconnected event for handling server switching
      mainWindow.webContents.send('vpn:status-change', { connected: false });
      mainWindow.webContents.send('vpn:disconnected', { success: true });
    }
    
    return { success: true, message: 'Disconnected successfully' };
  } catch (error) {
    console.error('Error disconnecting from VPN:', error);
    return { success: false, message: `Failed to disconnect: ${error.message}` };
  }
}

// --- Open external links in default browser ---
const { shell } = require('electron');
app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  contents.on('will-navigate', (event, url) => {
    if (url.startsWith('http')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
});

// App quit events
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});



app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', async (event) => {
  if (isConnected) {
    event.preventDefault();
    await disconnectVPN();
    app.quit();
  }
});
