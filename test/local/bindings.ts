// Stand-ins for the Artifacts and Workers AI bindings, for running dibs on one
// machine. Each call is forwarded over HTTP to the platform stand-in
// (platform.ts), and results and errors come back in the binding's own shapes,
// so the code that uses the bindings runs unchanged.

type ErrorBody = { ok: false; code: ArtifactsErrorCode; numericCode: number; message: string };

class LocalArtifactsError extends Error implements ArtifactsError {
  override readonly name = "ArtifactsError";
  readonly code: ArtifactsErrorCode;
  readonly numericCode: number;

  constructor(body: ErrorBody) {
    super(body.message);
    this.code = body.code;
    this.numericCode = body.numericCode;
  }
}

async function call<T>(url: string, method: string, repo: string | null, args: unknown[]): Promise<T> {
  const response = await fetch(`${url}/artifacts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, repo, args }),
  });
  const body = (await response.json()) as { ok: true; value: T } | ErrorBody;
  if (!body.ok) {
    throw new LocalArtifactsError(body);
  }
  return body.value;
}

function toBlob(file: { base64: string; type: string } | null): Blob | null {
  if (file === null) {
    return null;
  }
  const bytes = Uint8Array.from(atob(file.base64), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: file.type });
}

function notOffered(method: string): never {
  throw new LocalArtifactsError({
    ok: false,
    code: "INTERNAL_ERROR",
    numericCode: 10400,
    message: `the local stand-in for Artifacts does not offer ${method}`,
  });
}

export function localArtifacts(url: string): Artifacts {
  const handle = (name: string): ArtifactsRepo => {
    // Like the real handle, this one stops working once it has been disposed.
    let disposed = false;
    const on = <T>(method: string, args: unknown[]): Promise<T> =>
      disposed ? Promise.reject(new Error("RPC stub used after being disposed.")) : call<T>(url, method, name, args);
    return {
      createToken: (scope, ttl) => on("createToken", [scope, ttl]),
      listTokens: async () => notOffered("listTokens"),
      revokeToken: async () => notOffered("revokeToken"),
      info: () => on("info", []),
      readBlob: async (hash) => toBlob(await on("readBlob", [hash])),
      readTree: (hash) => on("readTree", [hash]),
      readCommit: (hash) => on("readCommit", [hash]),
      readFile: async (args) => toBlob(await on("readFile", [args])),
      log: (opts) => on("log", [opts]),
      fork: (forkName, opts) => on("fork", [forkName, opts]),
      [Symbol.dispose]: () => {
        disposed = true;
      },
    };
  };

  return {
    create: (name, opts) => call(url, "create", null, [name, opts]),
    get: async (name) => {
      await call(url, "get", null, [name]);
      return handle(name);
    },
    import: (params) => call(url, "import", null, [params]),
    list: async () => notOffered("list"),
    delete: async () => notOffered("delete"),
  };
}

// Only `run` is offered: it is the one method dibs calls.
export function localAi(url: string): Pick<Ai, "run"> {
  const run = async (model: string, inputs: unknown, options?: { signal?: AbortSignal }): Promise<unknown> => {
    const response = await fetch(`${url}/ai`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, inputs }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) {
      throw new Error(`the local stand-in for Workers AI answered ${response.status}`);
    }
    return response.json();
  };
  return { run: run as Ai["run"] };
}
