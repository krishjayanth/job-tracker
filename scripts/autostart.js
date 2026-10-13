// Start the tracker automatically (and invisibly) when you log into Windows.
//   npm run autostart          install, and start it now
//   npm run autostart:remove   uninstall
// It adds one small file to your Startup folder; output goes to data/server.log.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.error('Auto-start setup is Windows-only. On macOS/Linux, use a launchd/systemd user service instead.');
  process.exit(1);
}

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const startupDir = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const launcher = path.join(startupDir, 'job-tracker.vbs');

if (process.argv[2] === 'remove') {
  fs.rmSync(launcher, { force: true });
  console.log('Auto-start removed. (A tracker that is already running keeps running until you log out.)');
  process.exit(0);
}

const command = `cmd /c ""${process.execPath}" --env-file-if-exists=.env server.js >> data\\server.log 2>&1"`;
const vbs = [
  "' Starts the job tracker in the background. Remove with: npm run autostart:remove",
  'Set sh = CreateObject("WScript.Shell")',
  `sh.CurrentDirectory = "${projectDir}"`,
  `sh.Run "${command.replace(/"/g, '""')}", 0, False`,
  '',
].join('\r\n');

fs.mkdirSync(path.join(projectDir, 'data'), { recursive: true });
fs.writeFileSync(launcher, vbs);
console.log(`Installed: ${launcher}`);

// Start it now too, unless something is already serving the port.
const port = Number(process.env.PORT || 5178);
const running = await fetch(`http://localhost:${port}/api/state`).then(() => true, () => false);
if (running) {
  console.log(`Already running at http://localhost:${port}`);
} else {
  spawn('wscript.exe', [launcher], { detached: true, stdio: 'ignore' }).unref();
  console.log(`Started. Open http://localhost:${port} (bookmark it). Logs: data\\server.log`);
}
