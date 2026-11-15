import { Component, computed, input } from '@angular/core';

import { EVENT_GLYPH, eventArt } from './event-art';

/** A decorative block: a gradient and a glyph derived from the event id. */
@Component({
  selector: 'app-event-art',
  templateUrl: './event-art-block.html',
  host: {
    class: 'event-art',
    'aria-hidden': 'true',
    '[style.--event-hue]': 'art().hue',
  },
})
export class EventArtBlock {
  readonly eventId = input.required<string>();

  protected readonly glyphs = EVENT_GLYPH;
  protected readonly art = computed(() => eventArt(this.eventId()));
}
