import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { AUDIT_ACTION, AUDIT_SUBJECT, type AuditLogPage } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuditLogService } from './audit-log.service';

const ACTOR_ID = '00000000-0000-4000-8000-0000000000a1';
const PAGE: AuditLogPage = {
  items: [
    {
      id: '7',
      at: '2027-01-01T00:00:00.000Z',
      actorId: ACTOR_ID,
      action: AUDIT_ACTION.EVENT_CREATED,
      subjectType: AUDIT_SUBJECT.EVENT,
      subjectId: '00000000-0000-4000-8000-0000000000e1',
      requestId: 'req-1',
    },
  ],
  nextCursor: '7',
};

describe('AuditLogService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('sends the filters as query parameters and returns the validated page', () => {
    const http = TestBed.inject(HttpTestingController);
    let result: AuditLogPage | null = null;
    TestBed.inject(AuditLogService)
      .page({ action: AUDIT_ACTION.EVENT_CREATED, actorId: ACTOR_ID, cursor: '9' })
      .subscribe((page) => (result = page));

    const request = http.expectOne((req) => req.url === '/api/audit-log');
    expect(request.request.params.get('action')).toBe(AUDIT_ACTION.EVENT_CREATED);
    expect(request.request.params.get('actorId')).toBe(ACTOR_ID);
    expect(request.request.params.get('cursor')).toBe('9');
    request.flush(PAGE);

    expect(result).toEqual(PAGE);
  });

  it('sends no parameter for a filter that is not set', () => {
    const http = TestBed.inject(HttpTestingController);
    TestBed.inject(AuditLogService).page({}).subscribe();

    const request = http.expectOne('/api/audit-log');
    expect(request.request.params.keys()).toEqual([]);
    request.flush(PAGE);
  });

  it('rejects an answer off the contract', () => {
    const http = TestBed.inject(HttpTestingController);
    let failure: Error | null = null;
    TestBed.inject(AuditLogService)
      .page({})
      .subscribe({ error: (error: Error) => (failure = error) });
    http.expectOne('/api/audit-log').flush({ items: [{ id: 'x' }], nextCursor: null });

    expect(failure).not.toBeNull();
  });
});
