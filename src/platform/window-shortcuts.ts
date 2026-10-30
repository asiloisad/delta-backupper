export interface WindowShortcutInput { type: string; key: string; control?: boolean; shift?: boolean; alt?: boolean; meta?: boolean }

export function windowShortcut(input: WindowShortcutInput, platform: NodeJS.Platform): "devtools" | undefined {
  if (input.type !== "keyDown") return;
  const controlShift = input.control && input.shift && !input.alt && !input.meta;
  if (input.key === "F12" || input.key.toLowerCase() === "i" && (controlShift || platform === "darwin" && input.meta && input.alt && !input.control && !input.shift)) return "devtools";
}
