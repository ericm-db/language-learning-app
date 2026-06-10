import { describe, expect, it } from 'vitest';
import { AsyncQueue } from './asyncQueue';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

describe('AsyncQueue', () => {
  it('delivers pushed values in order', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.close();
    expect(await collect(queue)).toEqual([1, 2, 3]);
  });

  it('resolves a pending pull when a value arrives later', async () => {
    const queue = new AsyncQueue<string>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    queue.push('hello');
    expect(await pending).toEqual({ value: 'hello', done: false });
  });

  it('drains buffered values before completing after close', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    const iterator = queue[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 1, done: false });
    expect(await iterator.next()).toEqual({ value: 2, done: false });
    expect((await iterator.next()).done).toBe(true);
  });

  it('completes consumers that are awaiting when close() is called', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pendingA = iterator.next();
    const pendingB = iterator.next();
    queue.close();
    expect((await pendingA).done).toBe(true);
    expect((await pendingB).done).toBe(true);
  });

  it('ignores pushes after close', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.close();
    queue.push(2);
    expect(await collect(queue)).toEqual([1]);
  });

  it('close is idempotent', async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.close();
    expect(await collect(queue)).toEqual([]);
  });

  it('interleaves concurrent producers and a for-await consumer', async () => {
    const queue = new AsyncQueue<number>();
    const consumer = collect(queue);
    for (let i = 0; i < 5; i++) {
      queue.push(i);
      await Promise.resolve();
    }
    queue.close();
    expect(await consumer).toEqual([0, 1, 2, 3, 4]);
  });

  it('stops handing out values after the consumer breaks out of for-await', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    for await (const value of queue) {
      expect(value).toBe(1);
      break;
    }
    // Breaking the loop calls iterator.return(); the queue itself stays open
    // for other consumers, so remaining values are still there.
    const iterator = queue[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: 2, done: false });
  });
});
