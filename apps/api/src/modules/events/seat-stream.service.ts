import { randomUUID } from 'node:crypto';

import {
  SEAT_STREAM_EVENT,
  type SeatChange,
  SeatChangeSchema,
  type SeatSnapshot,
} from '@app/shared';
import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { interval, Observable, Subject, timer } from 'rxjs';

import { SLOT_SLACK_MS, SlotLimiter } from '../../infrastructure/rate-limit/slot-limiter.js';
import { REDIS, type Redis } from '../../infrastructure/redis/redis.module.js';
import { seatChannel } from '../bookings/index.js';
import { EventsService } from './events.service.js';

/** A comment line keeps proxies and browsers from closing a stream that is quiet. */
export const HEARTBEAT_MS = 15_000;

/** Open streams one client address may hold, and the open streams all API instances serve. */
export const MAX_STREAMS_PER_IP = 10;
export const MAX_STREAMS_TOTAL = 500;
/** After this long the server ends a stream; the client reconnects and gets a fresh snapshot. */
export const STREAM_MAX_LIFETIME_MS = 600_000;

/** What the stream sends: the first event and every change are named, a heartbeat is a comment. */
export type SeatStreamMessage =
  | { type: typeof SEAT_STREAM_EVENT.SNAPSHOT; data: SeatSnapshot }
  | { type: typeof SEAT_STREAM_EVENT.CHANGE; data: SeatChange }
  | { comment: string };

/** The Redis subscription of one event and the viewers that share it. */
interface Topic {
  changes: Subject<SeatChange>;
  listener: (message: string) => void;
  ready: Promise<unknown>;
  viewers: number;
}

/**
 * Fans the seat changes of Redis out to the viewers of an event. All events of the process share
 * one subscriber connection (a connection that subscribes can do nothing else, so it is a copy of
 * the main one); an event is subscribed while it has at least one viewer.
 */
@Injectable()
export class SeatStreamService implements OnModuleInit, OnModuleDestroy {
  // Public so a spec can shorten them, like `heartbeatMs`.
  heartbeatMs = HEARTBEAT_MS;
  maxLifetimeMs = STREAM_MAX_LIFETIME_MS;
  maxStreamsPerIp = MAX_STREAMS_PER_IP;
  maxStreamsTotal = MAX_STREAMS_TOTAL;
  /** Redis keys of the slot counters; a spec uses a prefix of its own. */
  slotKeyPrefix = 'streams:seat';
  private readonly logger = new Logger(SeatStreamService.name);
  private readonly subscriber: Redis;
  private readonly topics = new Map<string, Topic>();
  /** Subscribe and unsubscribe calls run one after another, see `enqueue`. */
  private subscriptionQueue: Promise<void> = Promise.resolve();

  constructor(
    @Inject(REDIS) redis: Redis,
    @Inject(EventsService) private readonly events: Pick<EventsService, 'detail'>,
    @Inject(SlotLimiter) private readonly slots: SlotLimiter
  ) {
    this.subscriber = redis.duplicate();
  }

  async onModuleInit(): Promise<void> {
    // node-redis reconnects by itself and subscribes again; without a listener an 'error' event
    // would crash the process.
    this.subscriber.on('error', (error: Error) => this.logger.error(error.message));
    // Changes published while the connection was down are lost for good. node-redis subscribes
    // again by itself, but a viewer would keep a stale seat map, so every stream ends once the
    // connection is back ('ready' also fires for the first connect, when no stream exists yet):
    // the clients reconnect and read a fresh snapshot.
    this.subscriber.on('ready', () => {
      this.logger.warn('seat stream subscriber is ready, ending the open streams');
      this.endStreams();
    });
    await this.subscriber.connect();
  }

  /** Ends every open stream, so the HTTP server can close, then closes the connection. */
  async onModuleDestroy(): Promise<void> {
    this.endStreams();
    if (this.subscriber.isOpen) await this.subscriber.quit();
  }

  private endStreams(): void {
    for (const topic of [...this.topics.values()]) topic.changes.complete();
  }

  /**
   * The snapshot, then every change. The subscription comes first and the snapshot is read after
   * it is active, so a change committed in between is not lost: it waits in `pending` and follows
   * the snapshot. A change older than the snapshot is harmless, the client applies changes in the
   * order they arrive. Errors (an event the viewer may not see: NotFound) end the stream. The
   * caps are checked here, before an Observable exists: once Nest subscribes it has sent the 200
   * headers, so a refusal can no longer be a status code. The slots are taken now and given back
   * when the stream ends, however it ends, so the caller must subscribe right away (a slot that is
   * never given back runs out by itself after the stream lifetime).
   */
  async stream(
    eventId: string,
    userId: string | null,
    address: string
  ): Promise<Observable<SeatStreamMessage>> {
    const release = await this.admit(address);
    return new Observable<SeatStreamMessage>((out) => {
      const topic = this.join(eventId);
      const pending: SeatChange[] = [];
      let live = false;
      const link = topic.changes.subscribe({
        next: (change) => {
          if (live) out.next({ type: SEAT_STREAM_EVENT.CHANGE, data: change });
          else pending.push(change);
        },
        complete: () => out.complete(),
      });
      const heartbeat = interval(this.heartbeatMs).subscribe(() =>
        out.next({ comment: 'heartbeat' })
      );
      const lifetime = timer(this.maxLifetimeMs).subscribe(() => out.complete());
      void this.readSnapshot(topic, eventId, userId).then(
        (snapshot) => {
          out.next({ type: SEAT_STREAM_EVENT.SNAPSHOT, data: snapshot });
          for (const change of pending.splice(0)) {
            out.next({ type: SEAT_STREAM_EVENT.CHANGE, data: change });
          }
          live = true;
        },
        (error: Error) => out.error(error)
      );
      return () => {
        link.unsubscribe();
        heartbeat.unsubscribe();
        lifetime.unsubscribe();
        this.leave(eventId, topic);
        release();
      };
    });
  }

  /** Takes a slot of the total cap, then one of the address; returns the call that gives both back. */
  private async admit(address: string): Promise<() => void> {
    const slotId = randomUUID();
    const lifetimeMs = this.maxLifetimeMs + SLOT_SLACK_MS;
    const totalKey = `${this.slotKeyPrefix}:total`;
    const addressKey = `${this.slotKeyPrefix}:ip:${address}`;
    if (!(await this.slots.acquire(totalKey, slotId, this.maxStreamsTotal, lifetimeMs))) {
      throw new ServiceUnavailableException('Too many open streams, try again later');
    }
    if (!(await this.slots.acquire(addressKey, slotId, this.maxStreamsPerIp, lifetimeMs))) {
      await this.slots.release(totalKey, slotId);
      throw new HttpException('Too many open streams', HttpStatus.TOO_MANY_REQUESTS);
    }
    return () => {
      // A slot that stays after a failed release runs out by itself; the address is not logged.
      void Promise.all([
        this.slots.release(totalKey, slotId),
        this.slots.release(addressKey, slotId),
      ]).catch((error: Error) =>
        this.logger.error(`releasing a stream slot failed: ${error.name}`)
      );
    };
  }

  private async readSnapshot(
    topic: Topic,
    eventId: string,
    userId: string | null
  ): Promise<SeatSnapshot> {
    await topic.ready;
    const { seats } = await this.events.detail(eventId, userId);
    return { seats };
  }

  private join(eventId: string): Topic {
    const known = this.topics.get(eventId);
    const topic = known ?? this.subscribe(eventId);
    topic.viewers += 1;
    return topic;
  }

  private subscribe(eventId: string): Topic {
    const changes = new Subject<SeatChange>();
    const listener = (message: string): void => {
      const change = this.parse(message);
      if (change !== undefined) changes.next(change);
    };
    const ready = this.enqueue(() => this.subscriber.subscribe(seatChannel(eventId), listener));
    const topic: Topic = { changes, listener, ready, viewers: 0 };
    this.topics.set(eventId, topic);
    // A failed subscription must not stay in the map, or every later viewer would wait on it.
    ready.catch(() => {
      if (this.topics.get(eventId) === topic) this.topics.delete(eventId);
    });
    return topic;
  }

  private leave(eventId: string, topic: Topic): void {
    topic.viewers -= 1;
    if (topic.viewers > 0) return;
    if (this.topics.get(eventId) === topic) this.topics.delete(eventId);
    this.enqueue(() => this.subscriber.unsubscribe(seatChannel(eventId), topic.listener)).catch(
      (error: Error) => {
        this.logger.error(
          `could not unsubscribe from the seats of event ${eventId}: ${error.name}`
        );
      }
    );
  }

  /**
   * A viewer who joins right after the last one left sends SUBSCRIBE while the UNSUBSCRIBE of the
   * old topic is still in flight; node-redis then drops the new listener and the channel stays
   * subscribed with nobody listening. One call at a time avoids that.
   */
  private enqueue<T>(call: () => Promise<T>): Promise<T> {
    const result = this.subscriptionQueue.then(call);
    this.subscriptionQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** A message that is not a seat change is dropped and logged (the payload could be anything). */
  private parse(message: string): SeatChange | undefined {
    try {
      return SeatChangeSchema.parse(JSON.parse(message));
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'unknown error';
      this.logger.error(`dropped a message on a seat channel that is not a seat change: ${reason}`);
      return undefined;
    }
  }
}
