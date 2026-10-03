Add `validateNewUser(input)` in `src/validation/user.ts`. It takes unknown input and returns `{ ok: true, user: { name, email } }` or `{ ok: false, errors: string[] }`. A name must be a non-empty string of at most 100 characters after trimming; an email must contain exactly one `@` with text on both sides. Add tests in `test/validation.test.ts`.

Your scope: change `src/validation/` and `test/validation.test.ts`.

This task is also here to show what happens when a change breaks a test. Give start_task the goal above in full. In your first submission, leave out the check that a name is not empty, but do write the test that an empty name is refused; and for that first submission only, do not run `npm test` before you push. When the verdict comes back, do what it says: fix what it names, run the tests, push, and submit again.
