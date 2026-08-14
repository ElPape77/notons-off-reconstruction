import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { attachImportAbortSignals, IMPORT_ABORT_SIGNALS } from '../src/index.js';

describe("signaux d'arret de l'importeur", () => {
  it.each(IMPORT_ABORT_SIGNALS)('abandonne proprement sur %s', (signal) => {
    const emitter = new EventEmitter();
    const controller = new AbortController();
    const detach = attachImportAbortSignals(controller, emitter);

    emitter.emit(signal);

    expect(controller.signal.aborted).toBe(true);
    detach();
    for (const registeredSignal of IMPORT_ABORT_SIGNALS) {
      expect(emitter.listenerCount(registeredSignal)).toBe(0);
    }
  });

  it('retire tous les listeners meme sans signal', () => {
    const emitter = new EventEmitter();
    const controller = new AbortController();
    const detach = attachImportAbortSignals(controller, emitter);

    detach();

    expect(controller.signal.aborted).toBe(false);
    for (const signal of IMPORT_ABORT_SIGNALS) expect(emitter.listenerCount(signal)).toBe(0);
  });
});
