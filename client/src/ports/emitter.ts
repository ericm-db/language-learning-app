// Minimal typed emitter shared by adapters and core. Lives in ports/ so both
// layers can use one implementation without violating import boundaries.

import type { Unsubscribe } from './types';

export type EventMap = Record<string, unknown>;

export interface TypedEmitter<E extends EventMap> {
  on<K extends keyof E>(event: K, handler: (payload: E[K]) => void): Unsubscribe;
  emit<K extends keyof E>(event: K, payload: E[K]): void;
  removeAll(): void;
}

export function createEmitter<E extends EventMap>(): TypedEmitter<E> {
  const handlers = new Map<keyof E, Set<(payload: never) => void>>();
  return {
    on(event, handler) {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler as (payload: never) => void);
      return () => set.delete(handler as (payload: never) => void);
    },
    emit(event, payload) {
      handlers.get(event)?.forEach((h) => (h as (p: E[typeof event]) => void)(payload));
    },
    removeAll() {
      handlers.clear();
    },
  };
}
