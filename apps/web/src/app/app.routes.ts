import type { Routes } from '@angular/router';
import { ROLE } from '@app/shared';

import { SimulatorPage } from './admin/simulator-page';
import { roleGuard } from './auth/role.guard';
import { MyBookings } from './bookings/my-bookings';
import { EventList } from './events/event-list';
import { SeatMap } from './events/seat-map';
import { OrganizerEvents } from './organizer/organizer-events';
import { StartPage } from './start/start-page';

export const routes: Routes = [
  { path: '', component: StartPage },
  { path: 'events', component: EventList },
  { path: 'events/:id', component: SeatMap },
  { path: 'bookings', component: MyBookings, canActivate: [roleGuard(ROLE.CUSTOMER)] },
  { path: 'organizer', component: OrganizerEvents, canActivate: [roleGuard(ROLE.ORGANIZER)] },
  { path: 'admin/simulator', component: SimulatorPage, canActivate: [roleGuard(ROLE.ADMIN)] },
];
