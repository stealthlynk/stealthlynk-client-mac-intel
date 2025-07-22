const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

// Paths
const serversPath = path.join(
  process.env.APPDATA ||
    (process.platform === 'darwin'
      ? process.env.HOME + '/Library/Application Support/StealthLynk-Client'
      : process.env.HOME + '/.config/StealthLynk-Client'),
  'servers.json'
);

// Generate UUID 
function generateUUID() {
  return crypto.randomUUID();
}

// Load servers
function loadServers() {
  try {
    if (fs.existsSync(serversPath)) {
      const data = fs.readFileSync(serversPath, 'utf8');
      const servers = JSON.parse(data);
      return servers;
    }
    
    // If file doesn't exist, create default structure
    const defaultData = { servers: [], activeServer: '' };
    fs.mkdirSync(path.dirname(serversPath), { recursive: true });
    fs.writeFileSync(serversPath, JSON.stringify(defaultData, null, 2));
    return defaultData;
  } catch (error) {
    console.error('Error loading servers:', error);
    return { servers: [], activeServer: '' };
  }
}

// Save servers
function saveServers(data) {
  try {
    fs.mkdirSync(path.dirname(serversPath), { recursive: true });
    fs.writeFileSync(serversPath, JSON.stringify(data, null, 2));
    return { success: true };
  } catch (error) {
    console.error('Error saving servers:', error);
    return { success: false, error: error.message };
  }
}

// Parse VLESS URL
async function parseVLESSUrl(vlessUrl) {
  try {
    // Clean up the URL
    vlessUrl = vlessUrl.trim().replace(/[\r\n]/g, '');
    console.log(`Parsing VLESS URL: ${vlessUrl.substring(0, 30)}...`);
    
    // Extract basic components with regex
    const basicRegex = /^vless:\/\/([^@]+)@([^:]+):(\d+)/;
    const basicMatch = vlessUrl.match(basicRegex);
    
    if (!basicMatch) {
      throw new Error('Invalid VLESS URL format');
    }
    
    const [, id, add, port] = basicMatch;
    
    // Extract query parameters and remark
    let queryString = '';
    let remark = '';
    
    // Find the query string part
    const queryStart = vlessUrl.indexOf('?', basicMatch[0].length);
    if (queryStart !== -1) {
      // Find the remark part
      const remarkStart = vlessUrl.indexOf('#', queryStart);
      if (remarkStart !== -1) {
        queryString = vlessUrl.substring(queryStart, remarkStart);
        remark = vlessUrl.substring(remarkStart + 1);
      } else {
        queryString = vlessUrl.substring(queryStart);
      }
    } else {
      // Check for remark without query
      const remarkStart = vlessUrl.indexOf('#', basicMatch[0].length);
      if (remarkStart !== -1) {
        remark = vlessUrl.substring(remarkStart + 1);
      }
    }
    
    // Parse query parameters
    const params = new URLSearchParams(queryString.startsWith('?') ? queryString.substring(1) : queryString);
    
    // Create the base config
    const vlessConfig = {
      id, // User ID
      add, // Address/hostname
      port: parseInt(port, 10),
      type: params.get('type') || 'tcp', // Connection type
      encryption: params.get('encryption') || 'none', // Encryption method
      protocol: 'vless', // Protocol identifier
      ps: decodeURIComponent(remark || `Server ${add}:${port}`), // Server name from remark
      net: params.get('type') || 'tcp', // Network type
      tls: params.has('security') ? params.get('security') : params.has('tls') ? 'tls' : 'none', // TLS setting
      sni: params.get('sni') || params.get('host') || '', // SNI value
      fp: params.get('fp') || 'chrome', // TLS fingerprint
      path: params.get('path') || '/', // Path value
      peer: params.get('peer') || '', // Server name for TLS
      flow: params.get('flow') || '' // Flow setting for XTLS Vision
    };
    
    // Handle Reality protocol
    if (vlessConfig.tls === "reality" || 
        (params.has('security') && params.get('security') === 'reality') ||
        (params.has('pbk') && params.has('sid')) ||
        (params.has('pbk') && params.has('tls'))) {
      
      console.log('Detected Reality protocol configuration');
      vlessConfig.tls = 'reality';
      vlessConfig.pbk = params.get('pbk') || '';
      vlessConfig.sid = params.get('sid') || '';
      vlessConfig.spx = params.get('spx') || '/';
      if (params.has('peer')) {
        vlessConfig.serverName = params.get('peer');
      }
    }
    
    // Create server object - we'll detect country upon connection, not at server add time
    const server = {
      id: generateUUID(),
      protocol: 'vless',
      name: vlessConfig.ps || `${add}:${port}`,
      address: add,
      port: parseInt(port, 10),
      countryCode: '',
      countryName: '',
      flag: '🌐',
      rawConfig: vlessConfig,
      addedAt: new Date().toISOString()
    };
    
    return server;
  } catch (error) {
    console.error('Error parsing VLESS URL:', error);
    throw error;
  }
}

// Generate Xray config for a server
function generateXrayConfig(server, socksPort, httpPort) {
  console.log('Generating Xray config for server:', server.name);
  
  // Base configuration
  const config = {
    "log": {
      "loglevel": "debug",
      "access": path.join(os.tmpdir(), "xray_access.log"),
      "error": path.join(os.tmpdir(), "xray_error.log")
    },
    "dns": {
      "servers": [
        "https://dns.google/dns-query",
        {
          "address": "1.1.1.1",
          "port": 53,
          "domains": ["geosite:tld-!cn"]
        }
      ],
      "queryStrategy": "UseIP",
      "disableIPv6": true
    },
    "inbounds": [
      {
        "port": socksPort,
        "listen": "127.0.0.1",
        "protocol": "socks",
        "settings": {
          "udp": true,
          "auth": "noauth"
        },
        "sniffing": {
          "enabled": true,
          "destOverride": ["http", "tls"]
        }
      },
      {
        "port": httpPort,
        "listen": "127.0.0.1",
        "protocol": "http",
        "settings": {
          "timeout": 0
        }
      }
    ],
    "outbounds": [
      {
        "protocol": "vless",
        "settings": {
          "vnext": [
            {
              "address": server.rawConfig.add,
              "port": parseInt(server.rawConfig.port),
              "users": [
                {
                  "id": server.rawConfig.id,
                  "encryption": server.rawConfig.encryption || "none",
                  "flow": server.rawConfig.flow || ""
                }
              ]
            }
          ]
        },
        "streamSettings": {
          "network": server.rawConfig.net || "tcp",
          "security": server.rawConfig.tls || "none",
          "sockopt": {
            "tcpFastOpen": true,
            "tcpKeepAliveInterval": 60,
            "tcpCongestion": "bbr",
            "tcpNoDelay": true
          }
        },
        "tag": "proxy"
      },
      {
        "protocol": "freedom",
        "settings": {},
        "tag": "direct"
      }
    ],
    "routing": {
      "domainStrategy": "IPIfNonMatch",
      "rules": [
        {
          "type": "field",
          "outboundTag": "block",
          "domain": ["geosite:category-ads-all"],
          "protocol": ["bittorrent"]
        },
        {
          "type": "field",
          "outboundTag": "direct",
          "domain": ["geosite:private"]
        },
        {
          "type": "field",
          "outboundTag": "direct",
          "ip": ["geoip:private", "geoip:cn"]
        },
        {
            "type": "field",
            "outboundTag": "block",
            "ip": ["::/0"]
        },
        {
          "type": "field",
          "outboundTag": "proxy",
          "network": "tcp,udp"
        }
      ]
    }
  };
  
  // Configure stream settings for Reality
  if (server.rawConfig.tls === "reality" || (server.rawConfig.tls === "tls" && server.rawConfig.pbk)) {
    console.log('Generating Xray config with Reality protocol settings');
    
    // Set security to reality for Reality configurations
    config.outbounds[0].streamSettings.security = "reality";
    config.outbounds[0].streamSettings.realitySettings = {
      "show": false,
      "serverName": server.rawConfig.sni || server.rawConfig.serverName || server.rawConfig.peer || "www.cloudflare.com",
      "fingerprint": server.rawConfig.fp || "chrome",
      "publicKey": server.rawConfig.pbk || "",
      "shortId": server.rawConfig.sid || "",
      "spiderX": server.rawConfig.spx || "/"
    };
    
    // Set flow to xtls-rprx-vision for Reality which is required for proper operation
    config.outbounds[0].settings.vnext[0].users[0].flow = server.rawConfig.flow || "xtls-rprx-vision";
  } else if (server.rawConfig.tls === "tls") {
    config.outbounds[0].streamSettings.security = "tls";
    config.outbounds[0].streamSettings.tlsSettings = {
      "serverName": server.rawConfig.sni || server.rawConfig.add,
      "fingerprint": server.rawCfig.fp || "chrome"
    };
  }
  
  return config;
}

// Helper functions for country info
function getCountryName(code) {
  const countries = {
    "AD": "Andorra",
    "AE": "United Arab Emirates",
    "AF": "Afghanistan",
    "AG": "Antigua and Barbuda",
    "AI": "Anguilla",
    "AL": "Albania",
    "AM": "Armenia",
    "AO": "Angola",
    "AQ": "Antarctica",
    "AR": "Argentina",
    "AS": "American Samoa",
    "AT": "Austria",
    "AU": "Australia",
    "AW": "Aruba",
    "AX": "Åland Islands",
    "AZ": "Azerbaijan",
    "BA": "Bosnia and Herzegovina",
    "BB": "Barbados",
    "BD": "Bangladesh",
    "BE": "Belgium",
    "BF": "Burkina Faso",
    "BG": "Bulgaria",
    "BH": "Bahrain",
    "BI": "Burundi",
    "BJ": "Benin",
    "BL": "Saint Barthélemy",
    "BM": "Bermuda",
    "BN": "Brunei",
    "BO": "Bolivia",
    "BQ": "Caribbean Netherlands",
    "BR": "Brazil",
    "BS": "Bahamas",
    "BT": "Bhutan",
    "BV": "Bouvet Island",
    "BW": "Botswana",
    "BY": "Belarus",
    "BZ": "Belize",
    "CA": "Canada",
    "CC": "Cocos (Keeling) Islands",
    "CD": "Congo (DRC)",
    "CF": "Central African Republic",
    "CG": "Congo (Republic)",
    "CH": "Switzerland",
    "CI": "Côte d’Ivoire",
    "CK": "Cook Islands",
    "CL": "Chile",
    "CM": "Cameroon",
    "CN": "China",
    "CO": "Colombia",
    "CR": "Costa Rica",
    "CU": "Cuba",
    "CV": "Cabo Verde",
    "CW": "Curaçao",
    "CX": "Christmas Island",
    "CY": "Cyprus",
    "CZ": "Czechia",
    "DE": "Germany",
    "DJ": "Djibouti",
    "DK": "Denmark",
    "DM": "Dominica",
    "DO": "Dominican Republic",
    "DZ": "Algeria",
    "EC": "Ecuador",
    "EE": "Estonia",
    "EG": "Egypt",
    "EH": "Western Sahara",
    "ER": "Eritrea",
    "ES": "Spain",
    "ET": "Ethiopia",
    "FI": "Finland",
    "FJ": "Fiji",
    "FM": "Micronesia",
    "FO": "Faroe Islands",
    "FR": "France",
    "GA": "Gabon",
    "GB": "United Kingdom",
    "GD": "Grenada",
    "GE": "Georgia",
    "GF": "French Guiana",
    "GG": "Guernsey",
    "GH": "Ghana",
    "GI": "Gibraltar",
    "GL": "Greenland",
    "GM": "Gambia",
    "GN": "Guinea",
    "GP": "Guadeloupe",
    "GQ": "Equatorial Guinea",
    "GR": "Greece",
    "GT": "Guatemala",
    "GU": "Guam",
    "GW": "Guinea-Bissau",
    "GY": "Guyana",
    "HK": "Hong Kong",
    "HM": "Heard & McDonald Islands",
    "HN": "Honduras",
    "HR": "Croatia",
    "HT": "Haiti",
    "HU": "Hungary",
    "ID": "Indonesia",
    "IE": "Ireland",
    "IL": "Israel",
    "IM": "Isle of Man",
    "IN": "India",
    "IO": "British Indian Ocean Territory",
    "IQ": "Iraq",
    "IR": "Iran",
    "IS": "Iceland",
    "IT": "Italy",
    "JE": "Jersey",
    "JM": "Jamaica",
    "JO": "Jordan",
    "JP": "Japan",
    "KE": "Kenya",
    "KG": "Kyrgyzstan",
    "KH": "Cambodia",
    "KI": "Kiribati",
    "KM": "Comoros",
    "KN": "Saint Kitts and Nevis",
    "KP": "North Korea",
    "KR": "South Korea",
    "KW": "Kuwait",
    "KY": "Cayman Islands",
    "KZ": "Kazakhstan",
    "LA": "Laos",
    "LB": "Lebanon",
    "LC": "Saint Lucia",
    "LI": "Liechtenstein",
    "LK": "Sri Lanka",
    "LR": "Liberia",
    "LS": "Lesotho",
    "LT": "Lithuania",
    "LU": "Luxembourg",
    "LV": "Latvia",
    "LY": "Libya",
    "MA": "Morocco",
    "MC": "Monaco",
    "MD": "Moldova",
    "ME": "Montenegro",
    "MF": "Saint Martin",
    "MG": "Madagascar",
    "MH": "Marshall Islands",
    "MK": "North Macedonia",
    "ML": "Mali",
    "MM": "Myanmar",
    "MN": "Mongolia",
    "MO": "Macao",
    "MP": "Northern Mariana Islands",
    "MQ": "Martinique",
    "MR": "Mauritania",
    "MS": "Montserrat",
    "MT": "Malta",
    "MU": "Mauritius",
    "MV": "Maldives",
    "MW": "Malawi",
    "MX": "Mexico",
    "MY": "Malaysia",
    "MZ": "Mozambique",
    "NA": "Namibia",
    "NC": "New Caledonia",
    "NE": "Niger",
    "NF": "Norfolk Island",
    "NG": "Nigeria",
    "NI": "Nicaragua",
    "NL": "Netherlands",
    "NO": "Norway",
    "NP": "Nepal",
    "NR": "Nauru",
    "NU": "Niue",
    "NZ": "New Zealand",
    "OM": "Oman",
    "PA": "Panama",
    "PE": "Peru",
    "PF": "French Polynesia",
    "PG": "Papua New Guinea",
    "PH": "Philippines",
    "PK": "Pakistan",
    "PL": "Poland",
    "PM": "Saint Pierre & Miquelon",
    "PN": "Pitcairn Islands",
    "PR": "Puerto Rico",
    "PT": "Portugal",
    "PW": "Palau",
    "PY": "Paraguay",
    "QA": "Qatar",
    "RE": "Réunion",
    "RO": "Romania",
    "RS": "Serbia",
    "RU": "Russia",
    "RW": "Rwanda",
    "SA": "Saudi Arabia",
    "SB": "Solomon Islands",
    "SC": "Seychelles",
    "SD": "Sudan",
    "SE": "Sweden",
    "SG": "Singapore",
    "SH": "Saint Helena",
    "SI": "Slovenia",
    "SJ": "Svalbard & Jan Mayen",
    "SK": "Slovakia",
    "SL": "Sierra Leone",
    "SM": "San Marino",
    "SN": "Senegal",
    "SO": "Somalia",
    "SR": "Suriname",
    "SS": "South Sudan",
    "ST": "São Tomé & Príncipe",
    "SV": "El Salvador",
    "SX": "Sint Maarten",
    "SY": "Syria",
    "SZ": "Eswatini",
    "TC": "Turks & Caicos Islands",
    "TD": "Chad",
    "TF": "French Southern Territories",
    "TG": "Togo",
    "TH": "Thailand",
    "TJ": "Tajikistan",
    "TK": "Tokelau",
    "TL": "Timor-Leste",
    "TM": "Turkmenistan",
    "TN": "Tunisia",
    "TO": "Tonga",
    "TR": "Turkey",
    "TT": "Trinidad & Tobago",
    "TV": "Tuvalu",
    "TZ": "Tanzania",
    "UA": "Ukraine",
    "UG": "Uganda",
    "UM": "U.S. Outlying Islands",
    "US": "United States",
    "UY": "Uruguay",
    "UZ": "Uzbekistan",
    "VA": "Vatican City",
    "VC": "Saint Vincent & Grenadines",
    "VE": "Venezuela",
    "VG": "British Virgin Islands",
    "VI": "U.S. Virgin Islands",
    "VN": "Vietnam",
    "VU": "Vanuatu",
    "WF": "Wallis & Futuna",
    "WS": "Samoa",
    "YE": "Yemen",
    "YT": "Mayotte",
    "ZA": "South Africa",
    "ZM": "Zambia",
    "ZW": "Zimbabwe"
  };  
  return countries[code] || code;
}

function getFlagEmoji(code) {
  const flags = {
    "AD": "🇦🇩", "AE": "🇦🇪", "AF": "🇦🇫", "AG": "🇦🇬", "AI": "🇦🇮",
    "AL": "🇦🇱", "AM": "🇦🇲", "AO": "🇦🇴", "AQ": "🇦🇶", "AR": "🇦🇷",
    "AS": "🇦🇸", "AT": "🇦🇹", "AU": "🇦🇺", "AW": "🇦🇼", "AX": "🇦🇽",
    "AZ": "🇦🇿", "BA": "🇧🇦", "BB": "🇧🇧", "BD": "🇧🇩", "BE": "🇧🇪",
    "BF": "🇧🇫", "BG": "🇧🇬", "BH": "🇧🇭", "BI": "🇧🇮", "BJ": "🇧🇯",
    "BL": "🇧🇱", "BM": "🇧🇲", "BN": "🇧🇳", "BO": "🇧🇴", "BQ": "🇧🇶",
    "BR": "🇧🇷", "BS": "🇧🇸", "BT": "🇧🇹", "BV": "🇧🇻", "BW": "🇧🇼",
    "BY": "🇧🇾", "BZ": "🇧🇿", "CA": "🇨🇦", "CC": "🇨🇨", "CD": "🇨🇩",
    "CF": "🇨🇫", "CG": "🇨🇬", "CH": "🇨🇭", "CI": "🇨🇮", "CK": "🇨🇰",
    "CL": "🇨🇱", "CM": "🇨🇲", "CN": "🇨🇳", "CO": "🇨🇴", "CR": "🇨🇷",
    "CU": "🇨🇺", "CV": "🇨🇻", "CW": "🇨🇼", "CX": "🇨🇽", "CY": "🇨🇾",
    "CZ": "🇨🇿", "DE": "🇩🇪", "DJ": "🇩🇯", "DK": "🇩🇰", "DM": "🇩🇲",
    "DO": "🇩🇴", "DZ": "🇩🇿", "EC": "🇪🇨", "EE": "🇪🇪", "EG": "🇪🇬",
    "EH": "🇪🇭", "ER": "🇪🇷", "ES": "🇪🇸", "ET": "🇪🇹", "FI": "🇫🇮",
    "FJ": "🇫🇯", "FM": "🇫🇲", "FO": "🇫🇴", "FR": "🇫🇷", "GA": "🇬🇦",
    "GB": "🇬🇧", "GD": "🇬🇩", "GE": "🇬🇪", "GF": "🇬🇫", "GG": "🇬🇬",
    "GH": "🇬🇭", "GI": "🇬🇮", "GL": "🇬🇱", "GM": "🇬🇲", "GN": "🇬🇳",
    "GP": "🇬🇵", "GQ": "🇬🇶", "GR": "🇬🇷", "GT": "🇬🇹", "GU": "🇬🇺",
    "GW": "🇬🇼", "GY": "🇬🇾", "HK": "🇭🇰", "HM": "🇭🇲", "HN": "🇭🇳",
    "HR": "🇭🇷", "HT": "🇭🇹", "HU": "🇭🇺", "ID": "🇮🇩", "IE": "🇮🇪",
    "IL": "🇮🇱", "IM": "🇮🇲", "IN": "🇮🇳", "IO": "🇮🇴", "IQ": "🇮🇶",
    "IR": "🇮🇷", "IS": "🇮🇸", "IT": "🇮🇹", "JE": "🇯🇪", "JM": "🇯🇲",
    "JO": "🇯🇴", "JP": "🇯🇵", "KE": "🇰🇪", "KG": "🇰🇬", "KH": "🇰🇭",
    "KI": "🇰🇮", "KM": "🇰🇲", "KN": "🇰🇳", "KP": "🇰🇵", "KR": "🇰🇷",
    "KW": "🇰🇼", "KY": "🇰🇾", "KZ": "🇰🇿", "LA": "🇱🇦", "LB": "🇱🇧",
    "LC": "🇱🇨", "LI": "🇱🇮", "LK": "🇱🇰", "LR": "🇱🇷", "LS": "🇱🇸",
    "LT": "🇱🇹", "LU": "🇱🇺", "LV": "🇱🇻", "LY": "🇱🇾", "MA": "🇲🇦",
    "MC": "🇲🇨", "MD": "🇲🇩", "ME": "🇲🇪", "MF": "🇲🇫", "MG": "🇲🇬",
    "MH": "🇲🇭", "MK": "🇲🇰", "ML": "🇲🇱", "MM": "🇲🇲", "MN": "🇲🇳",
    "MO": "🇲🇴", "MP": "🇲🇵", "MQ": "🇲🇶", "MR": "🇲🇷", "MS": "🇲🇸",
    "MT": "🇲🇹", "MU": "🇲🇺", "MV": "🇲🇻", "MW": "🇲🇼", "MX": "🇲🇽",
    "MY": "🇲🇾", "MZ": "🇲🇿", "NA": "🇳🇦", "NC": "🇳🇨", "NE": "🇳🇪",
    "NF": "🇳🇫", "NG": "🇳🇬", "NI": "🇳🇮", "NL": "🇳🇱", "NO": "🇳🇴",
    "NP": "🇳🇵", "NR": "🇳🇷", "NU": "🇳🇺", "NZ": "🇳🇿", "OM": "🇴🇲",
    "PA": "🇵🇦", "PE": "🇵🇪", "PF": "🇵🇫", "PG": "🇵🇬", "PH": "🇵🇭",
    "PK": "🇵🇰", "PL": "🇵🇱", "PM": "🇵🇲", "PN": "🇵🇳", "PR": "🇵🇷",
    "PT": "🇵🇹", "PW": "🇵🇼", "PY": "🇵🇾", "QA": "🇶🇦", "RE": "🇷🇪",
    "RO": "🇷🇴", "RS": "🇷🇸", "RU": "🇷🇺", "RW": "🇷🇼", "SA": "🇸🇦",
    "SB": "🇸🇧", "SC": "🇸🇨", "SD": "🇸🇩", "SE": "🇸🇪", "SG": "🇸🇬",
    "SH": "🇸🇭", "SI": "🇸🇮", "SJ": "🇸🇯", "SK": "🇸🇰", "SL": "🇸🇱",
    "SM": "🇸🇲", "SN": "🇸🇳", "SO": "🇸🇴", "SR": "🇸🇷", "SS": "🇸🇸",
    "ST": "🇸🇹", "SV": "🇸🇻", "SX": "🇸🇽", "SY": "🇸🇾", "SZ": "🇸🇿",
    "TC": "🇹🇨", "TD": "🇹🇩", "TF": "🇹🇫", "TG": "🇹🇬", "TH": "🇹🇭",
    "TJ": "🇹🇯", "TK": "🇹🇰", "TL": "🇹🇱", "TM": "🇹🇲", "TN": "🇹🇳",
    "TO": "🇹🇴", "TR": "🇹🇷", "TT": "🇹🇹", "TV": "🇹🇻", "TZ": "🇹🇿",
    "UA": "🇺🇦", "UG": "🇺🇬", "UM": "🇺🇲", "US": "🇺🇸", "UY": "🇺🇾",
    "UZ": "🇺🇿", "VA": "🇻🇦", "VC": "🇻🇨", "VE": "🇻🇪", "VG": "🇻🇬",
    "VI": "🇻🇮", "VN": "🇻🇳", "VU": "🇻🇺", "WF": "🇼🇫", "WS": "🇼🇸",
    "YE": "🇾🇪", "YT": "🇾🇹", "ZA": "🇿🇦", "ZM": "🇿🇲", "ZW": "🇿🇼"
  };  
  return flags[code] || "🌐"; // Return globe if no flag found
}

// Add a server
async function addServer(serverUrl) {
  try {
    // Load current servers
    const serversData = loadServers();
    
    // Parse server URL
    let server;
    if (serverUrl.startsWith('vless://')) {
      server = await parseVLESSUrl(serverUrl);
    } else {
      throw new Error('Only VLESS URLs are supported');
    }
    
    // Check if server already exists by address and port
    const existingServer = serversData.servers.find(s => 
      s.address === server.address && s.port === server.port);
    
    if (existingServer) {
      return { success: false, message: 'Server already exists', server: existingServer };
    }
    
    // Add the server
    serversData.servers.push(server);
    
    // Only set as active if there is no active server or the active server ID is not in the list
    const activeIdValid = serversData.servers.some(s => s.id === serversData.activeServer);
    if (!serversData.activeServer || !activeIdValid) {
      serversData.activeServer = server.id;
    }
    
    // Save the servers
    saveServers(serversData);
    
    return { success: true, message: 'Server added successfully', server };

  } catch (error) {
    console.error('Error adding server:', error);
    return { success: false, message: `Failed to add server: ${error.message}` };
  }
}

// Get all servers
function getServers() {
  const serversData = loadServers();
  return serversData;
}

// Get active server
function getActiveServer() {
  const serversData = loadServers();
  const activeServerId = serversData.activeServer;
  return serversData.servers.find(s => s.id === activeServerId);
}

// Set active server
function setActiveServer(serverId) {
  const serversData = loadServers();
  const server = serversData.servers.find(s => s.id === serverId);
  
  if (!server) {
    return { success: false, message: 'Server not found' };
  }
  
  serversData.activeServer = serverId;
  saveServers(serversData);
  
  return { success: true, message: 'Active server set', server };
}

// Delete server
function deleteServer(serverId) {
  const serversData = loadServers();
  
  const serverIndex = serversData.servers.findIndex(s => s.id === serverId);
  if (serverIndex === -1) {
    return { success: false, message: 'Server not found' };
  }
  
  // Remove the server
  serversData.servers.splice(serverIndex, 1);
  
  // If this was the active server, unset it
  if (serversData.activeServer === serverId) {
    serversData.activeServer = serversData.servers.length > 0 ? serversData.servers[0].id : '';
  }
  
  saveServers(serversData);
  
  return { success: true, message: 'Server deleted' };
}

// Move a server to the end of the list
function moveServerToEnd(serverId) {
  console.log(`Moving server ${serverId} to the end of the list.`);
  const data = loadServers();
  const serverIndex = data.servers.findIndex(s => s.id === serverId);

  if (serverIndex > -1) {
    // Remove the server from its current position
    const [serverToMove] = data.servers.splice(serverIndex, 1);
    // Add it to the end of the array
    data.servers.push(serverToMove);
    // Save the updated list back to the file
    return saveServers(data);
  } else {
    console.warn(`Server with ID ${serverId} not found, cannot move.`);
    return { success: false, message: 'Server not found' };
  }
}

module.exports = {
  moveServerToEnd,
  loadServers,
  saveServers,
  parseVLESSUrl,
  generateXrayConfig,
  addServer,
  getServers,
  getActiveServer,
  setActiveServer,
  deleteServer,
  getCountryName,
  getFlagEmoji
};
