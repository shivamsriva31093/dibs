// What the narration of the recorded run says. Each line is said when the run itself does
// what the line describes, so the words are functions of what happened: who waited, who
// collided with whom, whose tests failed, who was sent back.
//
// A voice takes a few seconds to make a clip, and a line that is not ready leaves the run
// uncommented. So every line the run is likely to need is listed at the end, to be spoken
// and kept before filming starts.

// "src/db/users.ts#findUser" is said as "findUser".
const named = (target: string) => target.slice(target.indexOf("#") + 1);

export const LINES = {
  start: () => "Five coding agents start on one repository. On the left, what each one is doing. On the right, the board a person watches.",
  claim: (agent: string) =>
    `${agent} says what it will change, what it will only add to, and what it relies on, before it writes a line. dibs fills in what its code already uses.`,
  waiting: (agent: string, holder: string) =>
    `${agent} wants the user routes, which ${holder} holds. It is not just refused: it waits in line, and holds nothing while it waits.`,
  refused: (agent: string, holder: string) => `${agent} asks for code that ${holder} holds. It is refused at once, told who holds it, and asks for less.`,
  collision: (provider: string, relier: string, target: string) =>
    `${provider} says it will change ${named(target)}, which ${relier}'s route uses. Both are told at once, before either has written a line. No model was asked: dibs read the code.`,
  expanded: (agent: string) => `${agent} needs a file it did not ask for, and adds it to its scope before touching it.`,
  forks: () => "Each agent works in its own fork, with plain git. Nothing reaches main until dibs lands it.",
  board: () => "Nobody is asked to read every change. The board shows who holds what, and what just happened.",
  submitted: () =>
    "Work is submitted. There is no pull request: dibs checks the scope and the contracts between the code, runs the tests, and only then has a reviewer read it.",
  gateFirst: () => "The tests run first, in a fresh container on Cloudflare, on the change joined with main as it is now. The container holds no secret.",
  gateFailed: (agent: string) => `${agent}'s change breaks a test. It goes back with the failing output, and no model is asked.`,
  reject: (agent: string) => `The reviewer sends ${agent}'s work back, with the issues it found.`,
  scores: () => "While the reviews run, the board shows how each change did in the tests, and what the decision model made of it.",
  mergedFirst: (agent: string) => `${agent}'s change lands. The tree the tests passed on is the tree that lands, and the commit says so.`,
  // The change that alters an interface goes back before review, because a file on main still uses the old shape.
  dependents: (agent: string, target: string) =>
    `${agent}'s change alters ${named(target)}, and a route on main still uses the old shape. It goes back before review: take the route into your scope, and update it.`,
  // The change that relies on the interface was approved, and goes back at the last check before landing.
  contract: (agent: string, other: string, target: string) =>
    `${agent}'s change was approved, but it uses ${named(target)} in the shape it had before ${other}'s change landed. At the last check before landing, dibs sends it back: catch up, and adapt.`,
  // The change that alters the interface was approved, and goes back at the last check: what uses it landed first.
  dependentsAtLanding: (agent: string, other: string, target: string) =>
    `${agent}'s change to ${named(target)} was approved, but ${other}'s route, which uses it, landed first. At the last check before landing, dibs sends it back: take the route into its scope, and update it.`,
  catching: (agent: string) => `${agent} merges the new main into its fork with one call, and changes its code to fit.`,
  // A task sent back to take over a file that another task holds by then.
  waitingAgain: (agent: string, holder: string) => `${agent} now needs the route, which ${holder} holds. It waits in line.`,
  grantedAgain: (agent: string) => `${agent} was first in line, and now holds the route it has to update.`,
  mergedFixed: (agent: string) => `${agent}'s fix passes the tests and the review, and lands.`,
  adapted: (agent: string, last: boolean) =>
    `${agent}'s change lands, written against what is on main now.${last ? " It is the last one." : ""}`,
  secondReview: () => "The second review is told what the first attempt was sent back for, and by what.",
  granted: (agent: string, holder: string) => `The moment ${holder}'s work lands, ${agent} is first in line, and gets the user routes.`,
  lands: (agent: string, last: boolean) => (last ? "The last change lands." : `${agent}'s change lands.`),
  approveOther: (agent: string) => `${agent}'s change is waiting for a person, and its card says why. In this recording, the person approves it.`,
  end: (askedAbout: number) =>
    askedAbout === 0
      ? "Five agents, five changes on main, and no person was asked. Every change was tested before it landed, and the collision was found before any code was written."
      : `Five agents, five changes on main, and a person was asked about ${askedAbout === 1 ? "one" : ["two", "three", "four", "five"][askedAbout - 2]} of them.`,
};

// The lines a run of the demo is likely to need, with the agents of the demo in their usual parts.
export function likelyLines(): string[] {
  const colliding = ["agent-one", "agent-five"];
  const all = ["agent-one", "agent-two", "agent-three", "agent-four", "agent-five"];
  return [
    LINES.start(),
    LINES.claim("agent-one"),
    LINES.waiting("agent-two", "agent-one"),
    LINES.collision("agent-five", "agent-one", "src/db/users.ts#findUser"),
    LINES.expanded("agent-three"),
    LINES.forks(),
    LINES.board(),
    LINES.submitted(),
    LINES.gateFirst(),
    LINES.gateFailed("agent-four"),
    LINES.scores(),
    ...all.map((agent) => LINES.mergedFirst(agent)),
    LINES.dependents("agent-five", "src/db/users.ts#findUser"),
    LINES.contract("agent-one", "agent-five", "src/db/users.ts#findUser"),
    LINES.dependentsAtLanding("agent-five", "agent-one", "src/db/users.ts#findUser"),
    ...colliding.map((agent) => LINES.catching(agent)),
    LINES.waitingAgain("agent-five", "agent-two"),
    LINES.grantedAgain("agent-five"),
    LINES.mergedFixed("agent-four"),
    ...colliding.flatMap((agent) => [LINES.adapted(agent, false), LINES.adapted(agent, true)]),
    LINES.secondReview(),
    LINES.granted("agent-two", "agent-one"),
    LINES.lands("agent-two", true),
    LINES.end(0),
  ].filter((line, index, lines) => lines.indexOf(line) === index);
}
