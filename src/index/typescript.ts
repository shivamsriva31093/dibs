// What a TypeScript or JavaScript module offers to others, and what it takes from them.
//
// This is not a parser. It blanks out comments and the insides of strings, then reads
// the statements that start with `export` or `import` at the top level of the file.
// That is enough to answer the two questions dibs asks of a file: which named things
// can other files use, with which shapes, and which named things of other files does
// this one use. What it cannot see is listed in the design spec (section 5).
//
// A signature is the text of a declaration up to its body, on one line. For a type,
// an interface or an enum it is the whole declaration, because there the shape is
// the contract. Two signatures that read the same are the same contract.

export type InterfaceKind = "function" | "class" | "type" | "const" | "route" | "reexport";

export interface ExtractedInterface {
  name: string;
  kind: InterfaceKind;
  signature: string;
  // For a name that is passed on from another module of the repository: where it comes from.
  from?: { specifier: string; name: string };
}

export interface ExtractedImport {
  // Relative to the importing file, as written.
  specifier: string;
  // The names as the other module exports them: "default" for its default export, "*" for all of it.
  names: string[];
  // "reexport" when the names are only passed on (`export ... from`), not used.
  via: "import" | "reexport";
}

export interface Extracted {
  interfaces: ExtractedInterface[];
  imports: ExtractedImport[];
}

export interface ExtractOptions {
  // Global regular expressions with the named groups `method` and `pattern`.
  routes?: RegExp[];
}

// `app.get("/users/:id", ...)` and its kin, and routes written as `{ method: "GET", path: "/users" }`.
export const DEFAULT_ROUTE_PATTERNS: RegExp[] = [
  /\b(?:app|router|server|api|routes?)\.(?<method>get|post|put|patch|delete|head|options|all)\(\s*["'`](?<pattern>\/[^"'`]*)["'`]/g,
  /\bmethod:\s*["'`](?<method>[A-Za-z]+)["'`]\s*,\s*path:\s*["'`](?<pattern>\/[^"'`]*)["'`]/g,
];

// Words after which a "/" starts a regular expression and does not divide.
const BEFORE_REGEX = new Set(["return", "typeof", "case", "in", "of", "void", "delete", "throw", "new", "await", "yield", "do", "else"]);
// Words that can start a value but are never the single parameter of an arrow function.
const NOT_A_PARAMETER = new Set(["new", "await", "typeof", "void", "delete", "function", "class", "yield", "this", "null", "true", "false"]);

const IDENTIFIER = /[A-Za-z_$][\w$]*/y;
const IDENTIFIER_CHAR = /[\w$]/;
const SPACE = /\s/;

const normalise = (text: string) => text.replace(/\s+/g, " ").trim();
const isRelative = (specifier: string) => specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");

interface Masked {
  // The text with comments blanked out.
  code: string;
  // The text with comments, and the insides of strings, templates and regular expressions, blanked out.
  bare: string;
}

// Blanks keep their place, and line breaks stay, so a position means the same in all three texts.
function mask(text: string): Masked {
  const code = text.split("");
  const bare = text.split("");
  const length = text.length;
  let at = 0;

  const blank = (target: string[], from: number, to: number) => {
    for (let index = from; index < to; index++) {
      if (target[index] !== "\n") {
        target[index] = " ";
      }
    }
  };

  // Whether a "/" at `position` starts a regular expression: it does after an operator, or after a word such as `return`.
  const startsRegex = (position: number): boolean => {
    let before = position - 1;
    while (before >= 0 && SPACE.test(bare[before]!)) {
      before--;
    }
    if (before < 0) {
      return true;
    }
    const previous = bare[before]!;
    if (IDENTIFIER_CHAR.test(previous)) {
      let start = before;
      while (start > 0 && IDENTIFIER_CHAR.test(bare[start - 1]!)) {
        start--;
      }
      return BEFORE_REGEX.has(bare.slice(start, before + 1).join(""));
    }
    return !")]}\"'`".includes(previous);
  };

  // The position after a regular expression that starts at `from`, or -1 if what starts there is not one.
  const regexEnd = (from: number): number => {
    let inClass = false;
    for (let index = from + 1; index < length; index++) {
      const char = text[index]!;
      if (char === "\n") {
        return -1;
      }
      if (char === "\\") {
        index++;
      } else if (char === "[") {
        inClass = true;
      } else if (char === "]") {
        inClass = false;
      } else if (char === "/" && !inClass) {
        return index + 1;
      }
    }
    return -1;
  };

  const template = (): void => {
    const start = at;
    at++;
    let closed = false;
    while (at < length && !closed) {
      const char = text[at]!;
      if (char === "\\") {
        at += 2;
      } else if (char === "`") {
        at++;
        closed = true;
      } else if (char === "$" && text[at + 1] === "{") {
        at += 2;
        scan(true);
        at++;
      } else {
        at++;
      }
    }
    blank(bare, start + 1, closed ? at - 1 : length);
  };

  // Reads code to the end of the text or, inside a template, to the brace that closes `${`.
  function scan(inTemplate: boolean): void {
    let depth = 0;
    while (at < length) {
      const char = text[at]!;
      const next = text[at + 1];
      if (char === "/" && next === "/") {
        const newline = text.indexOf("\n", at);
        const end = newline === -1 ? length : newline;
        blank(code, at, end);
        blank(bare, at, end);
        at = end;
      } else if (char === "/" && next === "*") {
        const close = text.indexOf("*/", at + 2);
        const end = close === -1 ? length : close + 2;
        blank(code, at, end);
        blank(bare, at, end);
        at = end;
      } else if (char === '"' || char === "'") {
        let end = at + 1;
        while (end < length && text[end] !== char && text[end] !== "\n") {
          end += text[end] === "\\" ? 2 : 1;
        }
        blank(bare, at + 1, Math.min(end, length));
        at = Math.min(end + 1, length);
      } else if (char === "`") {
        template();
      } else if (char === "/" && startsRegex(at) && regexEnd(at) !== -1) {
        const end = regexEnd(at);
        blank(bare, at + 1, end - 1);
        at = end;
      } else {
        if (inTemplate) {
          if (char === "{") {
            depth++;
          } else if (char === "}") {
            if (depth === 0) {
              return;
            }
            depth--;
          }
        }
        at++;
      }
    }
  }

  scan(false);
  return { code: code.join(""), bare: bare.join("") };
}

const OPEN = "({[";
const CLOSE = ")}]";

export function extractTypeScript(text: string, options: ExtractOptions = {}): Extracted {
  const { code, bare } = mask(text);
  const length = bare.length;

  // How many brackets are open before each position.
  const depth = new Int32Array(length + 1);
  for (let index = 0, open = 0; index < length; index++) {
    depth[index] = open;
    if (OPEN.includes(bare[index]!)) {
      open++;
    } else if (CLOSE.includes(bare[index]!) && open > 0) {
      open--;
    }
    depth[index + 1] = open;
  }

  // ── Moving about in the text ─────────────────────────────────────────────

  const nextSig = (from: number): number => {
    let index = from;
    while (index < length && SPACE.test(bare[index]!)) {
      index++;
    }
    return index;
  };
  const prevSig = (before: number): number => {
    let index = before - 1;
    while (index >= 0 && SPACE.test(bare[index]!)) {
      index--;
    }
    return index;
  };
  const word = (at: number): string => {
    IDENTIFIER.lastIndex = at;
    return IDENTIFIER.exec(bare)?.[0] ?? "";
  };
  // The bracket that closes the one at `open`.
  const closeOf = (open: number): number => {
    for (let index = open + 1; index < length; index++) {
      if (depth[index + 1] === depth[open]) {
        return index;
      }
    }
    return length - 1;
  };
  // The position after the `>` that closes the `<` at `open`. The `>` of an arrow does not count.
  const afterAngles = (open: number): number => {
    let angles = 0;
    for (let index = open; index < length; index++) {
      const char = bare[index]!;
      if (OPEN.includes(char)) {
        index = closeOf(index);
      } else if (char === "<") {
        angles++;
      } else if (char === ">" && bare[index - 1] !== "=") {
        angles--;
        if (angles === 0) {
          return index + 1;
        }
      }
    }
    return length;
  };
  // The content of the string whose opening quote is at `quote`.
  const stringAt = (quote: number): string => {
    const close = bare.indexOf(bare[quote]!, quote + 1);
    return text.slice(quote + 1, close === -1 ? length : close);
  };
  const isArrow = (at: number) => bare.startsWith("=>", at);

  // Whether the line break at `at` ends a statement that has no semicolon: it does not when the
  // line before it is left open, or the line after it carries on.
  const endsStatement = (at: number): boolean => {
    const before = prevSig(at);
    const after = nextSig(at + 1);
    if (after >= length) {
      return true;
    }
    if (before >= 0 && ("=,([{<|&?:+-*/%.!~^".includes(bare[before]!) || isArrow(before - 1))) {
      return false;
    }
    return !".,|&?:+-*/%)]}=<>".includes(bare[after]!);
  };

  // Whether the brace at `open` belongs to a type written with braces and not to a body.
  const isTypeLiteral = (open: number): boolean => {
    const before = prevSig(open);
    if (before >= 0 && (":|&<,(".includes(bare[before]!) || isArrow(before - 1))) {
      return true;
    }
    const after = nextSig(closeOf(open) + 1);
    return after < length && "|&[".includes(bare[after]!);
  };

  // Where the heading of a declaration ends: at the brace that opens its body, or where a declaration without a body ends.
  const headEnd = (from: number): number => {
    for (let index = from; index < length; index++) {
      const char = bare[index]!;
      if (char === "(" || char === "[") {
        index = closeOf(index);
      } else if (char === ";") {
        return index;
      } else if (char === "{") {
        if (!isTypeLiteral(index)) {
          return index;
        }
        index = closeOf(index);
      } else if (char === "\n" && endsStatement(index) && bare[nextSig(index)] !== "{") {
        return index;
      }
    }
    return length;
  };

  // Whether what starts at `at` could be the next name of a `const a = 1, b = 2` statement.
  const startsDeclarator = (at: number): boolean => {
    if (bare[at] === "{" || bare[at] === "[") {
      return true;
    }
    const name = word(at);
    if (name === "") {
      return false;
    }
    const after = nextSig(at + name.length);
    return after >= length || "=:,;".includes(bare[after]!);
  };

  // The first position at or after `from`, outside any brackets, that holds one of `stops` or ends the statement.
  const scanTo = (from: number, stops: string): number => {
    for (let index = from; index < length; index++) {
      const char = bare[index]!;
      if (OPEN.includes(char)) {
        index = closeOf(index);
      } else if (char === "=" && stops.includes("=")) {
        if (bare[index + 1] !== ">" && bare[index + 1] !== "=" && !"=!<>".includes(bare[index - 1] ?? "")) {
          return index;
        }
      } else if (char === "," && stops.includes(",")) {
        if (startsDeclarator(nextSig(index + 1))) {
          return index;
        }
      } else if (char !== "=" && char !== "," && stops.includes(char)) {
        return index;
      } else if (char === "\n" && endsStatement(index)) {
        return index;
      }
    }
    return length;
  };

  // Where the heading of a function value ends, or -1 if the value that starts at `from` is not a function.
  const functionValueEnd = (from: number): number => {
    let at = from;
    let first = word(at);
    if (first === "async") {
      at = nextSig(at + first.length);
      first = word(at);
    }
    if (first === "function") {
      const open = bare.indexOf("(", at);
      return open === -1 ? -1 : headEnd(closeOf(open) + 1);
    }
    if (bare[at] === "<") {
      at = nextSig(afterAngles(at));
    }
    if (bare[at] === "(") {
      const after = nextSig(closeOf(at) + 1);
      if (isArrow(after)) {
        return after + 2;
      }
      if (bare[after] !== ":") {
        return -1;
      }
      // A result type stands between the parameters and the arrow.
      for (let index = after + 1; index < length; index++) {
        const char = bare[index]!;
        if (OPEN.includes(char)) {
          index = closeOf(index);
        } else if (isArrow(index)) {
          return index + 2;
        } else if (char === ";" || char === "," || (char === "\n" && endsStatement(index))) {
          return -1;
        }
      }
      return -1;
    }
    if (first !== "" && !NOT_A_PARAMETER.has(first)) {
      const after = nextSig(at + first.length);
      return isArrow(after) ? after + 2 : -1;
    }
    return -1;
  };

  // The names a pattern such as `{ a, b: c, ...rest }` or `[a, b]` binds.
  const boundNames = (pattern: string): string[] => {
    const names: string[] = [];
    let part = "";
    let open = 0;
    const take = () => {
      let item = part.trim().replace(/^\.\.\./, "");
      part = "";
      // A default value is not a name.
      let nested = 0;
      for (let index = 0; index < item.length; index++) {
        if (OPEN.includes(item[index]!)) {
          nested++;
        } else if (CLOSE.includes(item[index]!)) {
          nested--;
        } else if (nested === 0 && item[index] === "=") {
          item = item.slice(0, index).trim();
          break;
        }
      }
      // In `key: name`, the name is what is bound.
      nested = 0;
      for (let index = 0; index < item.length; index++) {
        if (OPEN.includes(item[index]!)) {
          nested++;
        } else if (CLOSE.includes(item[index]!)) {
          nested--;
        } else if (nested === 0 && item[index] === ":") {
          item = item.slice(index + 1).trim();
          break;
        }
      }
      if (item.startsWith("{") || item.startsWith("[")) {
        names.push(...boundNames(item.slice(1, -1)));
      } else if (/^[A-Za-z_$][\w$]*$/.test(item)) {
        names.push(item);
      }
    };
    for (const char of pattern) {
      if (OPEN.includes(char)) {
        open++;
      } else if (CLOSE.includes(char)) {
        open--;
      }
      if (char === "," && open === 0) {
        take();
      } else {
        part += char;
      }
    }
    take();
    return names;
  };

  // The items of an `{ a, b as c, type T }` list: the name on each side of `as`.
  const listItems = (inner: string): { source: string; exported: string }[] =>
    inner
      .split(",")
      .map((item) => normalise(item).replace(/^type\s+/, ""))
      .filter((item) => item !== "")
      .map((item) => {
        const [source, exported] = item.split(/\s+as\s+/);
        return { source: source!, exported: exported ?? source! };
      });

  // ── What is found ────────────────────────────────────────────────────────

  const found: { at: number; entry: ExtractedInterface }[] = [];
  const imports: ExtractedImport[] = [];
  // The names this module imports from the repository, by the name they have here.
  const bindings = new Map<string, { specifier: string; name: string }>();

  const addInterface = (at: number, entry: ExtractedInterface) => {
    // The declarations of an overloaded function are one contract.
    const earlier = found.find((other) => other.entry.name === entry.name && other.entry.kind === "function" && entry.kind === "function");
    if (earlier !== undefined) {
      earlier.entry.signature += `; ${entry.signature}`;
    } else {
      found.push({ at, entry });
    }
  };

  const addImport = (specifier: string, names: string[], via: ExtractedImport["via"]) => {
    if (!isRelative(specifier) || names.length === 0) {
      return;
    }
    let entry = imports.find((other) => other.specifier === specifier && other.via === via);
    if (entry === undefined) {
      entry = { specifier, names: [], via };
      imports.push(entry);
    }
    for (const name of names) {
      if (!entry.names.includes(name)) {
        entry.names.push(name);
      }
    }
  };

  // The `export` or `import` statements at the top level, in order.
  const statements = (keyword: string): number[] => {
    const starts: number[] = [];
    const pattern = new RegExp(`\\b${keyword}\\b`, "g");
    for (const match of bare.matchAll(pattern)) {
      const at = match.index;
      const before = bare[at - 1] ?? "";
      if (depth[at] === 0 && before !== "." && !IDENTIFIER_CHAR.test(before)) {
        starts.push(at);
      }
    }
    return starts;
  };

  // ── Imports ──────────────────────────────────────────────────────────────

  for (const start of statements("import")) {
    let at = nextSig(start + "import".length);
    if (at >= length || "(.\"'`".includes(bare[at]!)) {
      continue;
    }
    if (word(at) === "type" && !"=,".includes(bare[nextSig(at + 4)] ?? "") && word(nextSig(at + 4)) !== "from") {
      at = nextSig(at + 4);
    }
    const quote = bare.slice(at).search(/["']/);
    const semicolon = bare.indexOf(";", at);
    if (quote === -1 || (semicolon !== -1 && semicolon < at + quote)) {
      continue;
    }
    const clause = bare.slice(at, at + quote);
    if (!/\bfrom\s*$/.test(clause)) {
      continue;
    }
    const specifier = stringAt(at + quote);
    const names: string[] = [];
    const open = clause.indexOf("{");
    const star = clause.indexOf("*");
    const leading = clause.slice(0, open !== -1 ? open : star !== -1 ? star : clause.search(/\bfrom\s*$/));
    const defaultName = /[A-Za-z_$][\w$]*/.exec(leading)?.[0];
    if (defaultName !== undefined) {
      names.push("default");
      bindings.set(defaultName, { specifier, name: "default" });
    }
    if (star !== -1 && open === -1) {
      names.push("*");
    }
    if (open !== -1) {
      for (const item of listItems(clause.slice(open + 1, clause.indexOf("}", open)))) {
        names.push(item.source);
        bindings.set(item.exported, { specifier, name: item.source });
      }
    }
    addImport(specifier, [...new Set(names)], "import");
  }

  // `require("./x")` and `import("./x")` can stand anywhere.
  for (const match of bare.matchAll(/\b(require|import)\s*\(\s*(["'`])/g)) {
    const before = bare[match.index - 1] ?? "";
    if (before === "." || IDENTIFIER_CHAR.test(before)) {
      continue;
    }
    const specifier = stringAt(match.index + match[0].length - 1);
    const taken = /(?:const|let|var)\s+\{([^}]*)\}\s*=\s*$/.exec(bare.slice(Math.max(0, match.index - 400), match.index));
    const names = match[1] === "require" && taken !== null ? listItems(taken[1]!.replace(/:/g, " as ")).map((item) => item.source) : ["*"];
    addImport(specifier, names, "import");
  }

  // ── Exports ──────────────────────────────────────────────────────────────

  const exportList = (start: number, open: number): void => {
    const close = closeOf(open);
    const after = nextSig(close + 1);
    const from = word(after) === "from" ? nextSig(after + 4) : -1;
    const specifier = from === -1 ? null : stringAt(from);
    const origin = specifier === null ? "" : ` from ${text[from]}${specifier}${text[from]}`;
    const items = listItems(bare.slice(open + 1, close));
    for (const item of items) {
      const written = item.source === item.exported ? item.source : `${item.source} as ${item.exported}`;
      const signature = `export { ${written} }${origin}`;
      const passedOn =
        specifier === null ? bindings.get(item.source) : isRelative(specifier) ? { specifier, name: item.source } : undefined;
      addInterface(
        start,
        passedOn === undefined
          ? { name: item.exported, kind: "const", signature }
          : { name: item.exported, kind: "reexport", signature, from: passedOn },
      );
    }
    if (specifier !== null) {
      addImport(
        specifier,
        items.map((item) => item.source),
        "reexport",
      );
    }
  };

  const exportStar = (start: number, star: number): void => {
    let at = nextSig(star + 1);
    let name: string | null = null;
    if (word(at) === "as") {
      at = nextSig(at + 2);
      name = word(at);
      at = nextSig(at + name.length);
    }
    if (word(at) !== "from") {
      return;
    }
    const quote = nextSig(at + 4);
    const specifier = stringAt(quote);
    if (name !== null) {
      const signature = `export * as ${name} from ${text[quote]}${specifier}${text[quote]}`;
      addInterface(
        start,
        isRelative(specifier)
          ? { name, kind: "reexport", signature, from: { specifier, name: "*" } }
          : { name, kind: "const", signature },
      );
    }
    addImport(specifier, ["*"], "reexport");
  };

  const exportFunction = (start: number, keyword: number, name: string | null): void => {
    let at = nextSig(keyword + "function".length);
    if (bare[at] === "*") {
      at = nextSig(at + 1);
    }
    const own = word(at);
    const open = bare.indexOf("(", at);
    if (open === -1) {
      return;
    }
    const end = headEnd(closeOf(open) + 1);
    addInterface(start, { name: name ?? own, kind: "function", signature: normalise(code.slice(start, end)) });
  };

  const exportClass = (start: number, keyword: number, name: string | null): void => {
    const at = nextSig(keyword + "class".length);
    const own = word(at);
    const named = own !== "" && own !== "extends" && own !== "implements";
    const end = headEnd(at);
    addInterface(start, {
      name: name ?? (named ? own : "default"),
      kind: "class",
      signature: normalise(code.slice(start, end)),
    });
  };

  // An interface or an enum: everything to the brace that closes it.
  const exportBraced = (start: number, keyword: number, keywordLength: number): void => {
    const at = nextSig(keyword + keywordLength);
    const open = headEnd(at);
    if (bare[open] !== "{") {
      return;
    }
    addInterface(start, { name: word(at), kind: "type", signature: normalise(code.slice(start, closeOf(open) + 1)) });
  };

  const exportTypeAlias = (start: number, keyword: number): void => {
    const at = nextSig(keyword + "type".length);
    addInterface(start, { name: word(at), kind: "type", signature: normalise(code.slice(start, scanTo(at, ";"))) });
  };

  const exportVariables = (start: number, afterKeyword: number): void => {
    const head = normalise(code.slice(start, afterKeyword));
    let at = afterKeyword;
    for (;;) {
      at = nextSig(at);
      const declared = at;
      let names: string[];
      const single = bare[at] !== "{" && bare[at] !== "[";
      if (single) {
        const name = word(at);
        if (name === "") {
          return;
        }
        names = [name];
        at += name.length;
      } else {
        const close = closeOf(at);
        names = boundNames(bare.slice(at + 1, close));
        at = close + 1;
      }

      const stop = scanTo(at, "=,;");
      let signatureEnd = stop;
      let kind: InterfaceKind = "const";
      let next = stop;
      if (bare[stop] === "=") {
        const value = nextSig(stop + 1);
        const functionEnd = single ? functionValueEnd(value) : -1;
        if (functionEnd !== -1) {
          kind = "function";
          signatureEnd = functionEnd;
        }
        next = scanTo(value, ",;");
      }
      for (const name of names) {
        addInterface(start, {
          name,
          kind,
          signature: single ? `${head} ${normalise(code.slice(declared, signatureEnd))}` : `${head} ${name}`,
        });
      }
      if (bare[next] !== ",") {
        return;
      }
      at = next + 1;
    }
  };

  for (const start of statements("export")) {
    let at = nextSig(start + "export".length);
    if (bare[at] === "{") {
      exportList(start, at);
      continue;
    }
    if (bare[at] === "*") {
      exportStar(start, at);
      continue;
    }

    let name: string | null = null;
    let first = word(at);
    if (first === "default") {
      name = "default";
      at = nextSig(at + first.length);
      first = word(at);
    }
    if (first === "declare") {
      at = nextSig(at + first.length);
      first = word(at);
    }
    const second = () => word(nextSig(at + first.length));

    if (first === "function" || (first === "async" && second() === "function")) {
      exportFunction(start, first === "function" ? at : nextSig(at + first.length), name);
    } else if (first === "class" || (first === "abstract" && second() === "class")) {
      exportClass(start, first === "class" ? at : nextSig(at + first.length), name);
    } else if (name === "default") {
      addInterface(start, { name, kind: "const", signature: "export default" });
    } else if (first === "interface" || first === "enum") {
      exportBraced(start, at, first.length);
    } else if (first === "const" && second() === "enum") {
      exportBraced(start, nextSig(at + first.length), "enum".length);
    } else if (first === "type") {
      const after = nextSig(at + first.length);
      if (bare[after] === "{") {
        exportList(start, after);
      } else if (bare[after] === "*") {
        exportStar(start, after);
      } else {
        exportTypeAlias(start, at);
      }
    } else if (first === "const" || first === "let" || first === "var") {
      exportVariables(start, at + first.length);
    }
  }

  // ── Routes ───────────────────────────────────────────────────────────────

  for (const pattern of options.routes ?? DEFAULT_ROUTE_PATTERNS) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of code.matchAll(new RegExp(pattern.source, flags))) {
      const method = match.groups?.method?.toUpperCase();
      const path = match.groups?.pattern;
      if (method === undefined || path === undefined) {
        continue;
      }
      found.push({
        at: match.index,
        entry: { name: `${method === "ALL" ? "*" : method} ${path}`, kind: "route", signature: normalise(match[0]) },
      });
    }
  }

  return {
    interfaces: found.sort((a, b) => a.at - b.at).map((item) => item.entry),
    imports,
  };
}
