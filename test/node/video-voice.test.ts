import { describe, expect, it } from "vitest";
import { clipName, fishSpeech, spokenForm } from "../../video/voice";

// The video's narration is spoken by Fish Audio's text-to-speech API: one address, the model
// named in a header, the voice as a reference_id, and patience when the service says to wait.

const audio = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]);
const ok = () => new Response(audio, { status: 200, headers: { "content-type": "audio/mpeg" } });

// A stand-in for fetch that answers from a list and remembers what it was asked.
function answering(answers: (() => Response | Promise<Response>)[]) {
  const asked: { url: string; init: RequestInit }[] = [];
  const waits: number[] = [];
  return {
    asked,
    waits,
    options: {
      key: "fish-key-123",
      voice: "voice-abc",
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        asked.push({ url: String(url), init: init ?? {} });
        const answer = answers[asked.length - 1];
        if (answer === undefined) {
          throw new Error("asked more often than expected");
        }
        return answer();
      }) as typeof fetch,
      sleep: async (ms: number) => {
        waits.push(ms);
      },
    },
  };
}

describe("spokenForm", () => {
  const map = [
    { term: "findUser", say: "find user" },
    { term: "MIT", say: "M I T" },
    { term: "sync_with_main", say: "sync with main" },
  ];

  it("writes a term the way it is to be said, wherever it stands", () => {
    expect(spokenForm("findUser changed. The route calls findUser.", map)).toBe("find user changed. The route calls find user.");
    expect(spokenForm("The source is under the MIT licence.", map)).toBe("The source is under the M I T licence.");
  });

  it("leaves a line without any of the terms as it is", () => {
    expect(spokenForm("Five agents, five changes on main.", map)).toBe("Five agents, five changes on main.");
  });

  it("takes the longest term first, so that a term inside another does not spoil it", () => {
    const nested = [
      { term: "main", say: "the main branch" },
      { term: "sync_with_main", say: "sync with main" },
    ];

    expect(spokenForm("It calls sync_with_main.", nested)).toBe("It calls sync with main.");
  });

  it("skips an entry that says a term as it is written", () => {
    expect(spokenForm("dibs", [{ term: "dibs", say: "dibs" }])).toBe("dibs");
  });
});

describe("fishSpeech", () => {
  it("asks Fish Audio for speech with the model in a header and the voice in the body", async () => {
    const fish = answering([ok]);

    await fishSpeech("Call dibs before you edit.", fish.options);

    expect(fish.asked).toHaveLength(1);
    const { url, init } = fish.asked[0]!;
    expect(url).toBe("https://api.fish.audio/v1/tts");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer fish-key-123", "Content-Type": "application/json", model: "s2.1-pro-free" });
    expect(JSON.parse(String(init.body))).toEqual({
      text: "Call dibs before you edit.",
      reference_id: "voice-abc",
      format: "mp3",
      mp3_bitrate: 128,
      normalize: true,
      latency: "normal",
    });
  });

  it("returns the sound it is given", async () => {
    const fish = answering([ok]);

    expect(await fishSpeech("A line.", fish.options)).toEqual(audio);
  });

  it("names another model when one is asked for", async () => {
    const fish = answering([ok]);

    await fishSpeech("A line.", { ...fish.options, model: "s2.1-pro" });

    expect((fish.asked[0]!.init.headers as Record<string, string>).model).toBe("s2.1-pro");
  });

  it.each([429, 402])("waits half a minute and asks again when it is answered %i", async (status) => {
    const fish = answering([() => new Response("slow down", { status }), ok]);

    expect(await fishSpeech("A line.", fish.options)).toEqual(audio);
    expect(fish.asked).toHaveLength(2);
    expect(fish.waits).toEqual([30_000]);
  });

  it("gives up after the third such answer", async () => {
    const busy = () => new Response("slow down", { status: 429 });
    const fish = answering([busy, busy, busy]);

    await expect(fishSpeech("A line.", fish.options)).rejects.toThrow("HTTP 429 after 3 attempts");
    expect(fish.waits).toEqual([30_000, 30_000]);
  });

  it("asks again after five seconds when the request itself fails", async () => {
    const fish = answering([
      () => {
        throw new TypeError("fetch failed");
      },
      ok,
    ]);

    expect(await fishSpeech("A line.", fish.options)).toEqual(audio);
    expect(fish.waits).toEqual([5_000]);
  });

  it("gives up when the request fails three times", async () => {
    const down = () => {
      throw new TypeError("fetch failed");
    };
    const fish = answering([down, down, down]);

    await expect(fishSpeech("A line.", fish.options)).rejects.toThrow("TypeError: fetch failed");
    expect(fish.asked).toHaveLength(3);
  });

  it("does not ask again when it is refused for another reason, and says what it was told", async () => {
    const fish = answering([() => new Response('{"message":"reference not found"}', { status: 400 })]);

    await expect(fishSpeech("A line.", fish.options)).rejects.toThrow('HTTP 400 {"message":"reference not found"}');
    expect(fish.asked).toHaveLength(1);
    expect(fish.waits).toEqual([]);
  });

  it("never puts the key in what it reports", async () => {
    const fish = answering([() => new Response("bad key fish-key-123?", { status: 401 })]);

    const failure = await fishSpeech("A line.", fish.options).catch((error: Error) => error.message);

    expect(failure).toContain("HTTP 401");
    expect(failure).not.toContain("fish-key-123");
  });
});

describe("clipName", () => {
  it("is the same for the same line in the same voice, so that a clip is made once", () => {
    expect(clipName("A line.", "fish", "voice-abc")).toBe(clipName("A line.", "fish", "voice-abc"));
  });

  it("differs when the line, the voice or the engine differs", () => {
    const name = clipName("A line.", "fish", "voice-abc");

    expect(clipName("Another line.", "fish", "voice-abc")).not.toBe(name);
    expect(clipName("A line.", "fish", "voice-xyz")).not.toBe(name);
    expect(clipName("A line.", "say", "voice-abc")).not.toBe(name);
  });

  it("is a plain file name", () => {
    expect(clipName("What it does not do. Claims are on paths/…", "fish", "voice-abc")).toMatch(/^[0-9a-f]{24}$/);
  });
});
