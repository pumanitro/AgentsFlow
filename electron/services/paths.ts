// Where the sleeping-services loop keeps its files.
//
// All three live in the app's userData dir (~/Library/Application Support/Peers Flow),
// which main.ts passes in — modules under electron/services never import `electron`.

import * as path from 'path';

/** registry = user-editable `services.json`; state = machine clocks; log = append-only JSONL. */
export function servicesFiles(userDataDir: string): { registry: string; state: string; log: string } {
  return {
    registry: path.join(userDataDir, 'services.json'),
    state: path.join(userDataDir, 'services-state.json'),
    log: path.join(userDataDir, 'services-log.jsonl'),
  };
}
