import { AsyncLocalStorage } from 'node:async_hooks';

export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

const storage = new AsyncLocalStorage<LogFields>();

/**
 * Fields every log line written inside `work` carries (correlationId of the
 * request, id of the SQS message...), however deep the call that logs. It
 * follows async calls, so nobody has to pass ids around just to log them.
 */
export const logContext = {
  run<T>(fields: LogFields, work: () => T): T {
    return storage.run({ ...storage.getStore(), ...fields }, work);
  },
  current(): LogFields {
    return storage.getStore() ?? {};
  },
};
