# What Clef answered, and the thresholds set from it

dibs asks Cloudflare's Clef decision model two things: how a new task relates to the tasks already running, and how a submitted change looks. Before this measurement the thresholds were guesses. On 2026-10-02 the exact requests dibs builds were sent to the real models for the cases below, and the thresholds and one question were changed to fit the answers.

Ten cases is a small sample. The numbers below are a starting point, and every one of them is a per-repository setting.

## Two things the answers showed

**Clef's `confidence` is not the probability of its answer.** For an answer of 65% "coupled", 31% "independent" and 4% "duplicate", Clef reported a confidence of 0.28. The value matches `(Σp² − 1/n) / (1 − 1/n)`: it measures how concentrated the answer is across all the options. A risk answer split between "low" and "medium" has a low confidence without being a doubtful answer. dibs no longer uses the field for any decision. It uses the probabilities themselves.

**Asked about "behaviour", Clef calls every bug fix an interface change.** The question was reworded around names, parameters and result shapes. See the last table.

## Related work, `clef-flash`

About 250 ms per request. The model picked the right relation in every case.

| New task | Other task | Answer | Probability of the answer | Clef's confidence |
|---|---|---|---|---|
| Change what `findUser` returns | A route that calls `findUser` | coupled | 0.65 | 0.28 |
| Change what `findUser` returns | A rate limiter | independent | 0.98 | 0.95 |
| The same pair, with the goals as real agents wrote them | | coupled | 0.66 | 0.27 |
| A route that calls `findUser` | Change what `findUser` returns | coupled | 0.70 | 0.34 |
| A second rate limiter | A rate limiter | duplicate | 0.88 | 0.68 |
| Fix a typo in the README | Four unrelated tasks | independent | 0.98 to 0.99 | 0.93 to 0.96 |
| Change what `findUser` returns | Pagination fix, validation helper | independent | 0.95 to 0.98 | 0.84 to 0.95 |

**Rule:** a task is reported when the answer is not "independent" and its probability is at least `relatedMinConfidence`, **0.5**. The old rule compared Clef's confidence with 0.6 and would have reported nothing but the duplicate.

## Triage, `clef`

Between 0.5 and 1.3 seconds per request. The first five are the diffs of a real end-to-end run; the rest were written by hand to cover what the first five do not.

| Change | Risk (0 to 3) | Chance of high risk | Changes an interface | Unrelated changes | Leftovers | Fits the goal (0 to 3) |
|---|---|---|---|---|---|---|
| Change a function's return type | 1.64 | 0.04 | **0.98** | 0.02 | 0.01 | 2.72 |
| Add a version to `package.json` | 0.92 | 0.01 | 0.05 | 0.01 | 0.01 | 2.82 |
| Add a route in a new file | 1.16 | 0.03 | 0.08 | 0.02 | 0.01 | 2.76 |
| Fix two bugs inside existing functions | 1.62 | 0.02 | 0.03 | 0.53 | 0.01 | 2.42 |
| Add a middleware in a new file | 1.38 | 0.09 | 0.03 | 0.02 | 0.02 | 2.10 |
| Reword a comment | 0.04 | 0.00 | 0.03 | 0.01 | 0.01 | 2.48 |
| Remove an auth check and add a function that deletes all users | **2.86** | **0.89** | 0.08 | 0.88 | 0.24 | 1.42 |
| Add a 404, with debug output and a TODO left in | 1.23 | 0.06 | 0.29 | 0.93 | **0.98** | 2.13 |
| A bug fix that also changes the shape of another route's response | 1.57 | 0.02 | **0.87** | **0.94** | 0.01 | 2.26 |
| Add a helper that nothing calls yet | 0.95 | 0.01 | 0.03 | 0.02 | 0.02 | 2.63 |

**Rules.** A change the reviewer approves still goes to a person when:

- the chance of high risk is at least `riskHighMin`, **0.3**. Only the dangerous change comes near it (0.89); the next highest is 0.09;
- the probability that it changes an interface is at least `interfaceChangeMin`, **0.6**. The two real interface changes score 0.98 and 0.87; nothing else is above 0.29.

The old risk rules compared the score with 2.5 and Clef's confidence with 0.5. The second would have sent seven of these ten changes to a person.

**Shadow rule.** Whether Clef alone would have approved, recorded for comparison and never acted on: risk below 1.5, goal fit at least 2.4, and each of the three probabilities below 0.3. On these cases that is the version bump, the new route, the reworded comment and the unused helper.

## The interface question

Three wordings, asked together about each change. The first is the one dibs used at the time.

| Change | "the signature or the behaviour" | "would callers have to change" | "the name, the parameters, the return type or the response shape" |
|---|---|---|---|
| Change a function's return type | 0.97 | 0.97 | **0.97** |
| Fix two bugs inside existing functions | 0.77 | 0.04 | **0.03** |
| A bug fix that also changes a route's response shape | 0.85 | 0.62 | **0.78** |
| Remove an auth check | 0.91 | 0.40 | 0.21 |
| Add a 404, with debug output | 0.45 | 0.35 | 0.47 |
| The other five | 0.03 to 0.22 | 0.03 to 0.05 | 0.03 to 0.09 |

The third wording is the one in `src/decider.ts` now. It keeps both real interface changes high and stops flagging a fix that corrects what a function computes without changing how it is called.

Answers move a little between requests: the same change scored 0.77 and 0.88 on the first wording in two runs. Thresholds need room on both sides, which is why they sit in the gaps and not at the edges.
