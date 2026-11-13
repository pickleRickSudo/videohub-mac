// macOS's own "Choose folder" sheet (AppleScript `choose folder`, brought to the front by System Events' frontmost app),
// so it never hides behind the VideoHub window. Returns the chosen folder (POSIX path) or null (cancelled).
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const SCRIPT = `on run argv
  set t to item 1 of argv
  set s to item 2 of argv
  tell application "System Events" to activate
  try
    tell application "System Events"
      if s is not "" then
        set r to choose folder with prompt t default location (POSIX file s as alias)
      else
        set r to choose folder with prompt t
      end if
    end tell
    return POSIX path of r
  on error number -128
    return ""
  end try
end run`;

export function pickFolder(start, title = 'Choose folder') {
  if (process.env.VIDEOHUB_NO_WINDOW) return Promise.resolve(null);
  const s = start && fs.existsSync(start) ? start : '';
  return new Promise((res) => {
    execFile('/usr/bin/osascript', ['-e', SCRIPT, String(title || 'Choose folder'), s], { timeout: 10 * 60e3 }, (err, out) => {
      const p = String(out || '').trim().replace(/\/$/, '');
      res(!err && p ? p : null);
    });
  });
}
