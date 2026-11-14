/** A fake `fetch`: each call takes the next prepared answer; calls are recorded. */
export function fakeFetch() {
  const calls: { url: string; headers: Headers; signal: AbortSignal }[] = [];
  type Answer = (signal: AbortSignal) => Response;
  const answers: Answer[] = [];
  const waiting: ((answer: Answer) => void)[] = [];
  const give = (answer: Answer) => {
    const waiter = waiting.shift();
    if (waiter) waiter(answer);
    else answers.push(answer);
  };
  /** A call without a prepared answer waits for one, so a test may prepare it after subscribing. */
  const fetcher = async (url: string, init: { headers?: HeadersInit; signal: AbortSignal }) => {
    calls.push({ url, headers: new Headers(init.headers), signal: init.signal });
    const answer =
      answers.shift() ?? (await new Promise<Answer>((resolve) => waiting.push(resolve)));
    return answer(init.signal);
  };
  /** A stream answer that stays open until `end()`; `push` sends text. */
  const open = () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    give((signal) => {
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          controller = c;
          signal.addEventListener('abort', () =>
            c.error(new DOMException('aborted', 'AbortError'))
          );
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    return {
      push: (text: string) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
    };
  };
  const refuse = (status: number, headers: Record<string, string> = {}) =>
    give(() => new Response(null, { status, headers }));
  const networkFailure = () =>
    give(() => {
      throw new TypeError('Failed to fetch');
    });
  return { fetcher, calls, open, refuse, networkFailure };
}
