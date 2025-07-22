/*
  StealthLynk VPN Client - Renderer Process
  Rewritten for stability, clarity, and performance.
  This script manages all UI interactions, state, and communication with the main process.
*/

// Add CSS for server item animations (add/remove) and input field effects
const style = document.createElement('style');
style.textContent = `
  .server-item {
    transition: all 0.3s ease;
    opacity: 1;
    transform: translateX(0);
    max-height: 80px;
    overflow: hidden;
  }
  .server-item.removing {
    opacity: 0;
    transform: translateX(-20px);
    max-height: 0;
    margin: 0;
    padding: 0;
  }
  .server-item.new-server {
    transition: all 0.3s ease-out;
    border-left: 3px solid var(--primary-color);
  }
  
  /* Shake animation for empty input validation */
  @keyframes shake {
    0%, 100% { transform: translateX(0); }
    10%, 30%, 50%, 70%, 90% { transform: translateX(-5px); }
    20%, 40%, 60%, 80% { transform: translateX(5px); }
  }
  
  .shake {
    animation: shake 0.5s cubic-bezier(.36,.07,.19,.97) both;
    border-color: var(--error-color) !important;
  }
`;
document.head.appendChild(style);

document.addEventListener('DOMContentLoaded', () => {
  // --- Tab switching logic ---
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content'); // Only declared once at top scope
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const target = tab.getAttribute('data-tab');
      tabContents.forEach(tc => {
        if (tc.id === target) {
          tc.classList.add('active');
          tc.style.display = '';
        } else {
          tc.classList.remove('active');
          tc.style.display = 'none';
        }
      });
    });
  });
  // --- DOM ELEMENTS ---
  const connectButton = document.getElementById('connect-button');
  const connectButtonText = document.getElementById('connect-button-text');
  const connectionStatus = document.getElementById('connection-status');
  const currentIp = document.getElementById('current-ip');
  const connectionUptime = document.getElementById('connection-uptime');
  const uptimeLabel = document.getElementById('uptime-label');
  const activeServerName = document.getElementById('active-server-name');
  const activeServerDetails = document.getElementById('active-server-details');
  const serversList = document.getElementById('servers-list');
  const urlInput = document.getElementById('url-input');
  const addServerButton = document.getElementById('add-server-button');
  const scanQrButton = document.getElementById('scan-qr-button');
  const notification = document.getElementById('notification');
  const tabButtons = document.querySelectorAll('.tab');
  const qrModal = document.getElementById('qr-scanner-modal');
  const closeModal = document.querySelector('.close-modal');

  // --- STATE MANAGEMENT ---
  let state = {
    servers: [],
    activeServerId: null,
    isConnected: false,
    isConnecting: false,
    isDisconnecting: false, // Explicit state for disconnecting
    isSwitching: false, // Explicit state for server switching
    connectionStartTime: null,
    uptimeInterval: null,
    needsAutoReconnect: false, // Flag to indicate we need to auto-reconnect
  };

  // --- UI UPDATE FUNCTIONS ---

  /**
   * Updates the entire UI based on the current state.
   * This is the single source of truth for UI rendering.
   */
  function updateUI() {
    // Update Connection Button and Status by managing CSS classes.
    // The button text and color are handled by CSS pseudo-elements for reliability.
    if (state.isSwitching) {
      connectionStatus.textContent = 'Switching servers...';
      connectionStatus.className = 'status-value status-connecting';
      connectButton.className = 'connection-button connected'; // Keep green outline
      connectButton.disabled = true;
    } else if (state.isDisconnecting) {
      connectionStatus.textContent = 'Disconnecting...';
      connectionStatus.className = 'status-value status-disconnected';
      connectButton.className = 'connection-button disconnecting';
      connectButton.disabled = true;
    } else if (state.isConnecting) {
      connectionStatus.textContent = 'Connecting...';
      connectionStatus.className = 'status-value status-connecting';
      connectButton.className = 'connection-button connecting';
      connectButton.disabled = true;
    } else if (state.isConnected) {
      connectionStatus.textContent = 'Connected';
      connectionStatus.className = 'status-value status-connected';
      connectButton.className = 'connection-button connected';
      connectButton.disabled = false;
      startUptimeInterval();
    } else { // Disconnected
      connectionStatus.textContent = 'Disconnected';
      connectionStatus.className = 'status-value status-disconnected';
      connectButton.className = 'connection-button';
      connectButton.disabled = !state.activeServerId;
      stopUptimeInterval();
    }

    // Update Active Server Info Panel
    const activeServer = state.servers.find(s => s.id === state.activeServerId);
    if (activeServer) {
      activeServerName.textContent = activeServer.name;
      activeServerDetails.innerHTML = `
        <div class="detail-row"><span class="detail-label">Address:</span> ${escapeHtml(activeServer.address)}:${activeServer.port}</div>
        <div class="detail-row"><span class="detail-label">Protocol:</span> ${activeServer.protocol.toUpperCase()}</div>
        <div class="detail-row"><span class="detail-label">Location:</span> ${activeServer.flag || '🌐'} ${activeServer.countryName || 'Unknown'}</div>
      `;
    } else {
      activeServerName.textContent = 'No Server Selected';
      activeServerDetails.innerHTML = '<div class="detail-row">Please select a server to connect.</div>';
    }

    renderServersList();
  }

  // Keep track of the currently rendered server list to avoid unnecessary re-renders
  let lastRenderedServerList = [];
  let lastSmartConnectState = false;
  let lastHealthStatus = {}; // Track server health status
  
  // Set up more frequent health checks (every 5 seconds) for better responsiveness
  setInterval(() => renderServersList(true), 5000);
  
    async function renderServersList(forceUpdate = false, skipAutoReconnect = false) {
    if (state.servers.length === 0) {
      serversList.innerHTML = '<div class="server-item empty-message">No servers added.</div>';
      return;
    }
    
    // Check if Smart Connect is enabled
    const smartConnectEnabled = document.getElementById('auto-failover-toggle').checked;
    
    // Check if we need to update the server list
    const serversChanged = JSON.stringify(state.servers.map(s => s.id)) !== JSON.stringify(lastRenderedServerList.map(s => s.server.id));
    const smartConnectChanged = lastSmartConnectState !== smartConnectEnabled;
    
    // Always ping servers on forceUpdate or when servers/settings change
    if (serversChanged || smartConnectChanged || forceUpdate) {
      // 1. Ping all servers concurrently and get their health status - without showing loading message
      const pingPromises = state.servers.map(server =>
        window.electron.pingServer({ host: server.address, port: server.port })
          .then(ping => ({ server, ping }))
      );
      const serversWithPings = await Promise.all(pingPromises);
      
      // Check if health status has changed since last render
      const newHealthStatus = {};
      let healthChanged = false;
      
      serversWithPings.forEach(({ server, ping }) => {
        const isHealthy = ping !== null;
        newHealthStatus[server.id] = isHealthy;
        
        // Check if this server's health status has changed
        if (lastHealthStatus[server.id] !== undefined && 
            lastHealthStatus[server.id] !== isHealthy) {
          healthChanged = true;
          
          // If this is the currently active server becoming unhealthy AND
          // we're connected AND Smart Connect is enabled, immediately disconnect
          if (!isHealthy && server.id === state.activeServerId && state.isConnected && smartConnectEnabled) {
            console.log(`[Auto-Connect] Active server ${server.name} became unavailable, initiating immediate disconnect`);
            disconnect();
            state.needsAutoReconnect = true;
          }
        }
      });
      
      // 2. Sort servers only if Smart Connect is enabled
      if (smartConnectEnabled) {
        serversWithPings.sort((a, b) => {
          const aIsHealthy = a.ping !== null;
          const bIsHealthy = b.ping !== null;
          if (aIsHealthy && !bIsHealthy) return -1;
          if (!aIsHealthy && bIsHealthy) return 1;
          if (aIsHealthy && bIsHealthy) return a.ping - b.ping; // Healthies are sorted by best ping
          return 0;
        });
        
        // Important: Update the state.servers array to match the sorted order
        // This ensures that state.servers[0] is actually the best available server
        if (serversWithPings.length > 0) {
          state.servers = serversWithPings.map(item => item.server);
        }
        
        // If we need to auto-reconnect, connect to the first server in the sorted list
        if (state.needsAutoReconnect && serversWithPings.length > 0 && !skipAutoReconnect) {
          // Find the first healthy server in the sorted list
          const firstHealthyServer = serversWithPings.find(item => item.ping !== null);
          
          if (firstHealthyServer && firstHealthyServer.server.id !== state.activeServerId) {
            console.log(`[Auto-Connect] Connecting to best available server: ${firstHealthyServer.server.name}`);
            state.needsAutoReconnect = false;
            selectServer(firstHealthyServer.server.id, true); // true indicates auto-reconnect
          } else if (!firstHealthyServer) {
            console.log(`[Auto-Connect] No healthy servers available for auto-connection`);
            state.needsAutoReconnect = false;
          }
        }
      }
      
      // Save the current state to avoid unnecessary re-renders
      lastRenderedServerList = serversWithPings;
      lastSmartConnectState = smartConnectEnabled;
      lastHealthStatus = newHealthStatus;
      
      // Force render if health status changed to update dots and order
      forceUpdate = forceUpdate || healthChanged;
    }

    // 3. Only render the full list if we need to
    if (serversChanged || smartConnectChanged || forceUpdate) {
      // DOM diff approach: update, add, and remove only as needed
      const existingItems = Array.from(serversList.children).reduce((acc, el) => {
        if (el.id && el.id.startsWith('server-')) acc[el.id] = el;
        return acc;
      }, {});

      const nextIds = new Set();
      lastRenderedServerList.forEach(({ server, ping }) => {
        const id = `server-${server.id}`;
        nextIds.add(id);
        let serverItem = existingItems[id];
        const healthClass = ping !== null ? 'good' : 'poor';
        const isActive = server.id === state.activeServerId;
        const isActiveConnected = server.id === state.activeServerId && state.isConnected;
        // A. Create node if it's new (similar to Windows client)
        if (!serverItem) {
          serverItem = document.createElement('div');
          serverItem.id = id;
          // Set HTML structure only once on creation
          serverItem.innerHTML = `
            <div class="server-flag"></div>
            <div class="server-text">
              <div class="server-title"></div>
              <div class="server-address"></div>
            </div>
            <div class="server-actions">
              <div class="server-ping"><div class="ping-icon"></div></div>
              <div class="server-delete" title="Delete server">×</div>
            </div>
          `;
          // Attach listener only once on creation
          serverItem.addEventListener('click', () => selectServer(server.id));
          const deleteBtn = serverItem.querySelector('.server-delete');
          deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deleteServer(server.id);
          });
          serversList.appendChild(serverItem);
        }
        
        // B. Update the node's content in-place (like Windows client)
        serverItem.className = 'server-item' + (isActive ? ' active' : '');
        serverItem.querySelector('.server-flag').textContent = server.flag || '🌐';
        serverItem.querySelector('.server-title').textContent = escapeHtml(server.name);
        serverItem.querySelector('.server-address').textContent = `${escapeHtml(server.address)}:${server.port}`;
        serverItem.querySelector('.server-ping').className = `server-ping ${healthClass}`;
        
        // Handle delete button state
        const deleteBtn = serverItem.querySelector('.server-delete');
        if (isActiveConnected) {
          deleteBtn.classList.add('disabled');
          deleteBtn.title = 'Cannot delete active connected server';
          deleteBtn.style.pointerEvents = 'none';
          deleteBtn.style.opacity = '0.5';
        } else {
          deleteBtn.classList.remove('disabled');
          deleteBtn.title = 'Delete server';
          deleteBtn.style.pointerEvents = '';
          deleteBtn.style.opacity = '';
        }
      });
      // Remove items not in new list
      Object.keys(existingItems).forEach(id => {
        if (!nextIds.has(id)) serversList.removeChild(existingItems[id]);
      });

    } else {
      // Just update the active state without rebuilding the entire list
      document.querySelectorAll('.server-item').forEach(item => {
        if (item.id === `server-${state.activeServerId}`) {
          item.classList.add('active');
        } else {
          item.classList.remove('active');
        }
      });
    }
  }

  // --- CORE LOGIC ---

  async function connect() {
    // The guard prevents multiple connection attempts but allows reconnection during a server switch.
    if (state.isConnected || state.isConnecting || !state.activeServerId) return;
    
    // Check if the selected server is available before attempting to connect
    const serverElement = document.getElementById(`server-${state.activeServerId}`);
    if (serverElement) {
      const pingElement = serverElement.querySelector('.server-ping');
      if (pingElement && pingElement.classList.contains('poor')) {
        // Don't try to connect to unavailable servers
        showNotification('Cannot connect to unavailable server', 'error');
        
        // If Smart Connect is enabled, automatically select the best available server
        const smartConnectEnabled = document.getElementById('auto-failover-toggle').checked;
        if (smartConnectEnabled && state.servers.length > 0) {
          console.log(`[Auto-Connect] Finding best available server after connection attempt to unavailable server`);
          // Force a server list refresh to find the best server
          state.needsAutoReconnect = true;
          renderServersList(true);
          return;
        }
        return;
      }
    }

    state.isConnecting = true;
    updateUI();

    try {
      await window.api.connect();
    } catch (error) {
      console.error('Connect call failed:', error);
      state.isConnecting = false;
      showNotification(`Connection failed: ${error.message}`, 'error');
      updateUI();
    }
  }

  async function disconnect() {
    if (!state.isConnected || state.isDisconnecting) return;

    // For manual disconnects, give immediate feedback.
    if (!state.isSwitching) {
      state.isDisconnecting = true;
      updateUI();
    }

    try {
      await window.api.disconnect();
    } catch (error) {
      console.error('Disconnect call failed:', error);
      showNotification(`Disconnect failed: ${error.message}`, 'error');
      // Revert UI to connected state since disconnect failed
      state.isDisconnecting = false;
      updateUI();
    }
  }

  async function selectServer(serverId, isAutoReconnect = false) {
    if (serverId === state.activeServerId) {
      if (!isAutoReconnect) { // Only show for manual operations
        showNotification('This server is already selected.', 'info');
      }
      return;
    }

    const wasConnected = state.isConnected;
    state.activeServerId = serverId;

    // Update the active server visually without re-rendering the entire list
    const oldActiveElement = document.querySelector('.server-item.active');
    if (oldActiveElement) oldActiveElement.classList.remove('active');
    const newActiveElement = document.getElementById(`server-${serverId}`);
    if (newActiveElement) {
        newActiveElement.classList.add('active');
        newActiveElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    
    // Only update the server in the backend, don't re-render UI
    await window.api.setActiveServer(serverId);
    
    // Only update active server info in UI, but don't re-render server list
    const activeServer = state.servers.find(s => s.id === state.activeServerId);
    if (activeServer) {
      activeServerName.textContent = activeServer.name;
      activeServerDetails.innerHTML = `
        <div class="detail-row"><span class="detail-label">Address:</span> ${escapeHtml(activeServer.address)}:${activeServer.port}</div>
        <div class="detail-row"><span class="detail-label">Protocol:</span> ${activeServer.protocol.toUpperCase()}</div>
        <div class="detail-row"><span class="detail-label">Location:</span> ${activeServer.flag || '🌐'} ${activeServer.countryName || 'Unknown'}</div>
      `;
    }
    
    if (wasConnected) {
      state.isSwitching = true;
      
      // Update only the connection status part of the UI
      connectionStatus.textContent = isAutoReconnect ? 'Auto-switching servers...' : 'Switching servers...';
      connectionStatus.className = 'status-value status-connecting';
      connectButton.disabled = true;
      
      await disconnect();
    } else {
      // Check if the server is healthy before attempting to connect
      const serverElement = document.getElementById(`server-${serverId}`);
      if (serverElement) {
        const pingElement = serverElement.querySelector('.server-ping');
        if (pingElement && !pingElement.classList.contains('poor')) {
          // Only connect if the server is available (not marked with red dot)
          connect();
        } else {
          showNotification('Cannot connect to unavailable server', 'error');
        }
      } else {
        // If we can't find the server element for some reason, still try to connect
        connect();
      }
    }
  }

  // Helper function to parse VLESS URL into server object
  function parseVlessUrl(url) {
    try {
      const vlessRegex = /vless:\/\/([^@]+)@([^:]+):([0-9]+)\?([^#]+)(#(.+))?/;
      const match = url.match(vlessRegex);
      
      if (!match) return null;
      
      const [, id, address, port, params, , name] = match;
      const decodedName = name ? decodeURIComponent(name) : `Server ${address}:${port}`;
      
      // Create a temporary id (will be replaced by backend response)
      const tempId = `temp-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      
      return {
        id: tempId,
        name: decodedName,
        address: address,
        port: parseInt(port),
        protocol: 'vless',
        flag: '🌐', // Default flag until geo is resolved
        countryName: 'Detecting...',
        uuid: id
      };
    } catch (e) {
      console.error('Failed to parse VLESS URL:', e);
      return null;
    }
  }
  
  async function addServer(url) {
    if (!url || !url.startsWith('vless://')) {
      showNotification('Please enter a valid VLESS URL.', 'error');
      return;
    }

    // Show a notification that we are adding the server
    showNotification('Adding server...', 'info');
    if (urlInput) urlInput.value = '';

    try {
      // Call the API to add the server. The UI will be updated via the onServersUpdated event.
      const result = await window.api.addServer(url);
      
      if (result.success) {
        showNotification('Server added successfully.', 'success');
        // Immediately select and connect to the new server
        const newServer = result.server;
        if (newServer && newServer.id) {
          await selectServer(newServer.id);
          await connect();
        }
      } else {
        showNotification(result.message, 'error');
      }
    } catch (error) {
      showNotification(`Error adding server: ${error.message}`, 'error');
    }
  }

  async function deleteServer(serverId) {
    // Remove from UI for responsiveness
    const serverElement = document.getElementById(`server-${serverId}`);
    if (serverElement) {
      serverElement.classList.add('removing');
      setTimeout(() => {
        if (serverElement.parentNode) serverElement.parentNode.removeChild(serverElement);
      }, 300);
    }

    // Remove from local state (for instant UI)
    state.servers = state.servers.filter(server => server.id !== serverId);

    try {
      const result = await window.api.deleteServer(serverId);
      if (!result.success) {
        // If backend refused (e.g. tried to delete active server), restore list
        showNotification(result.message || 'Failed to delete server.', 'error');
        await loadInitialData();
        return;
      }
      showNotification('Server deleted.', 'success');

      // Only clear active state if we deleted the active server
      if (state.activeServerId === serverId) {
        state.activeServerId = null;
        updateUI(); // Only update connection UI if needed
      } else {
        // For all other deletions, only update the server list
        renderServersList(true);
      }
    } catch (error) {
      showNotification(`Error deleting server: ${error.message}`, 'error');
      await loadInitialData();
    }
  }



  // --- UPTIME & HELPERS ---

  function startUptimeInterval() {
    if (state.uptimeInterval) return;
    state.connectionStartTime = state.connectionStartTime || Date.now();
    updateUptime();
    state.uptimeInterval = setInterval(updateUptime, 1000);
  }

  function stopUptimeInterval() {
    clearInterval(state.uptimeInterval);
    state.uptimeInterval = null;
    state.connectionStartTime = null;
    connectionUptime.textContent = '--:--:--';
    uptimeLabel.style.display = 'none';
  }

  function updateUptime() {
    if (!state.connectionStartTime) return;
    const uptime = Date.now() - state.connectionStartTime;
    const hours = String(Math.floor(uptime / 3600000)).padStart(2, '0');
    const minutes = String(Math.floor((uptime % 3600000) / 60000)).padStart(2, '0');
    const seconds = String(Math.floor((uptime % 60000) / 1000)).padStart(2, '0');
    connectionUptime.textContent = `${hours}:${minutes}:${seconds}`;
    uptimeLabel.style.display = 'inline';
    connectionUptime.style.display = 'inline';
  }

  function showNotification(message, type = 'info') {
  // Notifications are disabled by user request
  return;

    notification.textContent = message;
    notification.className = `notification show ${type}`;
    setTimeout(() => {
      notification.classList.remove('show');
    }, 3000);
  }

  function escapeHtml(unsafe) {
    return unsafe
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // --- IPC EVENT HANDLERS ---

  window.api.onConnectionSuccess((data) => {
    console.log('IPC: onConnectionSuccess', data);
    state.isConnected = true;
    state.isConnecting = false;
    state.isSwitching = false;
    state.connectionStartTime = Date.now();
    // Show actual VPN exit IP country as Current Location
    currentIp.textContent = 'Detecting...';
    fetch('https://ipinfo.io/json')
      .then(res => res.json())
      .then(ipData => {
        if (ipData && ipData.country) {
          // Request the full country name from the main process
          window.api.getCountryName(ipData.country)
            .then(countryName => {
              currentIp.textContent = countryName || ipData.country;
            })
            .catch(() => {
              currentIp.textContent = ipData.country;
            });
        } else {
          currentIp.textContent = 'Unknown';
        }
      })
      .catch(() => {
        currentIp.textContent = 'Unknown';
      });

    // Update server list from the payload to ensure flags are shown
    if (data.servers) {
      state.servers = data.servers.servers || [];
      state.activeServerId = data.servers.activeServer;
    }

    updateUI();
});

window.api.onServersUpdated((data) => {
    console.log('IPC: onServersUpdated', data);
    state.servers = data.servers;
    state.activeServerId = data.activeServer;
    updateUI(); // Ensure full UI update, including active server display
});

window.api.onDisconnect(async () => {
    console.log('IPC: onDisconnect');

    // Keep the 'disconnecting' UI visible for a short period to match visual feedback.
    setTimeout(async () => {
        state.isConnected = false;
        state.isConnecting = false;
        state.isDisconnecting = false;

        // Show country name of the active server (or 'Unknown') when disconnected
        const activeServer = state.servers.find(s => s.id === state.activeServerId);
        currentIp.textContent = (activeServer && activeServer.countryName) ? activeServer.countryName : 'Unknown';

        if (state.isSwitching) {
            // If switching, the disconnect is expected. Now, connect to the new server.
            await connect();
            state.isSwitching = false; // Reset switching state
        } else {
            // This was a manual disconnect, so just update the UI.
            updateUI();
        }
    }, 500); // 500ms delay
});

  window.api.onConnectionError((error) => {
    console.log(`IPC: onConnectionError - ${error.message}`);
    state.isConnected = false;
    state.isConnecting = false;
    state.isDisconnecting = false;
    if (!state.isSwitching) {
      showNotification(`Connection failed: ${error.message}`, 'error');
    }
    state.isSwitching = false;
    updateUI();
  });

  // --- INITIALIZATION ---

  async function loadInitialData() {
    try {
      const serverData = await window.api.getServers();
      state.servers = serverData.servers || [];
      state.activeServerId = serverData.activeServer;

      const status = await window.api.getStatus();
      state.isConnected = status.isConnected;
      currentIp.textContent = status.currentIp || status.originalIp || 'N/A';
      
      if (state.isConnected) {
        state.connectionStartTime = status.connectionStartTime;
      }

      if (!state.activeServerId && state.servers.length > 0) {
        state.activeServerId = state.servers[0].id;
        await window.api.setActiveServer(state.activeServerId);
      }

      updateUI();
    } catch (error) {
      console.error('Failed to load initial data:', error);
      showNotification('Could not load app data.', 'error');
    }
  }

  // --- EVENT LISTENERS ---

  // Smart Connect (auto-failover) toggle handler
  const autoFailoverToggle = document.getElementById('auto-failover-toggle');
  if (autoFailoverToggle) {
    // Initialize the toggle's state from the main process on load to prevent race conditions
    window.api.getAutoFailoverStatus().then(status => {
      if (status) {
        autoFailoverToggle.checked = status.enabled;
      }
    }).catch(err => console.error('Failed to get initial auto-failover status:', err));

    // Send updates to the main process when the user clicks the toggle
    autoFailoverToggle.addEventListener('change', () => {
      const isEnabled = autoFailoverToggle.checked;
      window.api.setAutoFailover(isEnabled);
    });
  }
  connectButton.addEventListener('click', () => {
    if (state.isConnected) {
      disconnect();
    } else {
      connect();
    }
  });

  // Create enhanced server add button handler with visual feedback
  addServerButton.addEventListener('click', () => {
    if (urlInput.value.trim()) {
      addServer(urlInput.value.trim());
    } else {
      // Shake animation for empty input
      urlInput.classList.add('shake');
      setTimeout(() => urlInput.classList.remove('shake'), 500);
      urlInput.focus();
    }
  });

  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      tabButtons.forEach(btn => btn.classList.remove('active'));
      button.classList.add('active');
      const tabId = button.getAttribute('data-tab');
      tabContents.forEach(content => content.classList.remove('active'));
      document.getElementById(tabId).classList.add('active');
    });
  });

  // --- QR CODE SCANNING ---

  let qrScanState = {
    scanning: false,
    animationFrameId: null,
  };

  // Function to close the QR scanner modal and stop the camera
  function closeQrModal() {
    const qrModal = document.getElementById('qr-scanner-modal');
    const video = document.getElementById('qr-scanner-video');

    // Stop scanning loop
    if (qrScanState.animationFrameId) {
      cancelAnimationFrame(qrScanState.animationFrameId);
    }
    qrScanState.scanning = false;

    // Stop camera stream if active
    if (video && video.srcObject) {
      const tracks = video.srcObject.getTracks();
      tracks.forEach(track => track.stop());
      video.srcObject = null;
    }

    qrModal.style.display = 'none';
  }

  // Open modal and start camera when QR button is clicked
  document.getElementById('scan-qr-button').addEventListener('click', async () => {
    const qrModal = document.getElementById('qr-scanner-modal');
    const video = document.getElementById('qr-scanner-video');
    const loadingMessage = document.getElementById('qr-loading-message');
    const scanResult = document.getElementById('qr-scan-result');
    const canvas = document.getElementById('qr-canvas');
    const canvasContext = canvas.getContext('2d');

    qrModal.style.display = 'flex';
    loadingMessage.textContent = 'Requesting camera access...';
    loadingMessage.style.display = 'block';
    scanResult.style.display = 'none';

    try {
      // More specific camera constraints for Intel Macs running Big Sur
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        }
      });

      video.srcObject = stream;
      await video.play();

      loadingMessage.style.display = 'none';
      qrScanState.scanning = true;
      scanQRCode(); // Start the scan loop

    } catch (err) {
      console.error('Camera access error:', err);
      loadingMessage.textContent = 'Could not access camera. Please grant permission.';
    }

    function scanQRCode() {
      if (!qrScanState.scanning) return;

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        const videoWidth = video.videoWidth;
        const videoHeight = video.videoHeight;
        
        canvas.width = videoWidth;
        canvas.height = videoHeight;

        canvasContext.drawImage(video, 0, 0, videoWidth, videoHeight);
        
        const imageData = canvasContext.getImageData(0, 0, videoWidth, videoHeight);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });

        if (code) {
          qrScanState.scanning = false; // Stop scanning
          handleQrCodeResult(code.data);
        } else {
          qrScanState.animationFrameId = requestAnimationFrame(scanQRCode);
        }
      } else {
        qrScanState.animationFrameId = requestAnimationFrame(scanQRCode);
      }
    }
  });

  // Handle the detected QR code data
  function handleQrCodeResult(data) {
    const scanResult = document.getElementById('qr-scan-result');
    if (data && data.startsWith('vless://')) {
      scanResult.textContent = 'VLESS URL detected! Adding server...';
      scanResult.className = 'success';
      scanResult.style.display = 'block';

      addServer(data);
      setTimeout(closeQrModal, 1500);
    } else {
      scanResult.textContent = 'Invalid QR code. Please scan a VLESS URL.';
      scanResult.className = 'error';
      scanResult.style.display = 'block';
      
      // Resume scanning after a delay
      setTimeout(() => {
        if (document.getElementById('qr-scanner-modal').style.display !== 'none') {
            scanResult.style.display = 'none';
            qrScanState.scanning = true;
            requestAnimationFrame(scanQRCode); // Restart the scan loop
        }
      }, 2500);
    }
  }

  // Close modal when 'X' is clicked
  document.querySelector('.close-modal').addEventListener('click', closeQrModal);

  // --- QR CODE SCANNING FROM FILE ---
  document.getElementById('qr-file-input').addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.getElementById('qr-canvas');
        const context = canvas.getContext('2d');
        
        canvas.width = img.width;
        canvas.height = img.height;
        
        context.drawImage(img, 0, 0, img.width, img.height);
        
        const imageData = context.getImageData(0, 0, img.width, img.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert',
        });

        if (code) {
          // A QR code was found, handle it
          closeQrModal(); // Close the modal first
          handleQrCodeResult(code.data);
        } else {
          // No QR code found in the image
          const scanResult = document.getElementById('qr-scan-result');
          scanResult.textContent = 'No QR code found in the image.';
          scanResult.className = 'error';
          scanResult.style.display = 'block';
          // No need to hide it immediately, let the user see the message
        }
      };
      img.onerror = () => {
        const scanResult = document.getElementById('qr-scan-result');
        scanResult.textContent = 'Could not load the selected file as an image.';
        scanResult.className = 'error';
        scanResult.style.display = 'block';
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
    
    // Reset the input value to allow scanning the same file again if needed
    event.target.value = '';
  });

  // --- KICKSTART ---
  loadInitialData();
});
