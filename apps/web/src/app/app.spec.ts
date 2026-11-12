import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { HEALTH_STATUS } from '@app/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from './app';

const HEALTH_URL = '/health/live';

function render() {
  TestBed.configureTestingModule({
    imports: [App],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(App);
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  // The app is not stable while a request is open, so only wait after answering one.
  const answer = async (respond: () => void) => {
    respond();
    await fixture.whenStable();
  };
  TestBed.tick();
  return { element, http, answer };
}

describe('App', () => {
  // Every request a test did not answer fails the test.
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows the API status once the health request answers', async () => {
    const { element, http, answer } = render();
    expect(element.querySelector('[role=status]')).not.toBeNull();

    await answer(() => http.expectOne(HEALTH_URL).flush({ status: HEALTH_STATUS.UP }));

    expect(element.textContent).toContain(`API status: ${HEALTH_STATUS.UP}`);
  });

  it('offers a retry when the API fails and loads again on click', async () => {
    const { element, http, answer } = render();
    await answer(() =>
      http.expectOne(HEALTH_URL).flush(null, { status: 503, statusText: 'Service Unavailable' })
    );
    expect(element.querySelector('[role=alert]')).not.toBeNull();

    element.querySelector('button')?.click();
    TestBed.tick();
    await answer(() => http.expectOne(HEALTH_URL).flush({ status: HEALTH_STATUS.UP }));

    expect(element.textContent).toContain(`API status: ${HEALTH_STATUS.UP}`);
  });
});
