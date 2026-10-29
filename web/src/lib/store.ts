import { useSyncExternalStore } from 'react';

// Minimal external store: components subscribe to slices, high-frequency writers stay outside React.
export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? (next as (p: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      subs.forEach((fn) => fn());
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useStore<T>(store: Store<T>): T;
export function useStore<T, S>(store: Store<T>, select: (s: T) => S): S;
export function useStore<T, S>(store: Store<T>, select?: (s: T) => S) {
  const read = () => (select ? select(store.get()) : store.get());
  return useSyncExternalStore(store.subscribe, read, read);
}
