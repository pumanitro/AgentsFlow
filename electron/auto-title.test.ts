import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { autoTitleInput, sanitizeAutoTitle } from './auto-title';

describe('auto-title', () => {
  it('caps the title at 4 words and strips quotes and end punctuation', () => {
    assert.equal(sanitizeAutoTitle('"Matching Door Screen View For Mobile."'), 'Matching Door Screen View');
    assert.equal(sanitizeAutoTitle('Title: Fix login bug!\nextra'), 'Fix login bug');
    assert.equal(sanitizeAutoTitle('**Stats**'), 'Stats');
  });
  it('returns null for an empty reply', () => {
    assert.equal(sanitizeAutoTitle('  \n '), null);
  });
  it('drops image markers and slash commands from the input', () => {
    assert.equal(autoTitleInput('[Image #1] [Image #2] fix the back button /plan-and-execute'), 'fix the back button');
  });
});
