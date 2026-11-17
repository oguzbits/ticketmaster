import { DatePipe } from '@angular/common';
import { Component, computed, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import type { EventSummary } from '@app/shared';
import { map, skip, Subscription, switchMap, timer } from 'rxjs';

import { EventArtBlock } from './event-art-block';
import { EventSearchStore } from './event-search.store';
import { type EventListFilter, EventsService } from './events.service';
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
  private request: Subscription | null = null;

  protected readonly from = signal('');
  protected readonly to = signal('');
  protected readonly maxPriceEur = signal('');
  protected readonly priceInvalid = signal(false);

  protected readonly items = signal<EventSummary[]>([]);
  protected readonly nextCursor = signal<string | null>(null);
  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  private failedCursor: string | undefined;
  private lastLoadedQ = '';

  protected readonly hasActiveFilters = computed(
    () =>
      this.search.query().trim() !== '' ||
      this.from() !== '' ||
      this.to() !== '' ||
      this.maxPriceEur() !== ''
  );
  protected readonly label = strategyLabel;

  constructor() {
    this.load(undefined);
    toObservable(this.search.query)
      .pipe(
        skip(1),
        map((q) => q.trim()),
        switchMap((q) => timer(200).pipe(map(() => q))),
        takeUntilDestroyed()
      )
      .subscribe((q) => {
        if (q !== this.lastLoadedQ) this.reload();
      });
    inject(DestroyRef).onDestroy(() => {
      this.request?.unsubscribe();
      this.search.query.set('');
    });
  }

  protected pickFrom(value: string): void {
    this.from.set(value);
    this.reload();
  }

  protected pickTo(value: string): void {
    this.to.set(value);
    this.reload();
  }

  protected pickMaxPrice(value: string): void {
    const text = value.trim();
    if (text === '') {
      this.priceInvalid.set(false);
      this.maxPriceEur.set('');
      this.reload();
      return;
    }
    const euros = Number(text);
    if (!Number.isInteger(euros) || euros <= 0) {
      this.priceInvalid.set(true);
      return;
    }
    this.priceInvalid.set(false);
    this.maxPriceEur.set(String(euros));
    this.reload();
  }

  protected clearFilters(): void {
    this.search.query.set('');
    this.from.set('');
    this.to.set('');
    this.maxPriceEur.set('');
    this.priceInvalid.set(false);
    this.reload();
  }

  protected retry(): void {
    this.load(this.failedCursor);
  }

  protected loadMore(): void {
    const cursor = this.nextCursor();
    if (cursor && !this.loading()) this.load(cursor);
  }

  private reload(): void {
    this.items.set([]);
    this.nextCursor.set(null);
    this.load(undefined);
  }

  private currentFilter(): EventListFilter {
    const q = this.search.query().trim();
    const from = this.from();
    const to = this.to();
    const maxPrice = this.maxPriceEur();
    return {
      ...(q !== '' ? { q } : {}),
      ...(from !== '' ? { from: `${from}T00:00:00.000Z` } : {}),
      ...(to !== '' ? { to: `${to}T23:59:59.999Z` } : {}),
      ...(maxPrice !== '' ? { maxPriceCents: Number(maxPrice) * 100 } : {}),
    };
  }

  private load(cursor: string | undefined): void {
    this.request?.unsubscribe();
    this.loading.set(true);
    this.failed.set(false);
    this.lastLoadedQ = this.search.query().trim();
    this.request = this.eventsService
      .list({
        ...this.currentFilter(),
        ...(cursor ? { cursor } : {}),
      })
      .subscribe({
        next: (page) => {
          this.loading.set(false);
          this.items.update((current) =>
            cursor === undefined ? page.items : [...current, ...page.items]
          );
          this.nextCursor.set(page.nextCursor);
        },
        error: () => {
          this.loading.set(false);
          this.failed.set(true);
          this.failedCursor = cursor;
        },
      });
  }
}
