const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Network monitoring functionality for StealthLynk VPN
 * Enables automatic failover to fastest available server
 */
class NetworkMonitor {
  constructor() {
    this.pingIntervalMs = 2500; // Time between connection checks
    this.failedPingThreshold = 3; // Reconnect after 3 failed checks
    this.monitoringInterval = null; // Holds the setInterval timer
    this.failedPings = 0;
    this.isMonitoring = false;
    this.onConnectionFailed = null;
    this.onConnectionSuccess = null;
    this.autoFailover = true;

    this.originalIP = null; // User's IP before connecting
    this.currentIP = null; // Expected VPN IP
    this.serverLatencies = {}; // Cache for server ping times
  }

  /**
   * Start monitoring the current connection
   * @param {string} targetIP - IP to monitor
   * @param {Function} failureCallback - Called when connection fails
   */
  async startMonitoring(targetIP, failureCallback, successCallback = null) {
    if (this.isMonitoring) {
      this.stopMonitoring();
    }

    this.currentIP = targetIP;
    this.onConnectionFailed = failureCallback;
    this.onConnectionSuccess = successCallback;
    this.failedPings = 0;
    this.isMonitoring = true;
    
    // Ensure we have originalIP set to avoid repeated 'not set' messages
    if (!this.originalIP) {
      this.originalIP = "initialized";
    }

    console.log(`[NetworkMonitor] Started monitoring connection to ${targetIP}`);
    this.monitoringInterval = setInterval(() => this.pingConnection(), this.pingIntervalMs);

    return true;
  }
  
  /**
   * Stop connection monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    this.failedPings = 0;
    console.log('[NetworkMonitor] Stopped monitoring');
  }
  
  /**
   * Enable or disable automatic failover
   */
  setAutoFailover(enabled) {
    this.autoFailover = enabled;
    console.log(`[NetworkMonitor] Auto failover ${enabled ? 'enabled' : 'disabled'}`);
    return this.autoFailover;
  }
  

  
  /**
   * Set the original non-VPN IP for comparison
   */
  setOriginalIP(ip) {
    this.originalIP = ip;
    console.log(`[NetworkMonitor] Original IP set to ${ip}`);
  }
  
  /**
   * Test connection by pinging the current IP
   */
  async _getPublicIp() {
    const services = [
      'https://api.ipify.org',
      'https://ifconfig.me/ip',
      'https://icanhazip.com',
      'https://ipinfo.io/ip'
    ];
    const agent = new SocksProxyAgent('socks5://127.0.0.1:10808');

    for (const service of services) {
      try {
        const response = await axios.get(service, {
          httpsAgent: agent,
          timeout: 5000, // 5-second timeout per service
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        if (response.data && typeof response.data === 'string') {
          const ip = response.data.trim();
          console.log(`[NetworkMonitor] Detected public IP: ${ip} via ${service}`);
          return ip;
        }
      } catch (error) {
        console.warn(`[NetworkMonitor] Service ${service} failed: ${error.message}`);
      }
    }
    throw new Error('All IP detection services failed.');
  }

  async pingConnection() {
    if (!this.isMonitoring || !this.autoFailover) {
      return;
    }

    try {
      const detectedIp = await this._getPublicIp();
      
      // Skip the auto-setting of currentIP - we want to compare against what was initially set in startMonitoring
      if (!this.originalIP) {
        console.log(`[NetworkMonitor] Setting originalIP initialized flag`);
        this.originalIP = "initialized"; // Just mark as initialized to prevent repetitive messages
      }

      // Log the actual validation attempt
      console.log(`[NetworkMonitor] Validating detected IP ${detectedIp} against expected ${this.currentIP}`);
      
      // Check against the expected VPN IP (currentIP) instead of comparing against originalIP
      if (detectedIp && (detectedIp === this.currentIP)) {
        // We're still connected to the expected VPN IP
        this.failedPings = 0;
        console.log(`[NetworkMonitor] Connection validated: IP ${detectedIp} matches expected ${this.currentIP}`);
        if (this.onConnectionSuccess) {
          this.onConnectionSuccess(detectedIp);
        }
      } else {
        console.warn(`[NetworkMonitor] IP mismatch. Detected: ${detectedIp}, Expected: ${this.currentIP}`);
        this.failedPings++;
      }
    } catch (error) {
      console.error(`[NetworkMonitor] Ping failed: ${error.message}`);
      this.failedPings++;
    }

    if (this.failedPings >= this.failedPingThreshold) {
      console.error(`[NetworkMonitor] Connection failed after ${this.failedPings} checks.`);
      if (this.onConnectionFailed) {
        this.onConnectionFailed();
      }
      this.failedPings = 0; // Reset after triggering failover
    }
  }
  
  /**
   * Find the fastest server from a list of servers
   * @param {Array} servers - List of server objects
   * @returns {Object} Fastest server or null
   */
  async findFastestServer(servers) {
    const rankedServers = await this.getRankedServers(servers);
    return rankedServers.length > 0 ? rankedServers[0] : null;
  }

  /**
   * Ranks servers by latency.
   * @param {Array} servers - List of server objects.
   * @returns {Array} A sorted list of server objects that responded, ranked by latency.
   */
  async getRankedServers(servers) {
    if (!servers || !servers.length) {
      return [];
    }

    console.log(`[NetworkMonitor] Ranking ${servers.length} servers by latency...`);

    const latencyPromises = servers.map(async (server) => {
      let latency;
      let cached = false;
      try {
        const cachedLatency = this.serverLatencies[server.id];
        const isCacheValid = cachedLatency && (Date.now() - cachedLatency.timestamp < 5 * 60 * 1000);

        if (isCacheValid) {
          latency = cachedLatency.value;
          cached = true;
        } else {
          latency = await this.measureServerLatency(server);
          this.serverLatencies[server.id] = { value: latency, timestamp: Date.now() };
        }
      } catch (error) {
        console.error(`[NetworkMonitor] Error measuring latency for ${server.name}:`, error.message);
        latency = 9999;
      }
      return { server, latency, cached };
    });

    const results = await Promise.all(latencyPromises);

    // Sort by latency (lowest first)
    results.sort((a, b) => a.latency - b.latency);

    console.log('[NetworkMonitor] Server latencies:',
      results.map(r => `${r.server.name}: ${r.latency}ms${r.cached ? ' (cached)' : ''}`).join(', '));

    // Return only the server objects, sorted, and filter out failed ones.
    return results.filter(r => r.latency < 9999).map(r => r.server);
  }
  
  /**
   * Measure latency to a server
   * @param {Object} server - Server object
   * @returns {Number} Latency in milliseconds
   */
  async measureServerLatency(server) {
    const host = server.address;
    // Using the system's ping command is a fallback. A dedicated library like 'ping' would be more robust.
    const command = process.platform === 'win32' ? `ping -n 3 ${host}` : `ping -c 3 -i 0.2 ${host}`;

    try {
      const { stdout } = await execAsync(command, { timeout: 5000 });
      // Universal regex to capture average latency from ping stats
      const match = stdout.match(/Average = (\d+)ms|avg=([0-9.]+)/);
      
      if (match) {
        // match[1] is for Windows, match[2] is for macOS/Linux
        return parseFloat(match[1] || match[2]);
      }
    } catch (error) {
      console.error(`[NetworkMonitor] Failed to measure latency for ${host}: ${error.message}`);
    }
    return 9999; // Return a high latency on failure
  }
}

module.exports = new NetworkMonitor();
