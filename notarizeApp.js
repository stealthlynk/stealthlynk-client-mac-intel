// notarizeApp.js - Standalone notarization script
// Run this after building the app with electron-builder
const { notarize } = require('@electron/notarize');
const path = require('path');
const fs = require('fs');

console.log('>>> STANDALONE NOTARIZATION SCRIPT STARTING');
console.log(`Node.js version: ${process.version}`);
console.log(`Using @electron/notarize from: ${require.resolve('@electron/notarize')}`);

async function notarizeApp() {
  // Check environment variables
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD || !process.env.APPLE_TEAM_ID) {
    console.error('ERROR: Missing required environment variables for notarization!');
    console.error('Make sure APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID are set.');
    process.exit(1);
  }

  // Find the app in the dist/mac directory
  const distMacDir = path.resolve(__dirname, 'dist/mac');
  let appPath;
  
  if (!fs.existsSync(distMacDir)) {
    console.error(`ERROR: Mac build directory not found at ${distMacDir}`);
    console.error('Build the app first with: npm run build:mac-x64');
    process.exit(1);
  }

  // List all files in the directory to find .app bundles
  const files = fs.readdirSync(distMacDir);
  const appBundle = files.find(file => file.endsWith('.app'));
  
  if (!appBundle) {
    console.error(`ERROR: No .app bundle found in ${distMacDir}`);
    console.error('Build the app first with: npm run build:mac-x64');
    process.exit(1);
  }
  
  appPath = path.join(distMacDir, appBundle);
  console.log(`Found app bundle: ${appBundle}`);


  console.log(`>>> NOTARIZING APP AT: ${appPath}`);
  console.log(`>>> Using Apple ID: ${process.env.APPLE_ID}`);
  console.log(`>>> Using Team ID: ${process.env.APPLE_TEAM_ID}`);

  try {
    console.log('>>> STARTING NOTARYTOOL NOTARIZATION...');
    console.log('This may take 10-30 minutes. Progress updates will be shown...');
    
    // Set up progress timer
    let minutes = 0;
    const progressTimer = setInterval(() => {
      minutes += 1;
      console.log(`Still waiting for notarization... (${minutes} minutes elapsed)`);
    }, 60000); // Log every minute
    
    // Add verbose logging and request polling for status updates
    await notarize({
      tool: 'notarytool',
      appPath,
      appBundleId: 'io.stealthlynk',
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
      debug: true,
      verbose: true
    });
    
    // Clear the progress timer
    clearInterval(progressTimer);
    console.log('>>> NOTARIZATION SUCCESSFUL! <<<');
  } catch (error) {
    console.error(`>>> NOTARIZATION FAILED: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

notarizeApp().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
