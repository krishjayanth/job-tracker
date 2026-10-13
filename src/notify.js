// Windows toast notifications for upcoming deadlines. Uses the WinRT toast API through
// PowerShell, so it needs no extra installs. Clicking a toast opens the dashboard.
// Set NOTIFY=0 to turn notifications off.
import { spawn } from 'node:child_process';

const ENABLED = process.platform === 'win32' && process.env.NOTIFY !== '0';
const HOUR = 3_600_000;
const WARN_WITHIN = 24 * HOUR;

const xmlEscape = s => String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function notify(title, body, url) {
  if (!ENABLED) return;
  const xml = `<toast activationType="protocol" launch="${xmlEscape(url)}" scenario="reminder">
  <visual><binding template="ToastGeneric"><text>${xmlEscape(title)}</text><text>${xmlEscape(body)}</text></binding></visual>
  <actions><action content="Open tracker" activationType="protocol" arguments="${xmlEscape(url)}"/><action content="Dismiss" arguments="dismiss" activationType="system"/></actions>
</toast>`;
  // PowerShell's own app ID can show toasts without registering an app.
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$doc = New-Object Windows.Data.Xml.Dom.XmlDocument
$doc.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(xml).toString('base64')}')))
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($doc))
`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, stdio: 'ignore',
  });
  child.on('error', err => console.warn(`[notify] ${err.message}`));
}

// Whether Windows will actually show our toasts: 'enabled', 'disabled' (turned off in
// Settings > System > Notifications for Windows PowerShell, or all notifications off),
// or 'unsupported'. Checked once at startup and shown in the dashboard.
let toastStatus = ENABLED ? 'unknown' : 'unsupported';
export const notificationStatus = () => toastStatus;

export function checkNotificationSetting() {
  if (!ENABLED) return;
  const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Setting`;
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true,
  });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.on('close', () => {
    toastStatus = /^Enabled/.test(out.trim()) ? 'enabled' : 'disabled';
    if (toastStatus === 'disabled') console.warn(`[notify] Windows notifications are off (${out.trim()}); deadline pop-ups won't show`);
  });
  child.on('error', () => { toastStatus = 'unsupported'; });
}

function dueText(deadline) {
  const ms = Date.parse(deadline) - Date.now();
  if (ms < 0) return 'was due ' + new Date(deadline).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  if (ms < HOUR) return 'is due within the hour';
  const hours = Math.round(ms / HOUR);
  return `is due in ${hours} hour${hours === 1 ? '' : 's'} (${new Date(deadline).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })})`;
}

// Warn once per deadline when it's within a day. Returns true if anything changed.
export function checkDeadlines(applications, url) {
  // While Windows blocks toasts, don't mark anything as sent, so reminders still
  // arrive once notifications are turned back on.
  if (toastStatus !== 'enabled') return false;
  let changed = false;
  for (const a of applications) {
    if (!a.deadline || a.notifiedDeadline === a.deadline) continue;
    const left = Date.parse(a.deadline) - Date.now();
    if (left > WARN_WITHIN || left < -12 * HOUR) continue;
    const what = { oa: 'assessment', interview: 'interview', offer: 'offer response' }[a.status] || 'next step';
    notify(`${a.company}: ${what} ${left < 0 ? 'overdue' : 'due soon'}`, `Your ${what}${a.role ? ` for ${a.role}` : ''} ${dueText(a.deadline)}.`, url);
    a.notifiedDeadline = a.deadline;
    changed = true;
  }
  return changed;
}
