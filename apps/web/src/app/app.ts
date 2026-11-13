import { Component, inject } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';

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
}
