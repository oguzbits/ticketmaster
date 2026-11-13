import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './app';
import { routes } from './app.routes';

describe('App', () => {
  // Every request a test did not answer fails the test.
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows the event list at the root and the unofficial notice', async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
    });
    const fixture = TestBed.createComponent(App);
    const element: HTMLElement = fixture.nativeElement;
    await TestBed.inject(Router).navigateByUrl('/');
    TestBed.tick();
    TestBed.inject(HttpTestingController).expectOne('/api/events').flush([]);
    await fixture.whenStable();

    const text = element.textContent;
    expect(text).toContain('No events yet');
    expect(text).toContain('Unofficial demo. Not affiliated with Ticketmaster.');
  });
});
