import { Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';

import { HealthService } from './core/health.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
})
export class App {
  private readonly healthService = inject(HealthService);

  protected readonly health = rxResource({ stream: () => this.healthService.live() });
}
