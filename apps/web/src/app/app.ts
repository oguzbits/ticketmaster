import { Component, inject } from '@angular/core';
import { isActive, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { ROLE } from '@app/shared';

import { AuthService } from './auth/auth.service';
import { SessionStore } from './auth/session.store';
import { EventSearchStore } from './events/event-search.store';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './app.html',
})
export class App {
  protected readonly store = inject(SessionStore);
  protected readonly auth = inject(AuthService);
  protected readonly search = inject(EventSearchStore);
  /** The search field belongs to the list only, not to an event page below it. */
  protected readonly onEventList = isActive('/events', inject(Router), {
    paths: 'exact',
    queryParams: 'ignored',
    fragment: 'ignored',
  });
  protected readonly customer = ROLE.CUSTOMER;
  protected readonly organizer = ROLE.ORGANIZER;
  protected readonly admin = ROLE.ADMIN;
}
