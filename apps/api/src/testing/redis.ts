import { randomUUID } from 'node:crypto';
import net from 'node:net';

import { loadEnv } from '../config/config.module.js';
import { createRedisClient, type Redis } from '../infrastructure/redis/redis.module.js';

export async function openTestRedis(): Promise<Redis> {
  const client = createRedisClient(loadEnv().REDIS_URL);
  await client.connect();
  return client;
}

/**
 * A connected client whose server stops answering (a stopped or partitioned Redis): the command
 * is written and no reply ever comes, and node-redis has no command timeout, so a call neither
 * answers nor throws. `close` frees the client and the proxy.
 */
export async function openUnresponsiveRedis(): Promise<{ client: Redis; close: () => void }> {
  const target = new URL(loadEnv().REDIS_URL);
  const sockets = new Set<net.Socket>();
  let frozen = false;
  const forward = (from: net.Socket, to: net.Socket) =>
    from.on('data', (chunk) => {
      if (!frozen) to.write(chunk);
    });
  const proxy = net.createServer((inbound) => {
    const outbound = net.connect(Number(target.port), target.hostname);
    for (const socket of [inbound, outbound]) {
      sockets.add(socket);
      socket.on('error', () => socket.destroy());
    }
    forward(inbound, outbound);
    forward(outbound, inbound);
  });
  await new Promise<void>((listening) => proxy.listen(0, '127.0.0.1', listening));
  const address = proxy.address();
  if (address === null || typeof address === 'string') throw new Error('proxy has no port');
  const client = createRedisClient(`redis://127.0.0.1:${address.port}`);
  client.on('error', () => undefined); // the client reports the sockets closed in `close`
  await client.connect();
  await client.ping();
  frozen = true;
  return {
    client,
    close: () => {
      client.destroy();
      for (const socket of sockets) socket.destroy();
      proxy.close();
    },
  };
}

/** A client whose user may read but not write (Redis answers NOPERM to a SET); `close` removes the user. */
export async function openReadOnlyRedis(): Promise<{ client: Redis; close: () => Promise<void> }> {
  const admin = await openTestRedis();
  const user = `readonly-${randomUUID()}`;
  await admin.aclSetUser(user, ['on', 'nopass', '~*', '+@read', '+@connection']);
  const url = new URL(loadEnv().REDIS_URL);
  url.username = user;
  url.password = 'unused';
  const client = createRedisClient(url.toString());
  await client.connect();
  return {
    client,
    close: async () => {
      await client.quit();
      await admin.aclDelUser(user);
      await admin.quit();
    },
  };
}
