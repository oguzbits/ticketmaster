// The web specs compile without Node types; this is the one Node call the contrast spec needs.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
