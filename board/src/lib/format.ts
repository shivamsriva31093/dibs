export function timeLeft(ms: number): string {
  if (ms <= 0) {
    return "expired";
  }
  if (ms < 60_000) {
    return "under a minute left";
  }
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  if (hours === 0) {
    return `${minutes}m left`;
  }
  return minutes === 0 ? `${hours}h left` : `${hours}h ${minutes}m left`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}
