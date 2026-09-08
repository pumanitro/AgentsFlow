import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { imageMarker, insertImageMarkers, referencedImageNumbers, removeImageMarker } from '../shared/image-markers';

describe('insertImageMarkers', () => {
  it('inserts at the caret with padding on both sides', () => {
    const r = insertImageMarkers('compare this to', 15, 15, [1]);
    assert.equal(r.text, 'compare this to [Image #1] ');
    assert.equal(r.caret, r.text.length);
  });

  it('does not double up existing whitespace', () => {
    const r = insertImageMarkers('before  after', 7, 7, [2]);
    assert.equal(r.text, 'before [Image #2] after');
    assert.equal(r.caret, 'before [Image #2]'.length);
  });

  it('works in an empty composer and at the start of text', () => {
    assert.equal(insertImageMarkers('', 0, 0, [1]).text, '[Image #1] ');
    assert.equal(insertImageMarkers('hello', 0, 0, [1]).text, '[Image #1] hello');
  });

  it('replaces a selection and inserts several markers in one paste', () => {
    const r = insertImageMarkers('see XXX here', 4, 7, [3, 4]);
    assert.equal(r.text, 'see [Image #3] [Image #4] here');
  });

  it('clamps out-of-range selections', () => {
    assert.equal(insertImageMarkers('ab', 10, 20, [1]).text, 'ab [Image #1] ');
    assert.equal(insertImageMarkers('ab', -3, -1, [1]).text, '[Image #1] ab');
  });

  it('is a no-op without numbers', () => {
    assert.deepEqual(insertImageMarkers('x', 1, 1, []), { text: 'x', caret: 1 });
  });
});

describe('removeImageMarker', () => {
  it('removes the marker and one adjacent space', () => {
    assert.equal(removeImageMarker('look at [Image #1] now', 1), 'look at now');
    assert.equal(removeImageMarker('look at [Image #1]', 1), 'look at');
    assert.equal(removeImageMarker('[Image #1] look', 1), 'look');
    assert.equal(removeImageMarker('[Image #1]', 1), '');
  });

  it('renumbers the markers above the removed one', () => {
    assert.equal(
      removeImageMarker('a [Image #1] b [Image #2] c [Image #3]', 2),
      'a [Image #1] b c [Image #2]',
    );
    assert.equal(removeImageMarker('[Image #3] [Image #1]', 1), '[Image #2]');
  });

  it('removes every occurrence of the marker', () => {
    assert.equal(removeImageMarker('[Image #1] x [Image #1] y', 1), 'x y');
  });

  it('leaves text without markers alone', () => {
    assert.equal(removeImageMarker('nothing here #1 [Image 1]', 1), 'nothing here #1 [Image 1]');
  });

  it('does not touch #10 when removing #1', () => {
    assert.equal(removeImageMarker('[Image #1] [Image #10]', 1), '[Image #9]');
  });
});

describe('referencedImageNumbers', () => {
  it('lists marker numbers in order of appearance', () => {
    assert.deepEqual(referencedImageNumbers('x [Image #2] y [Image #1] [Image #2]'), [2, 1, 2]);
    assert.deepEqual(referencedImageNumbers('none'), []);
  });
});

describe('imageMarker', () => {
  it('matches the Claude Code TUI placeholder', () => {
    assert.equal(imageMarker(7), '[Image #7]');
  });
});
