export function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

export function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1_000).toISOString();
}

export function addMinutes(iso: string, minutes: number): string {
  return addSeconds(iso, minutes * 60);
}
