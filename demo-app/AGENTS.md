# Working on this repository

- TypeScript with no build step: Node runs the `.ts` files directly. There are no dependencies.
- Use named exports only.
- Each route lives in its own file under `src/routes/<area>/` and is listed in that area's `index.ts`.
- A function that can fail in an expected way returns a value that says so. Do not throw for expected failures.
- Add or update a test in `test/` for every change in behaviour. Run `npm test`.
- The service runs behind one proxy. The proxy sets the `x-client-ip` header to the address of the client, and drops any `x-client-ip` the client sent itself. A request without that header comes from inside the network.
