import { describe, expect, it } from 'vitest';

import { ADMISSION_BATCH_SIZE, planAdmissions } from './admission-policy.js';

const queue = (length: number) => Array.from({ length }, (_, index) => `user-${index}`);

describe('planAdmissions', () => {
  it('admits the front of the queue in order', () => {
    const head = ['a', 'b', 'c', 'd'];

    expect(planAdmissions({ capacity: 10, admitted: 0, head, batchSize: 3 })).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('admits at most the free places', () => {
    expect(planAdmissions({ capacity: 5, admitted: 3, head: queue(10), batchSize: 10 })).toEqual([
      'user-0',
      'user-1',
    ]);
  });

  it('admits at most the batch size', () => {
    expect(
      planAdmissions({
        capacity: 100,
        admitted: 0,
        head: queue(ADMISSION_BATCH_SIZE * 2),
        batchSize: ADMISSION_BATCH_SIZE,
      })
    ).toHaveLength(ADMISSION_BATCH_SIZE);
  });

  it('admits nobody when the room is full or over full', () => {
    expect(planAdmissions({ capacity: 5, admitted: 5, head: queue(3), batchSize: 10 })).toEqual([]);
    expect(planAdmissions({ capacity: 5, admitted: 8, head: queue(10), batchSize: 10 })).toEqual(
      []
    );
  });

  it('admits nobody from an empty queue', () => {
    expect(planAdmissions({ capacity: 5, admitted: 0, head: [], batchSize: 10 })).toEqual([]);
  });

  it('never returns a user twice', () => {
    expect(
      planAdmissions({ capacity: 5, admitted: 0, head: ['a', 'b', 'a', 'c'], batchSize: 10 })
    ).toEqual(['a', 'b', 'c']);
  });
});
