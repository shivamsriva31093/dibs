// Makes a test double's repository handle behave like the real binding's: once
// it has been disposed, every call on it fails. With a dispose that does
// nothing, a test cannot see a handle being used after its `using` block ended,
// which on Artifacts fails with exactly this message.

import { RepoHostError, type RepoHandle } from "../../src/repo-host";

export function disposable(handle: RepoHandle): RepoHandle {
  let disposed = false;
  return new Proxy(handle, {
    get(target, property, receiver) {
      if (property === Symbol.dispose) {
        return () => {
          disposed = true;
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) =>
        disposed
          ? Promise.reject(new RepoHostError("internal", "RPC stub used after being disposed."))
          : (value as (...args: unknown[]) => unknown).apply(target, args);
    },
  });
}
