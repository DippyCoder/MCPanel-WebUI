/* ═══════════════════════════════════════════════════════════════════════════
   Path helpers - a direct port of src-tauri/src/commands.rs `mcpanel_home()`
   and friends. These MUST stay byte-identical in behaviour to both the Tauri
   app and mcpanel-cli's paths.py, because all three read/write the same
   config.json, run/ dir, themes/ dir and schedules.json.
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

const path = require('path');
const os = require('os');

function mcpanelHome() {
  if (process.env.MCPANEL_HOME) return process.env.MCPANEL_HOME;

  if (process.platform === 'win32') {
    // Matches Electron's app.getPath('userData') on Windows: %APPDATA%\mcpanel
    const appdata =
      process.env.APPDATA ||
      path.join(process.env.USERPROFILE || 'C:/Users/Default', 'AppData', 'Roaming');
    return path.join(appdata, 'mcpanel');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'mcpanel');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'mcpanel');
}

const p = {
  home: mcpanelHome,
  configPath: () => path.join(mcpanelHome(), 'config.json'),
  runDir: () => path.join(mcpanelHome(), 'run'),
  themesDir: () => path.join(mcpanelHome(), 'themes'),
  logsDir: () => path.join(mcpanelHome(), 'logs'),
  serversDir: () => path.join(mcpanelHome(), 'servers'),
  profilesDir: () => path.join(mcpanelHome(), 'profiles'),
  backupsDir: (serverId) => path.join(mcpanelHome(), 'backups', serverId),
  appSettingsPath: () => path.join(mcpanelHome(), 'app-settings.json'),
  // WebUI-only: persisted host/port override set from the Settings page, one
  // layer below --host/--port and MCPANEL_WEBUI_HOST/_PORT in server/index.js.
  networkConfigPath: () => path.join(mcpanelHome(), 'network.json'),
  schedulesPath: () => path.join(mcpanelHome(), 'schedules.json'),
  defaultThemePath: () => path.join(mcpanelHome(), 'default-theme'),
  firstStartFlag: () => path.join(mcpanelHome(), 'debug_first_start'),
  // WebUI-only: staging area for browser drag-drop / uploads before they are
  // moved into a server or profile directory by the normal upload commands.
  uploadStageDir: () => path.join(mcpanelHome(), 'webui-uploads'),
};

module.exports = p;
