import { bootstrapApplication } from '@angular/platform-browser';

import { App } from './app/app';
import { appConfig } from './app/app.config';

// A bootstrap failure stays an unhandled rejection: the browser reports it, nothing hides it.
await bootstrapApplication(App, appConfig);
