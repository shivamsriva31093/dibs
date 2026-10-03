Add a `GET /users/:id` route. It goes in its own file, `src/routes/users/get.ts`, is listed in `src/routes/users/index.ts`, uses `findUser` from `src/db/users.ts`, and answers 404 with `{ "error": "not found" }` when there is no such user. Add a test for both cases in `test/users-get.test.ts`.

Your scope: change `src/routes/users/get.ts` and `test/users-get.test.ts`; add to `src/routes/users/index.ts`, which other tasks may add routes to as well; and rely on `src/db/users.ts#findUser`.
