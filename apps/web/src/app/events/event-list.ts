import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { EventArtBlock } from './event-art-block';
import { filterEvents } from './event-filter';
import { EventSearchStore } from './event-search.store';
import { EventsService } from './events.service';
import { strategyLabel } from './strategy-label';

@Component({
  selector: 'app-event-list',
  imports: [DatePipe, EventArtBlock, RouterLink],
  templateUrl: './event-list.html',
  host: { class: 'flex flex-col gap-4' },
})
export class EventList {
  private readonly eventsService = inject(EventsService);
  protected readonly search = inject(EventSearchStore);

  protected readonly events = rxResource({ stream: () => this.eventsService.list() });
  protected readonly visible = computed(() =>
    filterEvents(this.events.value() ?? [], this.search.query())
  );
  protected readonly label = strategyLabel;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.search.query.set(''));
  }
}
