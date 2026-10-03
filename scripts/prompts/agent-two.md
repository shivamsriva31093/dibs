Add rate limiting: at most 60 requests a minute per client address, answering 429 when the limit is passed. AGENTS.md says where the client's address is found; requests from inside the network are not limited. Write it as a wrapper in `src/middleware/rate-limit.ts`, like `withLogging` in `src/middleware/logger.ts`, with a test in `test/rate-limit.test.ts`, and apply it to every user route: the routes under `src/routes/users/`, which you will change.

Your scope: change `src/middleware/rate-limit.ts`, `test/rate-limit.test.ts` and `src/routes/users/`.
