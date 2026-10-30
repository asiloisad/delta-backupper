import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("delta", {
  request: (request: unknown) => ipcRenderer.invoke("delta:request", request),
  onProgress: (callback: (operation: unknown) => void) => {
    const listener = (_event: unknown, operation: unknown) => callback(operation);
    ipcRenderer.on("delta:operation", listener);
    return () => ipcRenderer.removeListener("delta:operation", listener);
  },
  onWindowState: (callback: (state: unknown) => void) => {
    const listener = (_event: unknown, state: unknown) => callback(state);
    ipcRenderer.on("delta:window-state", listener);
    return () => ipcRenderer.removeListener("delta:window-state", listener);
  },
  onStylesError: (callback: (message: string) => void) => {
    const listener = (_event: unknown, message: string) => callback(message);
    ipcRenderer.on("delta:styles-error", listener);
    return () => ipcRenderer.removeListener("delta:styles-error", listener);
  },
  onNavigate: (callback: (destination: { taskId: string; tab: "activity" }) => void) => {
    const listener = (_event: unknown, destination: { taskId: string; tab: "activity" }) => callback(destination);
    ipcRenderer.on("delta:navigate", listener);
    return () => ipcRenderer.removeListener("delta:navigate", listener);
  },
});
