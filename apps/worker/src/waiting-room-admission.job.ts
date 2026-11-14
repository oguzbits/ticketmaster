import { ADMISSION_INTERVAL_MS, WaitingRoomService } from '@app/api/waiting-room';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

@Injectable()
export class WaitingRoomAdmissionJob {
  private readonly logger = new Logger(WaitingRoomAdmissionJob.name);

  constructor(@Inject(WaitingRoomService) private readonly waitingRoom: WaitingRoomService) {}

  @Interval(ADMISSION_INTERVAL_MS)
  async run(): Promise<void> {
    // A rejection out of a scheduled call is unhandled and would stop the worker: log it, retry next tick.
    try {
      const admitted = await this.waitingRoom.admitDue();
      if (admitted > 0) this.logger.log(`admitted ${admitted} users`);
    } catch (error) {
      this.logger.error(
        `waiting room admission failed: ${error instanceof Error ? error.name : 'unknown'}`
      );
    }
  }
}
