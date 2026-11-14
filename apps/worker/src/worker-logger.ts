import { traceMixin } from '@app/api/logging';

/** pino options of the worker's logger: every line inside a trace carries its IDs. */
export const workerLogOptions = { mixin: traceMixin };
