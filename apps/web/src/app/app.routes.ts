import type { Routes } from '@angular/router';
import { ROLE } from '@app/shared';

import { roleGuard } from './auth/role.guard';
import { StartPage } from './start/start-page';

export const routes: Routes = [
  { path: '', component: StartPage },
  {
    path: 'events',
    loadComponent: () => import('./events/event-list').then((m) => m.EventList),
  },
  {
    path: 'events/:id',
    loadComponent: () => import('./events/seat-map').then((m) => m.SeatMap),
  },
  {
    path: 'bookings',
    loadComponent: () => import('./bookings/my-bookings').then((m) => m.MyBookings),
    canActivate: [roleGuard(ROLE.CUSTOMER)],
  },
  {
    path: 'organizer',
    loadComponent: () => import('./organizer/organizer-events').then((m) => m.OrganizerEvents),
    canActivate: [roleGuard(ROLE.ORGANIZER)],
  },
  {
    path: 'admin/simulator',
    loadComponent: () => import('./admin/simulator-page').then((m) => m.SimulatorPage),
    canActivate: [roleGuard(ROLE.ADMIN)],
  },
  {
    path: 'admin/audit-log',
    loadComponent: () => import('./admin/audit-log-page').then((m) => m.AuditLogPage),
    canActivate: [roleGuard(ROLE.ADMIN)],
  },
];
