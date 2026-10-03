import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTE_PATTERNS, extract, isIndexable } from "../../src/index/extract";
import { extractTypeScript, type Extracted } from "../../src/index/typescript";

const USERS = `import { db, type User } from "./client.ts";

export function findUser(id: string): User | null {
  return db.users.get(id) ?? null;
}

export function listUsers(): User[] {
  return [...db.users.values()];
}
`;

const interfaces = (text: string) => extractTypeScript(text).interfaces;
const imports = (text: string) => extractTypeScript(text).imports;
const one = (text: string) => {
  const found = interfaces(text);
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe("a module's exported functions", () => {
  it("are found with their names and the text of their declarations up to the body", () => {
    expect(interfaces(USERS)).toEqual([
      { name: "findUser", kind: "function", signature: "export function findUser(id: string): User | null" },
      { name: "listUsers", kind: "function", signature: "export function listUsers(): User[]" },
    ]);
  });

  it("keep a result type that is written with braces", () => {
    const text = `export function findUser(id: string): { ok: true; user: User } | { ok: false; reason: "not_found" } {
  return { ok: false, reason: "not_found" };
}`;

    expect(one(text).signature).toBe(
      'export function findUser(id: string): { ok: true; user: User } | { ok: false; reason: "not_found" }',
    );
  });

  it("keep a result type that holds braces inside angle brackets", () => {
    expect(one("export async function load(): Promise<{ rows: Row[] }> {\n  return q();\n}").signature).toBe(
      "export async function load(): Promise<{ rows: Row[] }>",
    );
  });

  it("keep parameters that are taken apart, with their defaults", () => {
    expect(one("export function page({ size = 10, from }: { size?: number; from: number }) { return 1; }").signature).toBe(
      "export function page({ size = 10, from }: { size?: number; from: number })",
    );
  });

  it("are written on one line whatever the layout", () => {
    const text = `export function paginate<T>(
  items: T[],
  page: number,   // from 1
  perPage: number,
): Page<T> {
  return null;
}`;

    expect(one(text).signature).toBe("export function paginate<T>( items: T[], page: number, perPage: number, ): Page<T>");
  });

  it.each([
    ["export async function f() {}", "export async function f()"],
    ["export function* g() {}", "export function* g()"],
    ["export async function* h() {}", "export async function* h()"],
    ["export declare function d(a: string): void;", "export declare function d(a: string): void"],
  ])("%j -> %j", (text, signature) => {
    expect(one(text)).toMatchObject({ kind: "function", signature });
  });

  it("join the declarations of an overloaded function", () => {
    const text = `export function get(id: string): User;
export function get(id: number): User;
export function get(id: unknown): User { return null; }`;

    expect(interfaces(text)).toEqual([
      {
        name: "get",
        kind: "function",
        signature: "export function get(id: string): User; export function get(id: number): User; export function get(id: unknown): User",
      },
    ]);
  });
});

describe("a module's exported constants", () => {
  it("are known by their name and declared type, not by their value", () => {
    expect(one("export const userRoutes: Route[] = [listUsersRoute];")).toEqual({
      name: "userRoutes",
      kind: "const",
      signature: "export const userRoutes: Route[]",
    });
    expect(one("export let count = 0")).toEqual({ name: "count", kind: "const", signature: "export let count" });
  });

  it("are functions when they hold an arrow function, known up to the arrow", () => {
    expect(one("export const now = () => Date.now();")).toEqual({
      name: "now",
      kind: "function",
      signature: "export const now = () =>",
    });
    expect(one("export const load = async (id: string): Promise<User> => {\n  return q(id);\n};").signature).toBe(
      "export const load = async (id: string): Promise<User> =>",
    );
    expect(one("export const twice = x => x * 2").signature).toBe("export const twice = x =>");
  });

  it("are functions when they hold a function expression, known up to its body", () => {
    expect(one("export const f = function (a: number): number { return a; };")).toEqual({
      name: "f",
      kind: "function",
      signature: "export const f = function (a: number): number",
    });
  });

  it("are found one by one when a statement declares several", () => {
    expect(interfaces("export const a = 1, b: string = f(1, 2), c = [1, 2];").map((found) => [found.name, found.signature])).toEqual([
      ["a", "export const a"],
      ["b", "export const b: string"],
      ["c", "export const c"],
    ]);
  });

  it("are found by each name when the statement takes a value apart", () => {
    expect(interfaces("export const { host, port: listenPort, ...rest } = config;").map((found) => found.name)).toEqual([
      "host",
      "listenPort",
      "rest",
    ]);
    expect(interfaces("export const [first, second] = pair;").map((found) => found.name)).toEqual(["first", "second"]);
  });

  it("end where the statement ends when there are no semicolons", () => {
    const text = `export const a = compute(1,
  2)
export const b = a
  .map((x) => x)
export const c = 3
`;

    expect(interfaces(text).map((found) => found.name)).toEqual(["a", "b", "c"]);
  });
});

describe("a module's exported types", () => {
  it("are known by their whole declaration, because their shape is the contract", () => {
    const text = `export interface Route {
  method: string;
  // A path such as "/users/:id".
  path: string;
  handler: Handler;
}`;

    expect(one(text)).toEqual({
      name: "Route",
      kind: "type",
      signature: "export interface Route { method: string; path: string; handler: Handler; }",
    });
  });

  it.each([
    ["export type Params = Record<string, string>;", "Params", "export type Params = Record<string, string>"],
    ["export type Handler = (request: Request, params: Params) => Response | Promise<Response>;", "Handler", "export type Handler = (request: Request, params: Params) => Response | Promise<Response>"],
    ["export enum Level { Low, High }", "Level", "export enum Level { Low, High }"],
    ["export const enum Flag { A = 1 }", "Flag", "export const enum Flag { A = 1 }"],
    ["export declare type Id = string;", "Id", "export declare type Id = string"],
  ])("%j", (text, name, signature) => {
    expect(one(text)).toEqual({ name, kind: "type", signature });
  });

  it("take in every line of a type written over several lines without a semicolon", () => {
    const text = `export type Result =
  | { ok: true; user: User }
  | { ok: false; reason: "not_found" }

export const next = 1`;

    expect(interfaces(text)).toEqual([
      { name: "Result", kind: "type", signature: 'export type Result = | { ok: true; user: User } | { ok: false; reason: "not_found" }' },
      { name: "next", kind: "const", signature: "export const next" },
    ]);
  });
});

describe("a module's exported classes", () => {
  it("are known by their heading", () => {
    expect(one("export class UserStore extends Base<User> implements Store {\n  get(id: string) { return null; }\n}")).toEqual({
      name: "UserStore",
      kind: "class",
      signature: "export class UserStore extends Base<User> implements Store",
    });
    expect(one("export abstract class Shape {}").signature).toBe("export abstract class Shape");
  });
});

describe("a module's default export", () => {
  it.each([
    ["export default function handler(request: Request) { return 1; }", "function", "export default function handler(request: Request)"],
    ["export default function () {}", "function", "export default function ()"],
    ["export default async function () {}", "function", "export default async function ()"],
    ["export default class Store {}", "class", "export default class Store"],
    ["export default class {}", "class", "export default class"],
    ["export default { fetch };", "const", "export default"],
    ["export default handler", "const", "export default"],
  ])("%j is called default", (text, kind, signature) => {
    expect(one(text)).toEqual({ name: "default", kind, signature });
  });
});

describe("names exported in a list", () => {
  it("are found under the name they are exported as", () => {
    expect(interfaces("const a = 1; function b() {}\nexport { a, b as c };")).toEqual([
      { name: "a", kind: "const", signature: "export { a }" },
      { name: "c", kind: "const", signature: "export { b as c }" },
    ]);
  });

  it("are passed on from another module when the list says where they come from", () => {
    const found = extractTypeScript('export { findUser, listUsers as allUsers, type User } from "./db/users.ts";');

    expect(found.interfaces).toEqual([
      { name: "findUser", kind: "reexport", signature: 'export { findUser } from "./db/users.ts"', from: { specifier: "./db/users.ts", name: "findUser" } },
      { name: "allUsers", kind: "reexport", signature: 'export { listUsers as allUsers } from "./db/users.ts"', from: { specifier: "./db/users.ts", name: "listUsers" } },
      { name: "User", kind: "reexport", signature: 'export { User } from "./db/users.ts"', from: { specifier: "./db/users.ts", name: "User" } },
    ]);
    expect(found.imports).toEqual([{ specifier: "./db/users.ts", names: ["findUser", "listUsers", "User"], via: "reexport" }]);
  });

  it("are passed on from another module when they were imported from it", () => {
    const found = extractTypeScript('import { findUser as find } from "./db/users";\nexport { find, find as lookup };');

    expect(found.interfaces).toEqual([
      { name: "find", kind: "reexport", signature: "export { find }", from: { specifier: "./db/users", name: "findUser" } },
      { name: "lookup", kind: "reexport", signature: "export { find as lookup }", from: { specifier: "./db/users", name: "findUser" } },
    ]);
  });

  it("are not said to come from a package", () => {
    expect(extractTypeScript('export { z } from "zod";')).toEqual({
      interfaces: [{ name: "z", kind: "const", signature: 'export { z } from "zod"' }],
      imports: [],
    });
  });

  it("pass on everything with a star", () => {
    expect(extractTypeScript('export * from "./db/users";')).toEqual({
      interfaces: [],
      imports: [{ specifier: "./db/users", names: ["*"], via: "reexport" }],
    });
  });

  it("pass on everything under one name with a named star", () => {
    expect(extractTypeScript('export * as users from "./db/users";')).toEqual({
      interfaces: [{ name: "users", kind: "reexport", signature: 'export * as users from "./db/users"', from: { specifier: "./db/users", name: "*" } }],
      imports: [{ specifier: "./db/users", names: ["*"], via: "reexport" }],
    });
  });
});

describe("what a module imports", () => {
  it("is listed by the name each thing has where it comes from", () => {
    expect(imports(USERS)).toEqual([{ specifier: "./client.ts", names: ["db", "User"], via: "import" }]);
  });

  it.each([
    ['import d from "./x";', ["default"]],
    ['import d, { a, b as c } from "./x";', ["default", "a", "b"]],
    ['import * as ns from "./x";', ["*"]],
    ['import d, * as ns from "./x";', ["default", "*"]],
    ['import type { A, B } from "./x";', ["A", "B"]],
    ['import { type A, b } from "./x";', ["A", "b"]],
    ["import {\n  a,\n  b,\n} from './x'", ["a", "b"]],
    ['import { default as d } from "./x";', ["default"]],
    ['const { a, b: c } = require("./x");', ["a", "b"]],
    ['const x = require("./x");', ["*"]],
    ['require("./x").start();', ["*"]],
    ['const m = await import("./x");', ["*"]],
  ])("%j -> %j", (text, names) => {
    expect(imports(text)).toEqual([{ specifier: "./x", names, via: "import" }]);
  });

  it("is listed once for each module, however many statements import from it", () => {
    expect(imports('import { a } from "./x";\nimport { b, a } from "./x";\nimport { c } from "../y";')).toEqual([
      { specifier: "./x", names: ["a", "b"], via: "import" },
      { specifier: "../y", names: ["c"], via: "import" },
    ]);
  });

  it("leaves out packages and imports that name nothing", () => {
    expect(imports('import { z } from "zod";\nimport fs from "node:fs";\nimport "./side-effect";\nconst p = require("path");')).toEqual([]);
  });
});

describe("text that only looks like code", () => {
  it.each([
    ['const s = "export function fake() {}";'],
    ["const s = 'export const x = 1';"],
    ["const s = `export const ${name} = 1`;"],
    ["// export function nope() {}"],
    ["/* export const x = 1;\n   export function y() {} */"],
    ['const s = `${`import { a } from "./x"`}`;'],
    ["const pattern = /export const x = [\"']/;"],
    ["function outer() {\n  const exports = { export: 1 };\n}"],
    ["const o = { export: 1, import: 2 }; o.export; o.import;"],
  ])("is not taken for an export or an import: %j", (text) => {
    expect(extractTypeScript(text)).toEqual({ interfaces: [], imports: [] });
  });

  it("does not hide the code that follows it", () => {
    const text = `const quote = "it's";
const tpl = \`a \${b ? \`x\` : "}"} c\`; // export const hidden = 1
const re = /[/"]+/g;
const half = total / 2; const s = "/";
export const shown = 1;
`;

    expect(interfaces(text)).toEqual([{ name: "shown", kind: "const", signature: "export const shown" }]);
  });
});

describe("routes", () => {
  it("are found where a router is told about them", () => {
    const text = `app.get("/users/:id", getUser);\nrouter.post('/users', createUser);\napp.all("/health", ok);`;

    expect(interfaces(text)).toEqual([
      { name: "GET /users/:id", kind: "route", signature: 'app.get("/users/:id"' },
      { name: "POST /users", kind: "route", signature: "router.post('/users'" },
      { name: "* /health", kind: "route", signature: 'app.all("/health"' },
    ]);
  });

  it("are found where they are written as a method and a path", () => {
    const text = `export const listUsersRoute: Route = {\n  method: "GET",\n  path: "/users",\n  handler,\n};`;

    expect(interfaces(text)).toEqual([
      { name: "listUsersRoute", kind: "const", signature: "export const listUsersRoute: Route" },
      { name: "GET /users", kind: "route", signature: 'method: "GET", path: "/users"' },
    ]);
  });

  it("are not found in comments", () => {
    expect(interfaces('// app.get("/users", list)')).toEqual([]);
  });

  it("are found by the repository's own patterns when it gives any", () => {
    const routes = [/\broute\(\s*"(?<method>[A-Z]+)"\s*,\s*"(?<pattern>\/[^"]*)"/g];

    expect(extractTypeScript('route("GET", "/x");\napp.get("/y", h);', { routes }).interfaces).toEqual([
      { name: "GET /x", kind: "route", signature: 'route("GET", "/x"' },
    ]);
  });

  it("have default patterns that carry a method and a pattern", () => {
    for (const pattern of DEFAULT_ROUTE_PATTERNS) {
      expect(pattern.global).toBe(true);
      expect(pattern.source).toContain("(?<method>");
      expect(pattern.source).toContain("(?<pattern>");
    }
  });
});

describe("extract", () => {
  it.each(["src/a.ts", "src/a.tsx", "src/a.mts", "src/a.cts", "src/a.js", "src/a.jsx", "src/a.mjs", "src/a.cjs"])(
    "reads %s as TypeScript or JavaScript",
    (path) => {
      expect(extract(path, "export const a = 1;")).toEqual<Extracted>({
        interfaces: [{ name: "a", kind: "const", signature: "export const a" }],
        imports: [],
      });
    },
  );

  it.each(["README.md", "src/a.py", "src/a.go", "Makefile", "src/a.ts.bak"])("has nothing to read %s with", (path) => {
    expect(extract(path, "export const a = 1;")).toBeNull();
  });
});

describe("isIndexable", () => {
  it.each([
    ["src/a.ts", 100, true],
    ["src/a.ts", 256 * 1024, true],
    ["src/a.ts", 256 * 1024 + 1, false],
    ["README.md", 100, false],
    ["node_modules/x/index.js", 100, false],
    ["packages/a/node_modules/x/index.js", 100, false],
    ["dist/bundle.min.js", 100, false],
    ["src/types.d.ts", 100, true],
  ])("%s of %i bytes -> %s", (path, size, want) => {
    expect(isIndexable(path, size)).toBe(want);
  });
});
