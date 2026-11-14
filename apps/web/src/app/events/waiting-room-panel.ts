import { DatePipe } from '@angular/common';
import { Component, effect, inject, input, untracked } from '@angular/core';
import { WAITING_ROOM_STATE } from '@app/shared';

import { WAITING_ROOM_PENDING, WAITING_ROOM_PHASE, WaitingRoomStore } from './waiting-room.store';

/** The waiting room of an event; the seat map provides the store, so it can gate holding too. */
@Component({
  selector: 'app-waiting-room-panel',
  imports: [DatePipe],
  templateUrl: './waiting-room-panel.html',
})
export class WaitingRoomPanel {
  readonly eventId = input.required<string>();

  protected readonly store = inject(WaitingRoomStore);
  protected readonly phase = WAITING_ROOM_PHASE;
  protected readonly state = WAITING_ROOM_STATE;
  protected readonly pending = WAITING_ROOM_PENDING;

  constructor() {
    effect(() => {
      const id = this.eventId();
      untracked(() => this.store.open(id));
    });
  }
}
