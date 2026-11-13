import { Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { ROLE } from '@app/shared';

import { AuthService } from './auth/auth.service';
import { SessionStore } from './auth/session.store';

@Component({
  selector: 'app-root',
  imports: [RouterLink, RouterOutlet],
  templateUrl: './app.html',
})
export class App {
  protected readonly store = inject(SessionStore);
  protected readonly auth = inject(AuthService);
  protected readonly customer = ROLE.CUSTOMER;
  protected readonly organizer = ROLE.ORGANIZER;
  protected readonly admin = ROLE.ADMIN;
}
