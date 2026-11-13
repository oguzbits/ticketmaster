import { DatePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { EventsService } from './events.service';

@Component({
  selector: 'app-event-list',
  imports: [DatePipe, RouterLink],
  templateUrl: './event-list.html',
})
export class EventList {
  private readonly eventsService = inject(EventsService);

  protected readonly events = rxResource({ stream: () => this.eventsService.list() });
}
