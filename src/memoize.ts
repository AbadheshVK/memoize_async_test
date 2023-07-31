import { ReadonlyDeep } from 'type-fest';

// We don't allow null. undefined is required instead.
export type SimpleArgs = (string | number | boolean | undefined)[];

export type BasicAsyncFunc<U extends SimpleArgs, R> = (...args: U) => Promise<ReadonlyDeep<R>>;

interface Memoized<U extends SimpleArgs, R> extends BasicAsyncFunc<U, R> {
  cache_size: () => number;
  clear_cache: () => void;
}

/**
 * Memoizes async functions.
 * The function signature that can be memoized are deliberately restricted
 * to primitive datatypes, to make sure they can be correctly cached.
 *
 * This `rightly` puts the burden on the user to correctly build a function to be memoized
 * rather than a library which has little knowledge of the function.
 *
 * Multiple parallel calls with the same key require only a single call to the wrapped async function.
 *
 * Example:
 * const get_user = memoize_async({ ttl: 60, size: 100 }, async (user_id: number) => {
 *  user = await database.get_user(user_id);
 *  return user;
 * });
 * const u1 = await get_user(2); // Calls database.get_user
 * const u2 = await get_user(2); // Returns from cache
 *
 * @param options Options:
 *  ttl: Seconds till the cache expires
 *  size: The maximum number of items allowed in the cache.
 *        Oldest items are removed first when limit is reached.
 * @param f The async function to be memoized
 */
const memoize_async = <R, U extends SimpleArgs>(
  options: { ttl: number; size: number },
  f: BasicAsyncFunc<U, R>,
): Memoized<U, R> => {
  const cache: Map<string, { value: ReadonlyDeep<R>; expiry: Date }> = new Map();
  const queue: Map<string, Array<{ resolve: (result: ReadonlyDeep<R>) => void; reject: (reason?: Error) => void }>> = new Map();
  const maxSize = options.size;

  async function memoized(...args: U): Promise<ReadonlyDeep<R>> {

    //Validate arguments
    if (f.length !== args.length) {
      return Promise.reject(
        new Error(`Invalid number of arguments passed (${args.length} != ${f.length}) or used spread operator`),
      );
    }

    const key = JSON.stringify(args);

    //Check and return value from cache if it is not expired based on ttl
    const entry = cache.get(key);
    if (entry && entry.expiry > new Date()) {
      return entry.value;
    }

    //Enqueue parallel calls if key is present in queue
    if (queue.has(key)) {
      return new Promise((resolve, reject) => {
        queue.get(key)?.push({ resolve, reject });
      });
    }

    queue.set(key, []);

    try {
      const result: ReadonlyDeep<R> = await f(...args);
      // Remove oldest key if cache is full
      if (cache.size >= maxSize) {
        const oldestKey = cache.keys().next().value;
        cache.delete(oldestKey);
      }

      const expiry = new Date();
      expiry.setSeconds(expiry.getSeconds() + options.ttl);

      cache.set(key, { value: result, expiry });

      //Resolve remaining enqueued parallel calls for the key
      const handlers = queue.get(key);
      queue.delete(key); // Delete the entry from queue
      if (handlers) {
        for (const { resolve } of handlers) {
          resolve(result);
        }
      }

      return result;
    } catch (err) {
      //In case of error reject all enqueued parrallel calls
      const handlers = queue.get(key);
      queue.delete(key);
      if (handlers) {
        for (const { reject } of handlers) {
          reject(err as Error);
        }
      }
      throw err;
    }
  }

  return Object.assign(memoized, {
    cache_size: () => cache.size,
    clear_cache: () => cache.clear(),
  });
};

export default memoize_async;
