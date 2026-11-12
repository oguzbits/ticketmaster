import { describe, expect, it } from 'vitest';

import { blockNames, replaceBlocks, table } from './blocks.mjs';

const DOC = 'Text\n\n<!-- generated:limits -->\nold\n<!-- /generated -->\n\nEnde\n';

describe('replaceBlocks', () => {
  it('replaces the text between the marks and keeps the rest', () => {
    const out = replaceBlocks(DOC, (name) => `new ${name}`);
    expect(out).toBe(
      'Text\n\n<!-- generated:limits -->\nnew limits\n<!-- /generated -->\n\nEnde\n'
    );
  });

  it('is stable when run twice', () => {
    const once = replaceBlocks(DOC, () => 'x');
    expect(replaceBlocks(once, () => 'x')).toBe(once);
  });

  it('rejects a block name without a generator', () => {
    expect(() => replaceBlocks(DOC, () => undefined)).toThrow(/unknown generated block: limits/);
  });
});

describe('blockNames', () => {
  it('lists the blocks of a document', () => {
    expect(blockNames(DOC)).toEqual(['limits']);
    expect(blockNames('nothing')).toEqual([]);
  });
});

describe('table', () => {
  it('writes header, separator and rows and escapes a pipe', () => {
    expect(table(['A', 'B'], [['1', 'x|y']])).toBe('| A | B |\n| --- | --- |\n| 1 | x\\|y |');
  });
});
