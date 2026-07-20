import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseWidthFragment, stripWidthFragment, withWidthFragment } from '../shared/md-image-width';

describe('width fragment round-trip', () => {
  it('parses a width fragment', () => {
    assert.equal(parseWidthFragment('images/pasted-1-a.png#w=420'), 420);
    assert.equal(parseWidthFragment('images/pasted-1-a.png'), null);
    assert.equal(parseWidthFragment('shot.png#w=0'), null);
  });

  it('strips only the trailing width fragment', () => {
    assert.equal(stripWidthFragment('images/pasted-1-a.png#w=420'), 'images/pasted-1-a.png');
    assert.equal(stripWidthFragment('images/pasted-1-a.png'), 'images/pasted-1-a.png');
    // an unrelated fragment is not ours — leave it alone
    assert.equal(stripWidthFragment('doc.png#section'), 'doc.png#section');
  });

  it('appends, replaces, and removes fragments', () => {
    assert.equal(withWidthFragment('a.png', 300), 'a.png#w=300');
    assert.equal(withWidthFragment('a.png#w=300', 512), 'a.png#w=512');
    assert.equal(withWidthFragment('a.png#w=300', undefined), 'a.png');
    assert.equal(withWidthFragment('a.png#w=300', null), 'a.png');
    assert.equal(withWidthFragment('a.png', 419.6), 'a.png#w=420');
    assert.equal(withWidthFragment('a.png', -5), 'a.png');
    assert.equal(withWidthFragment('a.png', NaN), 'a.png');
  });

  it('round-trips: strip(with(ref, w)) === ref and parse(with(ref, w)) === w', () => {
    const ref = 'images/pasted-1700000000000-abc123.png';
    const encoded = withWidthFragment(ref, 640);
    assert.equal(encoded, `${ref}#w=640`);
    assert.equal(stripWidthFragment(encoded), ref);
    assert.equal(parseWidthFragment(encoded), 640);
  });
});
