import { HttpErrorResponse, HttpStatusCode } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { ROLE, type Role } from '@app/shared';

import { AuthService } from '../auth/auth.service';

const ROLES: readonly Role[] = [ROLE.CUSTOMER, ROLE.ORGANIZER, ROLE.ADMIN];

const ROLE_HINT: Record<Role, string> = {
  [ROLE.CUSTOMER]: 'Reserve seats, pay and cancel.',
  [ROLE.ORGANIZER]: 'Create events and watch sales.',
  [ROLE.ADMIN]: 'Switch the booking strategy.',
};

@Component({
  selector: 'app-start-page',
  imports: [RouterLink],
  templateUrl: './start-page.html',
  host: { class: 'flex flex-col gap-4' },
})
export class StartPage {
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  protected readonly roles = ROLES;
  protected readonly hint = ROLE_HINT;
  protected readonly pendingRole = signal<Role | null>(null);
  protected readonly failedRole = signal<Role | null>(null);
  protected readonly failure = signal<number | null>(null);

  protected readonly errorText = computed(() => {
    switch (this.failure()) {
      case HttpStatusCode.TooManyRequests:
        return 'Too many login attempts. Wait a moment and try again.';
      case HttpStatusCode.ServiceUnavailable:
        return 'The demo is full right now. Try again in a few minutes.';
      default:
        return 'Signing in failed. The demo could not be reached.';
    }
  });

  protected login(role: Role): void {
    if (this.pendingRole() !== null) return;
    this.pendingRole.set(role);
    this.failedRole.set(null);
    this.auth.demoLogin(role).subscribe({
      next: () => {
        this.pendingRole.set(null);
        void this.router.navigateByUrl('/events');
      },
      error: (error) => {
        this.pendingRole.set(null);
        this.failedRole.set(role);
        this.failure.set(error instanceof HttpErrorResponse ? error.status : null);
      },
    });
  }
}
