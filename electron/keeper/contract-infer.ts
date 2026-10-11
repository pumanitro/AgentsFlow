// A contract nobody picked, read off what the session is visibly doing: a chat
// that armed a cron or ran /loop means to go on forever; one with open tasks
// means to finish them.
//
// Inference is a fallback for chats started without the composer chip (from a
// terminal, by a peer, before the chip existed). It is written to the row once,
// as `contractSource: 'inferred'`, and never overrides a contract somebody chose.

import type { RunContract } from '../../shared/types';
import type { TranscriptSignals } from './transcript-signals';

/** hasCron || hasLoopCommand → 'forever'; openTasks > 0 → 'until-done'; else null. */
export function inferContract(sig: TranscriptSignals): RunContract | null {
  if (sig.hasCron || sig.hasLoopCommand) return 'forever';
  if (sig.openTasks > 0) return 'until-done';
  return null;
}
