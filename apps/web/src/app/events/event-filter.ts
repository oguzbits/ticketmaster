import type { EventSummary } from '@app/shared';

// shortcut: no diacritic folding, add when a name needs it
export function filterEvents(events: EventSummary[], query: string): EventSummary[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return events;
  return events.filter(
    (event) =>
      event.name.toLowerCase().includes(needle) || event.venueName.toLowerCase().includes(needle)
  );
}
