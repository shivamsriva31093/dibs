// The demo video as data. A part is a run of pictures, each shown from its moment until
// the next one, and the lines spoken over them. Times are in seconds from the part's start.

export interface Shot {
  file: string;
  t: number;
}

export interface Spoken {
  file: string;
  start: number;
  duration: number;
  text: string;
}

export interface Part {
  duration: number;
  shots: Shot[];
  spoken: Spoken[];
}

// What lies between two moments of a part, with time starting again at zero. It opens on
// the picture that was showing at the first moment. A line that began before it is left out.
export function cut(part: Part, from: number, to: number): Part {
  const showing = Math.max(0, part.shots.findLastIndex((shot) => shot.t <= from));
  return {
    duration: to - from,
    shots: part.shots
      .slice(showing)
      .filter((shot, index) => index === 0 || shot.t < to)
      .map((shot, index) => ({ file: shot.file, t: index === 0 ? 0 : shot.t - from })),
    spoken: part.spoken.filter((line) => line.start >= from && line.start < to).map((line) => ({ ...line, start: line.start - from })),
  };
}

// Several parts one after another, on one clock.
export function join(parts: Part[]): Part {
  const whole: Part = { duration: 0, shots: [], spoken: [] };
  for (const part of parts) {
    const offset = whole.duration;
    whole.shots.push(...part.shots.map((shot) => ({ file: shot.file, t: shot.t + offset })));
    whole.spoken.push(...part.spoken.map((line) => ({ ...line, start: line.start + offset })));
    whole.duration += part.duration;
  }
  return whole;
}

// Tolerance for a moment that is a frame's own time but not exactly so as a number.
const EPSILON = 1e-9;

// Which picture each frame of the video shows, as runs of the same picture. A frame shows the
// latest picture whose moment has come, so a picture replaced before the next frame is never seen.
export function frames(part: Part, fps: number): { file: string; count: number }[] {
  const runs: { file: string; count: number }[] = [];
  if (part.shots.length === 0) {
    return runs;
  }
  const total = Math.round(part.duration * fps);
  let showing = 0;
  for (let frame = 0; frame < total; frame++) {
    const now = frame / fps + EPSILON;
    while (showing + 1 < part.shots.length && part.shots[showing + 1]!.t <= now) {
      showing++;
    }
    const file = part.shots[showing]!.file;
    const last = runs.at(-1);
    if (last !== undefined && last.file === file) {
      last.count++;
    } else {
      runs.push({ file, count: 1 });
    }
  }
  return runs;
}
