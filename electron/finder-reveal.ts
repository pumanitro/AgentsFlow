import { execFile } from 'child_process';
import { shell } from 'electron';

// shell.showItemInFolder opens a fresh Finder window for almost every call, so
// clicking file links in a chat piled up dozens of windows. On macOS we instead
// retarget the frontmost Finder window (opening one only when none exists) and
// select the item there. The path goes in as argv, never spliced into the script.
const REUSE_WINDOW_SCRIPT = `
on run argv
  set theItem to (POSIX file (item 1 of argv)) as alias
  tell application "Finder"
    if (count of Finder windows) > 0 then
      set target of Finder window 1 to (container of theItem)
      select theItem
    else
      reveal theItem
    end if
    activate
  end tell
end run
`;

export function revealInFinder(targetPath: string): void {
  if (process.platform !== 'darwin') {
    shell.showItemInFolder(targetPath);
    return;
  }
  execFile('osascript', ['-e', REUSE_WINDOW_SCRIPT, targetPath], { timeout: 5000 }, (err, _stdout, stderr) => {
    if (!err) return;
    // Automation permission denied, Finder busy, etc. — still show the file.
    console.warn('[agentsflow] Finder window reuse failed; falling back', targetPath, stderr || err.message);
    shell.showItemInFolder(targetPath);
  });
}
