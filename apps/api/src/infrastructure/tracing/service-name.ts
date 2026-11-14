export const SERVICE_NAME = { API: 'ticketmaster-api', WORKER: 'ticketmaster-worker' } as const;
export type ServiceName = (typeof SERVICE_NAME)[keyof typeof SERVICE_NAME];
