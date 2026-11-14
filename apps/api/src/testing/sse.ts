import type { AddressInfo } from 'node:net';

import type { INestApplication } from '@nestjs/common';

import { randomClientAddress } from './http.js';

export interface ServerEvent {
  event: string;
  data: string;
}

/** The address of an app that listens on a port. */
export function originOf(app: INestApplication): string {
  const { port } = app.getHttpServer().address() as AddressInfo; // SAFETY: listen() was called with a port
  return `http://127.0.0.1:${port}`;
}

/** Reads an SSE response block by block; comment-only blocks (the heartbeat) are skipped. */
export async function openStream(
  app: INestApplication,
  path: string,
  token?: string,
  address = randomClientAddress()
) {
  const abort = new AbortController();
  const origin = originOf(app);
  const response = await fetch(`${origin}/api${path}`, {
    signal: abort.signal,
    headers: {
      'X-Forwarded-For': address,
      ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
    },
  });
  const events: ServerEvent[] = [];
  const done = (async () => {
    if (response.body === null) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true }); // SAFETY: fetch bodies yield bytes
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const lines = block.split('\n').filter((line) => !line.startsWith(':'));
        const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
        const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length);
        if (event !== undefined && data !== undefined) events.push({ event, data });
      }
    }
  })().catch((error: Error) => {
    // The test aborts the read to end a stream; anything else is a real failure.
    if (error.name !== 'AbortError') throw error;
  });
  return { origin, response, events, abort: () => abort.abort(), done };
}
