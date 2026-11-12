/**
 * Generated blocks in Markdown: text between `<!-- generated:NAME -->` and `<!-- /generated -->`
 * is owned by `pnpm docs:generate` and replaced from the code. Pure, so it is testable.
 */

const BLOCK = /(<!-- generated:([\w-]+) -->\n)([\s\S]*?)(<!-- \/generated -->)/g;

/** Names of the blocks a document contains, in order. */
export function blockNames(doc) {
  return [...doc.matchAll(BLOCK)].map((match) => match[2]);
}

/** Returns the document with every block replaced by `render(name)`; an unknown name throws. */
export function replaceBlocks(doc, render) {
  return doc.replace(BLOCK, (_, open, name, _old, close) => {
    const body = render(name);
    if (body === undefined) throw new Error(`unknown generated block: ${name}`);
    return `${open}${body.trimEnd()}\n${close}`;
  });
}

function cell(value) {
  return String(value).replaceAll('|', '\\|');
}

/** A Markdown table from a header row and rows of cells. */
export function table(header, rows) {
  const line = (cells) => `| ${cells.map(cell).join(' | ')} |`;
  return [line(header), line(header.map(() => '---')), ...rows.map(line)].join('\n');
}
