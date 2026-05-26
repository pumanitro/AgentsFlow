import type { AgentsFlowApi } from '../../shared/types';
import { createMockApi } from './mock-ipc';

let mockSingleton: AgentsFlowApi | null = null;

export function api(): AgentsFlowApi {
  if (typeof window === 'undefined') {
    return new Proxy({} as AgentsFlowApi, {
      get() { throw new Error('agentsflow API only available in renderer'); },
    });
  }
  if (window.agentsflow) return window.agentsflow;
  if (!mockSingleton) {
    mockSingleton = createMockApi();
    // eslint-disable-next-line no-console
    console.warn('[agentsflow] window.agentsflow not found — using browser mock IPC. (Expected when not running inside Electron.)');
  }
  return mockSingleton;
}

export function isMock(): boolean {
  return typeof window !== 'undefined' && !window.agentsflow;
}
