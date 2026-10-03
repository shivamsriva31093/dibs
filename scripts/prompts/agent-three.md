`paginate` in `src/services/pagination.ts` is documented as numbering pages from 1, but asking for page 1 returns the second page, and asking for 100 items a page returns 99. Find the causes, fix them, and add tests in `test/pagination.test.ts`.

Your scope to start with: change `src/services/` and `test/pagination.test.ts`.
