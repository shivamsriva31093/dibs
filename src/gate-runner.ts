// Runs a repository's checks in a container on Cloudflare: one Durable Object, and one
// fresh container, per run. The container fetches the change joined with main from
// a hidden ref of the main repository, runs the setup and the checks, and is destroyed.
//
// No secret enters the container. Git's requests to the repository host are taken by
// GitGateway, in this Worker, which lets through only reads of the one repository under
// check and adds a short-lived token to them. Unless the repository asks for it, the
// container cannot reach anything else: the code under check cannot send anything anywhere.

import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { TIMED_OUT, type Gate, type GateRequest, type GateResult, type GateStep } from "./gate";

const WORKSPACE = "/workspace";
// The certificate the container trusts for requests that are taken by a Worker on their way out.
const INTERCEPT_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
const OUTPUT_KEPT = 8000;
const FETCH_TIMEOUT_SECONDS = 120;
const TOKEN_TTL_SECONDS = 300;
// How long to keep trying the first command while a fresh container comes up.
const READY_ATTEMPTS = 30;
const READY_WAIT_MS = 1000;

// Whether a request reads the repository at `remote` over git's HTTP protocol, and nothing else.
export function isRepositoryRead(request: Request, remote: string): boolean {
  const url = new URL(request.url);
  const repository = new URL(remote);
  if (url.host !== repository.host) {
    return false;
  }
  const base = repository.pathname.replace(/\/$/, "");
  return (
    (request.method === "GET" && url.pathname === `${base}/info/refs` && url.search === "?service=git-upload-pack") ||
    (request.method === "POST" && url.pathname === `${base}/git-upload-pack`)
  );
}

// The end of what a command printed, with a word on what was left out.
export function outputTail(bytes: ArrayBuffer, keep: number = OUTPUT_KEPT): string {
  const text = new TextDecoder().decode(bytes);
  return text.length <= keep ? text : `(the first ${text.length - keep} characters are left out)\n${text.slice(-keep)}`;
}

// Takes the container's requests to the repository host. Built for one repository, through `props`.
export class GitGateway extends WorkerEntrypoint<Env, { repo: string }> {
  override async fetch(request: Request): Promise<Response> {
    using repo = await this.env.ARTIFACTS.get(this.ctx.props.repo);
    const { remote } = await repo.info();
    if (!isRepositoryRead(request, remote)) {
      return new Response("dibs lets the checks read their own repository and nothing else\n", { status: 403 });
    }
    const token = (await repo.createToken("read", TOKEN_TTL_SECONDS)).plaintext;
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${token}`);
    return fetch(new Request(request, { headers }));
  }
}

export class GateRunner extends DurableObject<Env> {
  async run(request: GateRequest): Promise<GateResult> {
    const container = this.ctx.container;
    if (container === undefined) {
      throw new Error("this deployment has no container to run the checks in");
    }
    const started = Date.now();
    const steps: GateStep[] = [];
    const result = (outcome: GateResult["outcome"], error?: string): GateResult => ({
      outcome,
      candidateSha: request.candidateSha,
      baseSha: request.baseSha,
      treeSha: request.treeSha,
      seconds: (Date.now() - started) / 1000,
      steps,
      ...(error === undefined ? {} : { error }),
    });

    // Runs one command to completion, killed after `seconds`; both of its streams are kept together.
    const exec = async (command: string[], seconds: number, env: Record<string, string> = {}) => {
      const begun = Date.now();
      const process = await container.exec(["timeout", "--kill-after=5", String(seconds), ...command], {
        cwd: WORKSPACE,
        env: { HOME: "/root", CI: "1", GIT_SSL_CAINFO: INTERCEPT_CA, NODE_EXTRA_CA_CERTS: INTERCEPT_CA, ...env },
        stderr: "combined",
      });
      const output = await process.output();
      return { exitCode: output.exitCode, seconds: (Date.now() - begun) / 1000, output: outputTail(output.stdout) };
    };

    try {
      if (container.running) {
        await container.destroy();
      }
      await container.interceptOutboundHttps(
        new URL(request.remote).hostname,
        this.ctx.exports.GitGateway({ props: { repo: request.repo } }),
      );
      container.start({ image: container.images.gate!, enableInternet: request.config.internet, instance: "standard-1" });

      // The first command also waits for the container to come up.
      let fetched: Awaited<ReturnType<typeof exec>> | null = null;
      for (let attempt = 1; fetched === null; attempt++) {
        try {
          await container.exec(["mkdir", "-p", WORKSPACE]).then((process) => process.exitCode);
          fetched = await exec(
            ["sh", "-c", 'git init -q . && git fetch -q --depth=1 "$REMOTE" "$REF" && git checkout -q FETCH_HEAD && git rev-parse HEAD'],
            FETCH_TIMEOUT_SECONDS,
            { REMOTE: request.remote, REF: request.ref },
          );
        } catch (error) {
          if (attempt >= READY_ATTEMPTS) {
            throw error;
          }
          await new Promise((resolve) => setTimeout(resolve, READY_WAIT_MS));
        }
      }
      if (fetched.exitCode !== 0 || fetched.output.trim().split("\n").at(-1) !== request.candidateSha) {
        return result("error", `could not fetch the change into the container: ${fetched.output.trim().slice(-500)}`);
      }

      const commands = [
        ...(request.config.setup === null ? [] : [{ name: "setup", run: request.config.setup }]),
        ...request.config.checks,
      ];
      for (const command of commands) {
        const ran = await exec(["sh", "-c", command.run], request.config.timeoutSeconds);
        steps.push({ name: command.name, command: command.run, exitCode: ran.exitCode, seconds: ran.seconds, output: ran.output });
        if (ran.exitCode !== 0) {
          return result("fail");
        }
      }
      return result("pass");
    } catch (error) {
      return result("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (container.running) {
        await container.destroy();
      }
    }
  }
}

// The gate as the review pipeline uses it: each run in its own Durable Object, and so in its own container.
export class SandboxGate implements Gate {
  constructor(private readonly namespace: DurableObjectNamespace<GateRunner>) {}

  async run(request: GateRequest): Promise<GateResult> {
    return this.namespace.getByName(`${request.repo}:${request.treeSha}:${Date.now().toString(36)}`).run(request);
  }
}

export { TIMED_OUT };
