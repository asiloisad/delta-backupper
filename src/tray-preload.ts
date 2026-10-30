import { contextBridge, ipcRenderer } from "electron";
import type { TrayPopupAction, TraySnapshot } from "./platform/tray-popup.js";

contextBridge.exposeInMainWorld("deltaTray", {
  snapshot: (): Promise<TraySnapshot> => ipcRenderer.invoke("delta:tray-request", { action: "snapshot" }),
  action: (request: TrayPopupAction): Promise<void> => ipcRenderer.invoke("delta:tray-request", request),
  onUpdate: (callback: (snapshot: TraySnapshot) => void) => {
    const listener = (_event: unknown, snapshot: TraySnapshot) => callback(snapshot);
    ipcRenderer.on("delta:tray-update", listener);
    return () => ipcRenderer.removeListener("delta:tray-update", listener);
  },
});
