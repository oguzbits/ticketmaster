/**
 * The routes of the waiting room, in a table of their own: `routes.ts` is at the line limit. The
 * spec and `scripts/docs/generate.mjs` merge it with `ROUTES`. Like `routes.ts`, Node runs this file
 * directly, so it imports only packages (the type import is erased).
 */

import { ROLE } from '@app/shared';

import type { RouteDoc } from './routes.js';

export const WAITING_ROOM_ROUTES: Record<string, RouteDoc> = {
  'WaitingRoomController.join': {
    method: 'post',
    path: '/api/events/{id}/waiting-room',
    summary: 'Join the waiting room of an event',
    access: [ROLE.CUSTOMER],
    success: {
      status: 200,
      description: 'The caller’s place. Joining again keeps the place.',
      schema: 'WaitingRoomStatus',
    },
    errors: {
      404: 'Unknown event, or another user’s sandbox event.',
      409: 'The event has no waiting room.',
    },
  },
  'WaitingRoomController.status': {
    method: 'get',
    path: '/api/events/{id}/waiting-room',
    summary: 'Read the caller’s place in the waiting room',
    access: [ROLE.CUSTOMER],
    success: {
      status: 200,
      description: 'The place; the state says so when the caller is neither queued nor admitted.',
      schema: 'WaitingRoomStatus',
    },
  },
  'WaitingRoomController.leave': {
    method: 'delete',
    path: '/api/events/{id}/waiting-room',
    summary: 'Leave the waiting room and give the admission back',
    access: [ROLE.CUSTOMER],
    success: { status: 204, description: 'The caller is neither queued nor admitted.' },
  },
  'WaitingRoomController.stream': {
    method: 'get',
    path: '/api/events/{id}/waiting-room/stream',
    summary: 'Stream the caller’s place in the waiting room',
    access: [ROLE.CUSTOMER],
    success: {
      status: 200,
      description:
        'Server-sent events: the place at the start and whenever it changes; the stream completes once the caller is admitted or not queued, or after 10 minutes.',
      stream: { message: 'WaitingRoomStatus' },
    },
    errors: { 503: 'More than 200 waiting room streams are open across all instances.' },
  },
  'WaitingRoomController.settings': {
    method: 'put',
    path: '/api/events/{id}/waiting-room/settings',
    summary: 'Switch the waiting room of an event on or off',
    access: [ROLE.ORGANIZER, ROLE.ADMIN],
    body: 'SetWaitingRoomRequest',
    success: {
      status: 200,
      description: 'The event with its new capacity (`null` for no waiting room).',
      schema: 'EventSummary',
    },
    errors: {
      404: 'Unknown event, or an event the caller may not change: an organizer changes only their own events, a demo admin only their own sandbox events, a regular admin only public events.',
    },
  },
};
