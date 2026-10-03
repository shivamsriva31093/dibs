import { describe, expect, it } from "vitest";
import { resolveImport } from "../../src/index/resolve";

// A repository as a set of file paths.
const repo = (...files: string[]) => {
  const set = new Set(files);
  return (path: string) => set.has(path);
};

describe("resolveImport", () => {
  it("takes the specifier as written when that file exists", () => {
    expect(resolveImport("src/routes/users.ts", "../users.ts", repo("src/users.ts"))).toBe("src/users.ts");
  });

  it.each([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"])("appends %s to a bare specifier", (extension) => {
    expect(resolveImport("src/routes/users.ts", "../users", repo(`src/users${extension}`))).toBe(`src/users${extension}`);
  });

  it("prefers .ts over .js when both exist, in the order TypeScript resolves them", () => {
    expect(resolveImport("src/a.ts", "./b", repo("src/b.js", "src/b.ts"))).toBe("src/b.ts");
  });

  it("finds the TypeScript twin of a .js specifier, as TypeScript projects write their imports", () => {
    expect(resolveImport("src/a.ts", "./b.js", repo("src/b.ts"))).toBe("src/b.ts");
    expect(resolveImport("src/a.ts", "./b.mjs", repo("src/b.mts"))).toBe("src/b.mts");
    expect(resolveImport("src/a.ts", "./b.cjs", repo("src/b.cts"))).toBe("src/b.cts");
  });

  it("falls back to the directory's index file", () => {
    expect(resolveImport("src/a.ts", "./lib", repo("src/lib/index.ts"))).toBe("src/lib/index.ts");
    expect(resolveImport("src/a.ts", "./lib/", repo("src/lib/index.js"))).toBe("src/lib/index.js");
  });

  it("resolves against the importing file's directory, through ..", () => {
    expect(resolveImport("src/routes/v2/users.ts", "../../db/users", repo("src/db/users.ts"))).toBe("src/db/users.ts");
    expect(resolveImport("index.ts", "./src/a", repo("src/a.ts"))).toBe("src/a.ts");
  });

  it("drops a redundant ./ and a doubled slash", () => {
    expect(resolveImport("src/a.ts", ".//b", repo("src/b.ts"))).toBe("src/b.ts");
    expect(resolveImport("src/a.ts", "././b", repo("src/b.ts"))).toBe("src/b.ts");
  });

  it("answers null for a specifier that leaves the repository", () => {
    expect(resolveImport("src/a.ts", "../../b", repo("b.ts"))).toBeNull();
  });

  it("answers null when nothing matches", () => {
    expect(resolveImport("src/a.ts", "./missing", repo("src/a.ts"))).toBeNull();
  });

  it("answers null for a specifier that is not relative", () => {
    expect(resolveImport("src/a.ts", "lodash", repo("lodash.ts"))).toBeNull();
    expect(resolveImport("src/a.ts", "/abs", repo("abs.ts"))).toBeNull();
  });
});
