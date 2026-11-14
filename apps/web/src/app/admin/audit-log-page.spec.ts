import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import {
  AUDIT_ACTION,
  AUDIT_SUBJECT,
  type AuditEntry,
  type AuditLogPage,
  ROLE,
  type Role,
} from '@app/shared';
import { afterEach, describe, expect, it } from 'vitest';

import { tokensFor } from '../../testing/tokens';
import { routes } from '../app.routes';
import { SessionStore } from '../auth/session.store';
import { AuditLogPage as AuditLogPageComponent } from './audit-log-page';

const URL = '/api/audit-log';
const ENTRY: AuditEntry = {
  id: '9',
  at: '2027-01-01T00:00:00.000Z',
  actorId: '00000000-0000-4000-8000-0000000000a1',
  action: AUDIT_ACTION.EVENT_STRATEGY_SWITCHED,
  subjectType: AUDIT_SUBJECT.EVENT,
  subjectId: '00000000-0000-4000-8000-0000000000e1',
  requestId: 'req-nine',
};
const OLDER: AuditEntry = { ...ENTRY, id: '8', requestId: 'req-eight' };

function render() {
  TestBed.configureTestingModule({
    imports: [AuditLogPageComponent],
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  const fixture = TestBed.createComponent(AuditLogPageComponent);
  const element: HTMLElement = fixture.nativeElement;
  const http = TestBed.inject(HttpTestingController);
  const settle = async () => {
    TestBed.tick();
    await fixture.whenStable();
  };
  const flush = async (page: AuditLogPage) => {
    TestBed.tick();
    http.expectOne(URL).flush(page);
    await settle();
  };
  const button = (name: string) => {
    const found = [...element.querySelectorAll('button')].find(
      (item) => item.textContent?.trim() === name
    );
    if (!found) throw new Error(`${name} button missing`);
    return found;
  };
  const rows = () => [...element.querySelectorAll('tbody tr')].map((row) => row.textContent);
  return { element, http, settle, flush, button, rows };
}

describe('AuditLogPage', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows loading, then a table with action, actor, subject and request ID', async () => {
    const { element, flush } = render();
    TestBed.tick();
    expect(element.textContent).toContain('Loading');

    await flush({ items: [ENTRY], nextCursor: null });

    const text = element.querySelector('tbody')?.textContent ?? '';
    for (const part of [
      AUDIT_ACTION.EVENT_STRATEGY_SWITCHED,
      ENTRY.actorId,
      AUDIT_SUBJECT.EVENT,
      ENTRY.subjectId,
      ENTRY.requestId,
    ]) {
      expect(text).toContain(part);
    }
    expect(element.querySelector('time')?.getAttribute('datetime')).toBe(ENTRY.at);
    expect(element.textContent).not.toContain('Load more');
  });

  it('says so when there are no entries', async () => {
    const { element, flush } = render();
    await flush({ items: [], nextCursor: null });

    expect(element.textContent).toContain('No entries');
    expect(element.querySelector('table')).toBeNull();
  });

  it('shows an error and reloads on Retry', async () => {
    const { element, http, settle, button, rows } = render();
    TestBed.tick();
    http.expectOne(URL).flush('boom', { status: 500, statusText: 'Server Error' });
    await settle();

    expect(element.querySelector('[role=alert]')).not.toBeNull();
    button('Retry').click();
    await settle();
    http.expectOne(URL).flush({ items: [ENTRY], nextCursor: null });
    await settle();

    expect(element.querySelector('[role=alert]')).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it('appends the next page on Load more and disables the button while it loads', async () => {
    const { element, http, settle, flush, button, rows } = render();
    await flush({ items: [ENTRY], nextCursor: ENTRY.id });

    button('Load more').click();
    button('Load more').click();
    await settle();
    expect(button('Loading…').disabled).toBe(true);
    const request = http.expectOne((req) => req.url === URL);
    expect(request.request.params.get('cursor')).toBe(ENTRY.id);
    request.flush({ items: [OLDER], nextCursor: null });
    await settle();

    expect(rows()).toHaveLength(2);
    expect(rows()[1]).toContain('req-eight');
    expect(element.textContent).not.toContain('Load more');
  });

  it('retries a failed Load more with the same cursor and keeps the rows', async () => {
    const { http, settle, flush, button, rows } = render();
    await flush({ items: [ENTRY], nextCursor: ENTRY.id });

    button('Load more').click();
    http.expectOne((req) => req.url === URL).flush('boom', { status: 500, statusText: 'Error' });
    await settle();
    expect(rows()).toHaveLength(1);
    button('Retry').click();
    await settle();

    const request = http.expectOne((req) => req.url === URL);
    expect(request.request.params.get('cursor')).toBe(ENTRY.id);
    request.flush({ items: [OLDER], nextCursor: null });
    await settle();
    expect(rows()).toHaveLength(2);
  });

  it('cancels a running request when the filter changes', async () => {
    const { element, http, settle } = render();
    TestBed.tick();
    const first = http.expectOne(URL);

    const select = element.querySelector<HTMLSelectElement>('#audit-action');
    if (!select) throw new Error('filter missing');
    select.value = AUDIT_ACTION.BOOKING_PAID;
    select.dispatchEvent(new Event('change'));
    await settle();

    expect(first.cancelled).toBe(true);
    http
      .expectOne((req) => req.url === URL && req.params.has('action'))
      .flush({
        items: [],
        nextCursor: null,
      });
  });

  it('reloads from the first page when the action filter changes', async () => {
    const { element, http, settle, flush, rows } = render();
    await flush({ items: [ENTRY], nextCursor: ENTRY.id });

    const select = element.querySelector<HTMLSelectElement>('#audit-action');
    if (!select) throw new Error('filter missing');
    select.value = AUDIT_ACTION.SIMULATION_STARTED;
    select.dispatchEvent(new Event('change'));
    await settle();

    const request = http.expectOne((req) => req.url === URL);
    expect(request.request.params.get('action')).toBe(AUDIT_ACTION.SIMULATION_STARTED);
    expect(request.request.params.has('cursor')).toBe(false);
    request.flush({ items: [OLDER], nextCursor: null });
    await settle();

    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('req-eight');
  });
});

describe('audit log route', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  async function visit(role: Role | null) {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter(routes)],
    });
    if (role) TestBed.inject(SessionStore).set(tokensFor(role));
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/admin/audit-log');
    return router.url;
  }

  it('lets an admin open the screen', async () => {
    expect(await visit(ROLE.ADMIN)).toBe('/admin/audit-log');
    TestBed.tick();
    TestBed.inject(HttpTestingController).match(URL);
  });

  it.each([ROLE.CUSTOMER, ROLE.ORGANIZER])('sends %s to the event list', async (role) => {
    expect(await visit(role)).toBe('/events');
  });

  it('sends a visitor without a session to the start page', async () => {
    expect(await visit(null)).toBe('/');
  });
});
