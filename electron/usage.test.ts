import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { normalizeUsageJson } from './usage';

// The meter shaping, against the `limits[]` shape the endpoint returns. Pure —
// no keychain, no network — so the token-mode reader (getUsageForToken) and
// the keychain readers are pinned to the same output by construction.

const AT = '2026-10-24T10:00:00.000Z';

test('normalizeUsageJson: session first, weekly rows in API order', () => {
  const snap = normalizeUsageJson({
    limits: [
      { kind: 'weekly_all', percent: 40, severity: 'normal', resets_at: '2026-10-28T00:00:00Z', is_active: true },
      { kind: 'weekly', scope: { model: { id: 'fable', display_name: 'Fable' } }, percent: 10 },
      { kind: 'session', percent: 70, resets_at: '2026-10-24T12:00:00Z' },
    ],
  }, AT, 'Max (20x)');
  assert.deepEqual(snap.meters.map((m) => m.key), ['session', 'weekly_all', 'weekly:fable']);
  assert.deepEqual(snap.meters.map((m) => m.label), ['Current session', 'All models', 'Fable']);
  assert.equal(snap.meters[0].group, 'session');
  assert.equal(snap.meters[1].isActive, true);
  assert.equal(snap.meters[1].resetsAt, '2026-10-28T00:00:00Z');
  assert.equal(snap.meters[2].resetsAt, null);
  assert.equal(snap.fetchedAt, AT);
  assert.equal(snap.plan, 'Max (20x)');
});

test('normalizeUsageJson: percent is rounded and clamped to 0..100', () => {
  const snap = normalizeUsageJson({
    limits: [
      { kind: 'session', percent: 104.6 },
      { kind: 'weekly_all', percent: -3 },
      { kind: 'weekly', scope: { surface: 'web' }, percent: 'n/a' },
      { kind: 'weekly', scope: { surface: 'cli' }, percent: 49.5 },
    ],
  }, AT);
  assert.deepEqual(snap.meters.map((m) => m.percent), [100, 0, 0, 50]);
  assert.equal(snap.plan, undefined);
});

test('normalizeUsageJson: severity folds the API vocabulary into three levels', () => {
  const sev = (severity: unknown) =>
    normalizeUsageJson({ limits: [{ kind: 'session', percent: 1, severity }] }, AT).meters[0].severity;
  assert.equal(sev('warning'), 'warning');
  assert.equal(sev('WARN'), 'warning');
  assert.equal(sev('critical'), 'danger');
  assert.equal(sev('exceeded'), 'danger');
  assert.equal(sev(undefined), 'normal');
  assert.equal(sev('something-new'), 'normal');
});

test('normalizeUsageJson: a body without limits is an empty snapshot, not a throw', () => {
  assert.deepEqual(normalizeUsageJson({}, AT).meters, []);
  assert.deepEqual(normalizeUsageJson(null, AT).meters, []);
});
