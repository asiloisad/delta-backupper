let active = 0;
const waiting: Array<() => void> = [];

/** Keep two default libuv threads free when task files on USB/NAS stop responding. */
export async function withTaskReadSlot<T>(read: () => Promise<T>): Promise<T> {
  await new Promise<void>(resolve => { const start = () => { active++; resolve(); }; if (active < 2) start(); else waiting.push(start); });
  try { return await read(); }
  finally { active--; waiting.shift()?.(); }
}
