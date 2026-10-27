import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { MEM_PRESSURE_LEVELS, SERVICE_DEFAULTS, SERVICES_IPC } from '../../shared/services';
import { servicesFiles } from './paths';

test('SERVICES_IPC: channel names are unique and all start with services:', () => {
  const values = Object.values(SERVICES_IPC);
  assert.equal(new Set(values).size, values.length);
  for (const v of values) assert.ok(v.startsWith('services:'), v);
});

test('SERVICE_DEFAULTS: 4 h idle, 30 min early-sleep floor under memory pressure', () => {
  assert.equal(SERVICE_DEFAULTS.idleMinutes, 240);
  assert.equal(SERVICE_DEFAULTS.pressureIdleMinutes, 30);
});

test('MEM_PRESSURE_LEVELS: never ok or unknown', () => {
  assert.ok(!MEM_PRESSURE_LEVELS.includes('ok'));
  assert.ok(!MEM_PRESSURE_LEVELS.includes('unknown'));
  assert.deepEqual([...MEM_PRESSURE_LEVELS], ['warn', 'closed', 'critical']);
});

test('servicesFiles: three files under the given userData dir', () => {
  assert.deepEqual(servicesFiles('/x'), {
    registry: '/x/services.json',
    state: '/x/services-state.json',
    log: '/x/services-log.jsonl',
  });
});
