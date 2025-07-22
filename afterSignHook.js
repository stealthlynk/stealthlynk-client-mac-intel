// afterSignHook.js - Custom notarization script for electron-builder
// This script is explicitly referenced in package.json as the afterSign hook

console.log('>>> CUSTOM NOTARIZATION HOOK STARTING - Using notarytool <<<');
const { notarize } = require('@electron/notarize');
const path = require('path');
const fs = require('fs');

// Required for debugging - log Node.js version and module paths
console.log(`Node.js version: ${process.version}`);
console.log(`Using @electron/notarize from: ${require.resolve('@electron/notarize')}`);

// Export as default for electron-builder
exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir, packager } = context;
  
  if (electronPlatformName !== 'darwin') {
    console.log('Not macOS, skipping notarization');
    return;
  }

  // Verify environment variables are set
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.error('ERROR: Missing required environment variables for notarization!');
    console.error('Make sure APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID are set.');
    throw new Error('Missing notarization credentials in environment variables');
  }

  const appName = packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  if (!fs.existsSync(appPath)) {
    console.error(`ERROR: App not found at ${appPath}, cannot notarize`);
    throw new Error(`App not found at ${appPath}`);
  }

  console.log(`>>> NOTARIZING: ${appName} at ${appPath}`);
  console.log(`>>> Using Apple ID: ${process.env.APPLE_ID}`);
  console.log(`>>> Using Team ID: ${process.env.APPLE_TEAM_ID}`);
  
  try {
    console.log('>>> STARTING NOTARYTOOL NOTARIZATION...');
    
    await notarize({
      tool: 'notarytool', // Explicitly use notarytool (not altool)
      appPath,
      appBundleId: 'io.stealthlynk',
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });
    
    console.log(`>>> NOTARIZATION SUCCESSFUL for ${appName} <<<`);
  } catch (error) {
    console.error(`>>> NOTARIZATION FAILED: ${error.message}`);
    console.error(error);
    throw error;
  }
};
