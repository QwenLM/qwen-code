import { expect, it, vi } from 'vitest';
import { createFakeIndexedDB } from '../test/fake-indexeddb';
import { runIndexedDbRequest } from './indexeddb';

it('acknowledges writes only after commit and closes the connection', async () => {
  const { factory, db } = createFakeIndexedDB();
  const transaction = db.transaction.bind(db);
  let commit: (() => void) | undefined;
  vi.spyOn(db, 'transaction').mockImplementation((name) => {
    const tx = transaction(name);
    Object.defineProperty(tx, 'oncomplete', {
      set(handler: () => void) {
        commit = handler;
      },
      get: () => null,
    });
    return tx;
  });
  const close = vi.spyOn(db, 'close');
  let acknowledged = false;
  const saved = runIndexedDbRequest(
    factory,
    { name: 'test', version: 1, store: 'records' },
    'readwrite',
    (store) => store.put('payload', 'key'),
  ).then(() => {
    acknowledged = true;
  });
  await vi.waitFor(() =>
    expect(db.objectStoreNames.contains('records')).toBe(true),
  );
  // The request has succeeded; the transaction deliberately has not committed.
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  expect(close).not.toHaveBeenCalled();
  commit!();
  await saved;
  expect(acknowledged).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
});
