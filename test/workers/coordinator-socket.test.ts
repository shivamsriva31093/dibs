import { describe, expect, it, vi } from "vitest";
import { newAgent, newCoordinator } from "./helpers/coordinator";

describe("the board's live connection", () => {
  it("receives each new event as it is recorded", async () => {
    const coordinator = await newCoordinator();
    const response = await coordinator.fetch(new Request("https://dibs.invalid/ws", { headers: { upgrade: "websocket" } }));
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const received: { type: string; body: Record<string, unknown> }[] = [];
    socket.addEventListener("message", (event) => {
      received.push(JSON.parse(event.data as string));
    });

    const agentId = await newAgent(coordinator, "agent-one");
    const started = await coordinator.startTask({ agentId, goal: "Add users", paths: ["src/users/"] });
    if (!started.ok) {
      throw new Error("expected the claim to be granted");
    }
    await coordinator.abandon({ agentId, taskId: started.task.id });

    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toMatchObject([
      { id: 1, type: "task_started", taskId: started.task.id, body: { agent: "agent-one", goal: "Add users" } },
      { id: 2, type: "abandoned", taskId: started.task.id },
    ]);
    socket.close();
  });

  it("selects the dibs subprotocol when the client offers it, as a browser requires", async () => {
    const coordinator = await newCoordinator();

    const offered = await coordinator.fetch(
      new Request("https://dibs.invalid/ws", { headers: { upgrade: "websocket", "sec-websocket-protocol": "dibs, token.abc" } }),
    );
    const plain = await coordinator.fetch(new Request("https://dibs.invalid/ws", { headers: { upgrade: "websocket" } }));

    expect(offered.headers.get("sec-websocket-protocol")).toBe("dibs");
    expect(plain.headers.get("sec-websocket-protocol")).toBeNull();
    for (const response of [offered, plain]) {
      response.webSocket!.accept();
      response.webSocket!.close();
    }
  });

  it("refuses a request that is not a WebSocket upgrade", async () => {
    const coordinator = await newCoordinator();

    const response = await coordinator.fetch(new Request("https://dibs.invalid/ws"));

    expect(response.status).toBe(426);
    await response.body?.cancel();
  });
});
