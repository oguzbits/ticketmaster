/** A message as the queue hands it out. */
export interface ReceivedMessage {
  body: string;
  /** Proves this receipt when the message is deleted; a later receive of the same message gets a new one. */
  receiptHandle: string;
  /** How often the queue has handed this message out, this time included. */
  receiveCount: number;
  /** The ID the sender gave it (the outbox row ID). */
  messageId: string;
}

/** The queue behind the outbox: the relay sends, a consumer receives and deletes. */
export interface MessageQueue {
  /** Resolves once the queue has accepted the message; rejects otherwise. */
  send(input: { body: string; messageId: string }): Promise<void>;
  /**
   * Long-polls: waits for a message up to the queue's poll time, then returns at most `max` (1..10).
   * Aborting `signal` ends the wait at once and rejects with an AbortError.
   */
  receive(max: number, signal?: AbortSignal): Promise<ReceivedMessage[]>;
  /** Removes a received message for good. A consumer calls it only after its handler succeeded. */
  delete(receiptHandle: string): Promise<void>;
}

export const MESSAGE_QUEUE = Symbol('MESSAGE_QUEUE');
