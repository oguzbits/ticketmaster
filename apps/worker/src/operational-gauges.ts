import { appMeter, METRIC, METRIC_ATTR } from '@app/api/metrics';
import { MESSAGE_QUEUE, type MessageQueue, OutboxService } from '@app/api/outbox';
import { WAITING_ROOM_STORE, type WaitingRoomStore } from '@app/api/waiting-room';
import { QUEUE_NAME } from '@app/shared';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

/** A scrape waits at most this long for one port; the queue and Redis clients time out on their own. */
const GAUGE_TIMEOUT_MS = 3000;

class GaugeTimeoutError extends Error {
  override name = 'GaugeTimeoutError';
}

/**
 * The gauges that describe state shared by every replica: the age of the oldest unpublished outbox
 * row, the depth of both queues and the number of users in all waiting rooms. Only the worker
 * registers them (one process reports, not one per API replica). The value is read when
 * Prometheus scrapes. A port that fails or does not answer in time leaves its observation out and
 * is logged by error name: a zero in its place would read as "all is well".
 */
@Injectable()
export class OperationalGauges implements OnModuleInit {
  // Public so a spec can use a shorter timeout.
  timeoutMs = GAUGE_TIMEOUT_MS;
  private readonly logger = new Logger(OperationalGauges.name);

  constructor(
    @Inject(OutboxService)
    private readonly outbox: Pick<OutboxService, 'oldestUnpublishedAgeSeconds'>,
    @Inject(MESSAGE_QUEUE) private readonly queue: Pick<MessageQueue, 'depth'>,
    @Inject(WAITING_ROOM_STORE) private readonly waitingRoom: Pick<WaitingRoomStore, 'waitingTotal'>
  ) {}

  onModuleInit(): void {
    const meter = appMeter();
    meter
      .createObservableGauge(METRIC.OUTBOX_OLDEST_AGE, {
        unit: 's',
        description: 'Age of the oldest outbox row that is not published yet; 0 when none waits',
      })
      .addCallback(async (result) => {
        const age = await this.read(METRIC.OUTBOX_OLDEST_AGE, () =>
          this.outbox.oldestUnpublishedAgeSeconds()
        );
        if (age !== undefined) result.observe(age ?? 0);
      });
    meter
      .createObservableGauge(METRIC.QUEUE_DEPTH, {
        description: 'Messages waiting in a queue, the dead-letter queue included',
      })
      .addCallback(async (result) => {
        await Promise.all(
          Object.values(QUEUE_NAME).map(async (name) => {
            const depth = await this.read(METRIC.QUEUE_DEPTH, () => this.queue.depth(name));
            if (depth !== undefined) result.observe(depth, { [METRIC_ATTR.QUEUE]: name });
          })
        );
      });
    meter
      .createObservableGauge(METRIC.WAITING_ROOM_WAITING, {
        description: 'Users waiting in the queues of all waiting rooms',
      })
      .addCallback(async (result) => {
        const waiting = await this.read(METRIC.WAITING_ROOM_WAITING, () =>
          this.waitingRoom.waitingTotal()
        );
        if (waiting !== undefined) result.observe(waiting);
      });
  }

  /** The value, or undefined after a failure or a timeout (logged by error name, never by message). */
  private async read<T>(gauge: string, port: () => Promise<T>): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new GaugeTimeoutError()), this.timeoutMs);
    });
    try {
      return await Promise.race([port(), timeout]);
    } catch (error) {
      this.logger.warn(
        `gauge ${gauge} not observed: ${error instanceof Error ? error.name : 'unknown'}`
      );
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
}
