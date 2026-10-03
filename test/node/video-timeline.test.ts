import { describe, expect, it } from "vitest";
import { cut, frames, join, type Part } from "../../video/timeline";

// The demo video is put together from parts: each is a run of pictures, every one
// shown from its moment until the next, and the lines spoken over them.

const line = (file: string, start: number, duration = 1) => ({ file, start, duration, text: file });

describe("cut", () => {
  const recording: Part = {
    duration: 10,
    shots: [
      { file: "a", t: 0 },
      { file: "b", t: 2 },
      { file: "c", t: 2.5 },
      { file: "d", t: 7 },
    ],
    spoken: [line("one", 1), line("two", 3), line("three", 8)],
  };

  it("keeps what lies between two moments, with time starting again at zero", () => {
    expect(cut(recording, 2, 8)).toEqual({
      duration: 6,
      shots: [
        { file: "b", t: 0 },
        { file: "c", t: 0.5 },
        { file: "d", t: 5 },
      ],
      spoken: [line("two", 1)],
    });
  });

  it("starts with the picture that was showing at the first moment", () => {
    expect(cut(recording, 4, 6)).toEqual({ duration: 2, shots: [{ file: "c", t: 0 }], spoken: [] });
  });

  it("starts with the earliest picture when none was showing yet", () => {
    const late: Part = { duration: 5, shots: [{ file: "a", t: 3 }], spoken: [] };

    expect(cut(late, 1, 5).shots).toEqual([{ file: "a", t: 0 }]);
  });

  it("leaves out a line that was already being spoken at the first moment", () => {
    expect(cut(recording, 1.5, 4).spoken).toEqual([line("two", 1.5)]);
  });

  it("gives the whole recording when cut at its ends", () => {
    expect(cut(recording, 0, 10)).toEqual(recording);
  });

  it("does not round the times it moves", () => {
    const part: Part = { duration: 1, shots: [{ file: "a", t: 0 }, { file: "b", t: 0.4 }], spoken: [line("one", 0.7)] };

    const result = cut(part, 0.1, 1);

    expect(result.shots[1]!.t).toBeCloseTo(0.3, 10);
    expect(result.spoken[0]!.start).toBeCloseTo(0.6, 10);
    expect(result.duration).toBeCloseTo(0.9, 10);
  });
});

describe("join", () => {
  it("puts parts one after another on one clock", () => {
    const first: Part = { duration: 4, shots: [{ file: "card", t: 0 }], spoken: [line("hello", 0.5, 3)] };
    const second: Part = { duration: 6, shots: [{ file: "a", t: 0 }, { file: "b", t: 5 }], spoken: [line("run", 1)] };
    const third: Part = { duration: 2, shots: [{ file: "end", t: 0 }], spoken: [] };

    expect(join([first, second, third])).toEqual({
      duration: 12,
      shots: [
        { file: "card", t: 0 },
        { file: "a", t: 4 },
        { file: "b", t: 9 },
        { file: "end", t: 10 },
      ],
      spoken: [line("hello", 0.5, 3), line("run", 5)],
    });
  });

  it("is empty for no parts", () => {
    expect(join([])).toEqual({ duration: 0, shots: [], spoken: [] });
  });
});

describe("frames", () => {
  it("says how many frames each picture is shown for", () => {
    const part: Part = { duration: 2, shots: [{ file: "a", t: 0 }, { file: "b", t: 0.5 }, { file: "c", t: 1.5 }], spoken: [] };

    expect(frames(part, 10)).toEqual([
      { file: "a", count: 5 },
      { file: "b", count: 10 },
      { file: "c", count: 5 },
    ]);
  });

  it("makes exactly as many frames as the part is long", () => {
    const part: Part = { duration: 7.26, shots: [{ file: "a", t: 0 }, { file: "b", t: 3.333 }], spoken: [] };

    const total = frames(part, 30).reduce((sum, run) => sum + run.count, 0);

    expect(total).toBe(Math.round(7.26 * 30));
  });

  it("leaves out a picture that is replaced before the next frame", () => {
    const part: Part = {
      duration: 1,
      shots: [{ file: "a", t: 0 }, { file: "b", t: 0.51 }, { file: "c", t: 0.52 }, { file: "d", t: 0.58 }],
      spoken: [],
    };

    // At ten frames a second the frames are at 0, 0.1, ... 0.9. The one at 0.6 is the first after b, c and d.
    expect(frames(part, 10)).toEqual([
      { file: "a", count: 6 },
      { file: "d", count: 4 },
    ]);
  });

  it("shows a picture from the frame at its own moment", () => {
    const part: Part = { duration: 0.4, shots: [{ file: "a", t: 0 }, { file: "b", t: 0.2 }], spoken: [] };

    expect(frames(part, 10)).toEqual([
      { file: "a", count: 2 },
      { file: "b", count: 2 },
    ]);
  });

  it("opens on the first picture even when it comes a little late", () => {
    const part: Part = { duration: 1, shots: [{ file: "a", t: 0.25 }], spoken: [] };

    expect(frames(part, 10)).toEqual([{ file: "a", count: 10 }]);
  });

  it("counts a picture shown twice in a row as one run", () => {
    const part: Part = { duration: 1, shots: [{ file: "a", t: 0 }, { file: "a", t: 0.5 }], spoken: [] };

    expect(frames(part, 10)).toEqual([{ file: "a", count: 10 }]);
  });

  it("has no frames for a part without pictures", () => {
    expect(frames({ duration: 3, shots: [], spoken: [] }, 30)).toEqual([]);
  });
});
