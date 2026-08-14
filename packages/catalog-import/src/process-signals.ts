import type { EventEmitter } from 'node:events';

export const IMPORT_ABORT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

type SignalEmitter = Pick<EventEmitter, 'once' | 'removeListener'>;

/** Abort once on Unix/container termination and return deterministic cleanup. */
export const attachImportAbortSignals = (
  controller: AbortController,
  emitter: SignalEmitter = process,
): (() => void) => {
  const abort = (): void => controller.abort();
  for (const signal of IMPORT_ABORT_SIGNALS) emitter.once(signal, abort);
  return () => {
    for (const signal of IMPORT_ABORT_SIGNALS) emitter.removeListener(signal, abort);
  };
};
