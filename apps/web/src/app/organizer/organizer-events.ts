import { DatePipe, PercentPipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { EventForm } from './event-form';
import { OrganizerService } from './organizer.service';

@Component({
  selector: 'app-organizer-events',
  imports: [DatePipe, PercentPipe, RouterLink, EventForm],
  templateUrl: './organizer-events.html',
  host: { class: 'flex flex-col gap-6' },
})
export class OrganizerEvents {
  private readonly service = inject(OrganizerService);

  protected readonly events = rxResource({ stream: () => this.service.events() });
}
