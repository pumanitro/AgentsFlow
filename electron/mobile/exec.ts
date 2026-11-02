// child_process.execFile wrapper for the mobile gateway (claude --version, tailscale …). Never throws.
import * as child_process from 'child_process';
import * as os from 'os';
import * as path from 'path';
import type { ExecFn } from './types';

export const execFile: ExecFn = (cmd, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      child_process.execFile(
        cmd,
        args,
        {
          encoding: 'utf8',
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            PATH: process.env.PATH + ':' + path.join(os.homedir(), '.local/bin') + ':/opt/homebrew/bin:/usr/local/bin',
          },
        },
        (err, stdout, stderr) => {
          const out = typeof stdout === 'string' ? stdout : '';
          const errOut = typeof stderr === 'string' ? stderr : '';
          if (err) {
            const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
            resolve({ code: typeof code === 'number' ? code : -1, stdout: out, stderr: errOut });
            return;
          }
          resolve({ code: 0, stdout: out, stderr: errOut });
        },
      );
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: e instanceof Error ? e.message : String(e) });
    }
  });
