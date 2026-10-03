`findUser` in `src/db/users.ts` returns `User | null`, which loses the reason a lookup failed. Change it to return `{ ok: true, user: User } | { ok: false, reason: "not_found" }`, and update `test/users.test.ts` to match.

Your scope: change `src/db/users.ts#findUser`, which says that you change that function's interface, and change `test/users.test.ts`. The answer's `dependents` lists the other files that use findUser: they are yours to update as part of this change, so add them to your scope with expand_scope, waiting in line if another task holds them, and update them.
