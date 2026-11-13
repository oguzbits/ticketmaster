/** The browser's `EventSource`, driven by a test: `send` delivers a message, `close` ends it. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CLOSED = 2;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }

  send(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}
