import { describe, expect, it } from "vitest";
import {
  classify,
  coversPath,
  formatScope,
  normalizeScope,
  parseTarget,
  relate,
  scopeFromPaths,
  targetPath,
  targetsOverlap,
  targetText,
  writablePaths,
  type HeldEntry,
  type Outcome,
  type ScopeEntry,
  type ScopeOrigin,
  type ScopeRelation,
  type Target,
} from "../../src/scopes";

describe("parseTarget", () => {
  it("reads a file path as a path target, normalised", () => {
    expect(parseTarget("  src//api/users.ts ")).toEqual({
      ok: true,
      target: { kind: "path", path: "src/api/users.ts" },
      text: "src/api/users.ts",
    });
  });

  it("keeps the trailing slash of a directory", () => {
    expect(parseTarget("src/api//")).toEqual({ ok: true, target: { kind: "path", path: "src/api/" }, text: "src/api/" });
  });

  it("reads path#name as an interface in that file", () => {
    expect(parseTarget(" src//users.ts#findUser ")).toEqual({
      ok: true,
      target: { kind: "interface", path: "src/users.ts", name: "findUser" },
      text: "src/users.ts#findUser",
    });
  });

  it("reads route:METHOD pattern as a route, with the method upper-cased", () => {
    expect(parseTarget("route:get  /users/:id")).toEqual({
      ok: true,
      target: { kind: "route", method: "GET", pattern: "/users/:id" },
      text: "route:GET /users/:id",
    });
  });

  it("accepts * as a route's method", () => {
    expect(parseTarget("route:* /health")).toMatchObject({ ok: true, target: { kind: "route", method: "*", pattern: "/health" } });
  });

  it.each([
    ["", "path must not be empty"],
    ["/src/a.ts", "path must be repository-relative, without a leading slash"],
    ["src/../a.ts", 'path must not contain "." or ".." segments'],
    ["src/api/#findUser", "an interface names a file, not a directory"],
    ["#findUser", "an interface names a file, not a directory"],
    ["src/users.ts#", "an interface needs a name after the #"],
    ["src/users.ts#find User", "an interface name must not contain whitespace, # or /"],
    ["src/users.ts#a#b", "an interface name must not contain whitespace, # or /"],
    ["src/users.ts#a/b", "an interface name must not contain whitespace, # or /"],
    ["/x#findUser", "path must be repository-relative, without a leading slash"],
    ["route:", "a route is written route:METHOD /pattern"],
    ["route:GET", "a route is written route:METHOD /pattern"],
    ["route:FETCH /users", "a route's method must be GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS or *"],
    ["route:GET users", "a route's pattern must start with /"],
    ["route:GET /a b", "a route's pattern must not contain whitespace"],
  ])("rejects %j: %s", (input, reason) => {
    expect(parseTarget(input)).toEqual({ ok: false, reason });
  });
});

const target = (text: string): Target => {
  const parsed = parseTarget(text);
  if (!parsed.ok) {
    throw new Error(`bad target ${text}: ${parsed.reason}`);
  }
  return parsed.target;
};

describe("targetText", () => {
  it.each(["src/a.ts", "src/api/", "src/users.ts#findUser", "route:GET /users/:id", "route:* /health"])(
    "writes %j the way it is read",
    (text) => {
      expect(targetText(target(text))).toBe(text);
      expect(parseTarget(targetText(target(text)))).toMatchObject({ ok: true, target: target(text) });
    },
  );
});

describe("targetPath", () => {
  it.each([
    ["src/a.ts", "src/a.ts"],
    ["src/api/", "src/api/"],
    ["src/users.ts#findUser", "src/users.ts"],
    ["route:GET /users/:id", null],
  ])("%j lives in %j", (text, want) => {
    expect(targetPath(target(text))).toBe(want);
  });
});

describe("targetsOverlap", () => {
  it.each([
    // path and path: as claims always overlapped
    ["src/a.ts", "src/a.ts", true],
    ["src/api/", "src/api/users.ts", true],
    ["src/a.ts", "src/b.ts", false],
    ["src/api", "src/api/users.ts", true],
    // interface and interface: the same name in the same file
    ["src/users.ts#findUser", "src/users.ts#findUser", true],
    ["src/users.ts#findUser", "src/users.ts#listUsers", false],
    ["src/users.ts#findUser", "src/admins.ts#findUser", false],
    // interface and path: the path holds the interface's file
    ["src/users.ts#findUser", "src/users.ts", true],
    ["src/users.ts", "src/users.ts#findUser", true],
    ["src/users.ts#findUser", "src/", true],
    ["src/", "src/db/users.ts#findUser", true],
    ["src/users.ts#findUser", "src/routes/", false],
    ["src/users.ts#findUser", "src/users.tsx", false],
    // a file named like a directory cannot coexist with what is under it
    ["src/api", "src/api/x.ts#f", true],
    // route and route: the same pattern, and the same method or any method
    ["route:GET /users/:id", "route:GET /users/:id", true],
    ["route:GET /users/:id", "route:POST /users/:id", false],
    ["route:* /users/:id", "route:POST /users/:id", true],
    ["route:GET /users/:id", "route:* /users/:id", true],
    ["route:GET /users/:id", "route:GET /users", false],
    // a route is not in any one file
    ["route:GET /users/:id", "src/routes/users.ts", false],
    ["route:GET /users/:id", "src/", false],
    ["route:GET /users/:id", "src/routes/users.ts#getUser", false],
  ])("%j and %j -> %s", (a, b, want) => {
    expect(targetsOverlap(target(a), target(b))).toBe(want);
    expect(targetsOverlap(target(b), target(a))).toBe(want);
  });
});

describe("relate", () => {
  const FILE = "src/users.ts";
  const on = (text: string, relation: ScopeRelation) => ({ target: target(text), relation });

  it.each<[ScopeRelation, ScopeRelation, Outcome]>([
    ["change", "change", "conflict"],
    ["change", "add", "conflict"],
    ["add", "change", "conflict"],
    ["add", "add", "ok"],
    ["change", "rely", "link"],
    ["rely", "change", "link"],
    ["add", "rely", "ok"],
    ["rely", "add", "ok"],
    ["rely", "rely", "ok"],
  ])("asking to %s a file that another task holds to %s -> %s", (requested, held, want) => {
    expect(relate(on(FILE, requested), on(FILE, held))).toBe(want);
  });

  it.each<[ScopeRelation, ScopeRelation]>([
    ["change", "change"],
    ["change", "add"],
    ["add", "change"],
    ["change", "rely"],
  ])("lets %s and %s be when the targets do not overlap", (requested, held) => {
    expect(relate(on("src/a.ts", requested), on("src/b.ts", held))).toBe("ok");
  });

  it("refuses to change an interface in a file that another task changes as a whole", () => {
    expect(relate(on("src/users.ts#findUser", "change"), on(FILE, "change"))).toBe("conflict");
    expect(relate(on(FILE, "change"), on("src/users.ts#findUser", "change"))).toBe("conflict");
  });

  // What makes one function of a shared file exclusive: the file is held to add to by both
  // tasks, and each holds its own interface to change.
  it("lets a task add to a file in which another task changes one interface", () => {
    expect(relate(on(FILE, "add"), on("src/users.ts#findUser", "change"))).toBe("ok");
    expect(relate(on("src/users.ts#findUser", "change"), on(FILE, "add"))).toBe("ok");
  });

  it("refuses two tasks changing the same interface, and allows different ones", () => {
    expect(relate(on("src/users.ts#findUser", "change"), on("src/users.ts#findUser", "change"))).toBe("conflict");
    expect(relate(on("src/users.ts#findUser", "change"), on("src/users.ts#listUsers", "change"))).toBe("ok");
  });

  it("links a change to whatever relies on it, at any grain", () => {
    expect(relate(on("src/users.ts#findUser", "change"), on("src/users.ts#findUser", "rely"))).toBe("link");
    expect(relate(on(FILE, "change"), on("src/users.ts#findUser", "rely"))).toBe("link");
    expect(relate(on("src/users.ts#findUser", "rely"), on("src/", "change"))).toBe("link");
    expect(relate(on("route:GET /users/:id", "rely"), on("route:* /users/:id", "change"))).toBe("link");
  });
});

describe("classify", () => {
  const entry = (text: string, relation: ScopeRelation): ScopeEntry => ({ target: text, relation, origin: "declared" });
  const held = (taskId: string, text: string, relation: ScopeRelation): HeldEntry => ({ ...entry(text, relation), taskId });

  it("sorts what is asked for into what is refused and what is linked", () => {
    const requested = [entry("src/users.ts#findUser", "change"), entry("src/users.ts", "add"), entry("src/db.ts#query", "rely")];
    const others = [
      held("t-one", "src/routes/users.ts", "change"),
      held("t-one", "src/users.ts#findUser", "rely"),
      held("t-two", "src/users.ts", "add"),
      held("t-three", "src/db.ts", "change"),
      held("t-four", "src/users.ts#findUser", "change"),
    ];

    const result = classify(requested, others);

    expect(result.conflicts).toEqual([{ requested: requested[0], held: others[4] }]);
    expect(result.links).toEqual([
      { requested: requested[0], held: others[1] },
      { requested: requested[2], held: others[3] },
    ]);
  });

  it("finds nothing when nothing is held", () => {
    expect(classify([entry("src/a.ts", "change")], [])).toEqual({ conflicts: [], links: [] });
  });
});

describe("normalizeScope", () => {
  const ok = (entries: { target: string; relation: string; origin?: ScopeOrigin }[]) => {
    const result = normalizeScope(entries);
    if (!result.ok) {
      throw new Error(result.reason);
    }
    return result.entries;
  };

  it("writes targets the standard way, marks them declared and sorts them", () => {
    expect(
      ok([
        { target: " src//b.ts ", relation: "change" },
        { target: "src/a.ts", relation: "rely" },
        { target: "src/a.ts", relation: "add" },
      ]),
    ).toEqual([
      { target: "src/a.ts", relation: "add", origin: "declared" },
      { target: "src/a.ts", relation: "rely", origin: "declared" },
      { target: "src/b.ts", relation: "change", origin: "declared" },
    ]);
  });

  it("keeps one of entries that repeat", () => {
    expect(ok([{ target: "src/a.ts", relation: "change" }, { target: "src//a.ts", relation: "change" }])).toHaveLength(1);
  });

  it("keeps the origin it is given", () => {
    expect(ok([{ target: "src/a.ts#f", relation: "rely", origin: "inferred" }])).toEqual([
      { target: "src/a.ts#f", relation: "rely", origin: "inferred" },
    ]);
  });

  it("drops a path that a directory of the same relation already holds", () => {
    expect(
      ok([
        { target: "src/api/", relation: "change" },
        { target: "src/api/users.ts", relation: "change" },
        { target: "src/api/v2/", relation: "change" },
      ]),
    ).toEqual([{ target: "src/api/", relation: "change", origin: "declared" }]);
  });

  it("keeps a path under a directory that is held in another relation", () => {
    expect(ok([{ target: "src/api/", relation: "rely" }, { target: "src/api/users.ts", relation: "change" }])).toHaveLength(2);
  });

  // Holding a path to change includes adding to it.
  it("drops a path held to add to when the same request holds it to change", () => {
    expect(
      ok([
        { target: "src/app.ts", relation: "add" },
        { target: "src/app.ts", relation: "change" },
        { target: "src/routes/index.ts", relation: "add" },
        { target: "src/routes/", relation: "change" },
        { target: "src/other.ts", relation: "add" },
      ]),
    ).toEqual([
      { target: "src/app.ts", relation: "change", origin: "declared" },
      { target: "src/other.ts", relation: "add", origin: "declared" },
      { target: "src/routes/", relation: "change", origin: "declared" },
    ]);
  });

  it("adds the file of an interface that is to change, to add to", () => {
    expect(ok([{ target: "src/users.ts#findUser", relation: "change" }])).toEqual([
      { target: "src/users.ts", relation: "add", origin: "inferred" },
      { target: "src/users.ts#findUser", relation: "change", origin: "declared" },
    ]);
  });

  it.each([
    [{ target: "src/users.ts", relation: "change" }],
    [{ target: "src/users.ts", relation: "add" }],
    [{ target: "src/", relation: "change" }],
  ])("does not add the file when the request already holds it: %j", (holding) => {
    const entries = ok([{ target: "src/users.ts#findUser", relation: "change" }, holding]);

    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.origin === "declared")).toBe(true);
  });

  it("does not add the file of an interface that is only relied on", () => {
    expect(ok([{ target: "src/users.ts#findUser", relation: "rely" }])).toHaveLength(1);
  });

  it.each([
    [[], "between 1 and 100 scope entries are required"],
    [[{ target: "/abs", relation: "change" }], 'invalid target "/abs": path must be repository-relative, without a leading slash'],
    [[{ target: "src/a.ts", relation: "own" }], 'invalid relation "own" for src/a.ts: it must be change, add or rely'],
    [[{ target: "src/a.ts#f", relation: "add" }], "src/a.ts#f cannot be held to add to: an interface or a route is changed or relied on"],
    [[{ target: "route:GET /x", relation: "add" }], "route:GET /x cannot be held to add to: an interface or a route is changed or relied on"],
    [[{ target: `${"a".repeat(501)}`, relation: "change" }], `invalid target: longer than 500 characters`],
  ])("refuses %j", (entries, reason) => {
    expect(normalizeScope(entries)).toEqual({ ok: false, reason });
  });

  // A directory several tasks put new files into, such as a directory of routes or of tests.
  it("lets a directory be held to add to", () => {
    expect(ok([{ target: "src/routes/", relation: "add" }])).toEqual([{ target: "src/routes/", relation: "add", origin: "declared" }]);
  });

  it("refuses more entries than the limit", () => {
    const many = Array.from({ length: 3 }, (_unused, index) => ({ target: `src/${index}.ts`, relation: "change" }));

    expect(normalizeScope(many, { maxEntries: 2 })).toEqual({ ok: false, reason: "between 1 and 2 scope entries are required" });
  });
});

describe("scopeFromPaths", () => {
  it("reads a list of paths as paths to change", () => {
    expect(scopeFromPaths(["src/a.ts", "src/api/"])).toEqual([
      { target: "src/a.ts", relation: "change" },
      { target: "src/api/", relation: "change" },
    ]);
  });
});

describe("coversPath", () => {
  const scope: ScopeEntry[] = [
    { target: "src/api/", relation: "change", origin: "declared" },
    { target: "src/app.ts", relation: "add", origin: "declared" },
    { target: "src/db.ts", relation: "rely", origin: "declared" },
    { target: "src/users.ts#findUser", relation: "change", origin: "declared" },
  ];

  it.each([
    ["src/api/users.ts", true],
    ["src/app.ts", true],
    // relying on a file is not leave to write it
    ["src/db.ts", false],
    // holding an interface is not holding its file
    ["src/users.ts", false],
    ["src/other.ts", false],
    ["src/api", false],
  ])("%j -> %s", (path, want) => {
    expect(coversPath(scope, path)).toBe(want);
  });
});

describe("writablePaths", () => {
  it("lists the paths a task may write, sorted", () => {
    expect(
      writablePaths([
        { target: "src/b.ts", relation: "add", origin: "inferred" },
        { target: "src/a/", relation: "change", origin: "declared" },
        { target: "src/c.ts", relation: "rely", origin: "declared" },
        { target: "src/b.ts#f", relation: "change", origin: "declared" },
      ]),
    ).toEqual(["src/a/", "src/b.ts"]);
  });
});

describe("formatScope", () => {
  const entry = (target: string, relation: ScopeRelation, origin: ScopeOrigin = "declared"): ScopeEntry => ({ target, relation, origin });

  it("has nothing to say about a scope that is only paths to change", () => {
    expect(formatScope([entry("src/a.ts", "change"), entry("src/api/", "change")])).toBeNull();
  });

  it("lists what is changed, added to and relied on, and marks what the agent did not say itself", () => {
    expect(
      formatScope([
        entry("src/db/users.ts", "add", "inferred"),
        entry("src/db/users.ts#findUser", "change"),
        entry("test/users.test.ts", "change"),
        entry("src/db/client.ts#db", "rely", "inferred"),
        entry("src/router.ts#Route", "rely", "detected"),
      ]),
    ).toBe(
      "change=src/db/users.ts#findUser, test/users.test.ts; add=src/db/users.ts (inferred); rely=src/db/client.ts#db (inferred), src/router.ts#Route (detected)",
    );
  });

  it("cuts a long list short", () => {
    const relied = Array.from({ length: 9 }, (_unused, index) => entry(`src/lib.ts#f${index}`, "rely", "inferred"));

    expect(formatScope([entry("src/a.ts", "change"), ...relied])).toBe(
      "change=src/a.ts; rely=src/lib.ts#f0 (inferred), src/lib.ts#f1 (inferred), src/lib.ts#f2 (inferred), src/lib.ts#f3 (inferred), src/lib.ts#f4 (inferred), src/lib.ts#f5 (inferred) and 3 more",
    );
  });
});
