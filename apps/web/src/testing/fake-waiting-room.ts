import type { WaitingRoomStatus } from '@app/shared';
import { Subject } from 'rxjs';

import type { WaitingRoomStreamMessage } from '../app/events/waiting-room.service';

/** The service as the store sees it: every call returns a subject the test answers. */
export class FakeWaitingRoom {
  readonly statusCalls: Subject<WaitingRoomStatus>[] = [];
  readonly joinCalls: Subject<WaitingRoomStatus>[] = [];
  readonly leaveCalls: Subject<void>[] = [];
  readonly streams: Subject<WaitingRoomStreamMessage>[] = [];
  private track<T>(list: Subject<T>[]): Subject<T> {
    const subject = new Subject<T>();
    list.push(subject);
    return subject;
  }
  status() {
    return this.track(this.statusCalls);
  }
  join() {
    return this.track(this.joinCalls);
  }
  leave() {
    return this.track(this.leaveCalls);
  }
  updates() {
    return this.track(this.streams);
  }
}
