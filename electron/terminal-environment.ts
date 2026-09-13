import * as os from 'os';
import * as path from 'path';
import { withUtf8Locale } from './locale';

/** The embedded xterm supports 256 colors and RGB, regardless of its launcher. */
export function terminalEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  // GUI launchers and automation commonly suppress color for their own output.
  // Those flags describe the launcher, not the interactive PTY. Don't force
  // ANSI into redirected output either: programs should detect their own TTY.
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  delete env.CLICOLOR_FORCE;
  env.PATH = [env.PATH, path.join(os.homedir(), '.local/bin')].filter(Boolean).join(path.delimiter);
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.CLICOLOR = '1';
  // Identify ourselves without triggering another terminal app's setup hooks.
  env.TERM_PROGRAM = 'PeersFlow';
  return withUtf8Locale(env);
}
