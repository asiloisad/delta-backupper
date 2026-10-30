import { app, BrowserWindow, utilityProcess } from "electron";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { runtimeInfo } from "./core/runtime.js";
import { homedir } from "node:os";
import { runtimeDirectory } from "./platform/application-paths.mjs";
import { startDesktop } from "./application.js";
import { configureNotificationIdentity } from "./platform/notification-identity.js";

app.commandLine.appendSwitch("lang", "en-US");

const probe = process.argv.find((arg) => arg.startsWith("--stage0-probe="))?.split("=")[1];
const reportPath = process.argv.find((arg) => arg.startsWith("--stage0-report="))?.slice("--stage0-report=".length);
const profile = process.argv.find((arg) => arg.startsWith("--stage0-profile="))?.slice("--stage0-profile=".length);
const configDirectory = path.resolve(process.argv.find(arg => arg.startsWith("--delta-config-dir="))?.slice("--delta-config-dir=".length) ?? path.join(homedir(), ".delta"));
const notificationProbeActivation = process.argv.includes("--delta-notification-probe-activation");
const smokeReport = process.argv.find(arg => arg.startsWith("--delta-smoke-report="))?.slice("--delta-smoke-report=".length);
const systemProbe = Boolean(smokeReport && profile && process.argv.includes("--delta-system-integration"));
if (process.argv.includes("--delta-system-integration") && !systemProbe) throw new Error("System integration qualification requires an isolated Electron profile and a smoke report");
configureNotificationIdentity(systemProbe ? { probeId: randomUUID() } : {});
if (profile) {
  mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", path.join(profile, "session"));
}
if (!profile && !probe && !notificationProbeActivation) {
  const desktopDirectory = path.join(runtimeDirectory(configDirectory), "electron");
  mkdirSync(desktopDirectory, { recursive: true, mode: 0o700 });
  app.setPath("userData", desktopDirectory);
  app.setPath("sessionData", path.join(desktopDirectory, "session"));
}

async function writeReport(report: unknown) {
  if (reportPath) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } else process.stdout.write(`${JSON.stringify(report)}\n`);
}

async function runProbe() {
  if (probe === "runtime") {
    const workerReport = await new Promise<unknown>((resolve, reject) => {
      const workerMode = process.argv.find((arg) => arg.startsWith("--stage0-worker-mode="))?.split("=")[1] ?? "normal";
      const child = utilityProcess.fork(path.join(__dirname, "worker.cjs"), [workerMode], { stdio: "pipe" });
      let message: unknown;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error("Worker timed out")), 15_000);
      child.once("message", (value: unknown) => {
        if (typeof value !== "object" || value === null || !("role" in value) || value.role !== "worker" || !("node" in value) || value.node !== process.versions.node || !("sqlite" in value) || value.sqlite !== true) {
          fail(new Error("Invalid worker handshake"));
          return;
        }
        message = value;
        child.postMessage({ type: "finish" });
      });
      child.once("exit", (code) => {
        if (settled) return;
        if (code !== 0 || message === undefined) {
          fail(new Error(`Worker exit ${code}${message === undefined ? " without handshake" : ""}`));
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(message);
      });
    });
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await window.loadURL("data:text/html,<meta charset=utf-8><title>Delta Backupper</title>");
    const renderer = await window.webContents.executeJavaScript("({title: document.title, nodeIntegration: typeof require !== 'undefined'})");
    window.destroy();
    return { status: "passed", ...runtimeInfo(), packaged: app.isPackaged, worker: workerReport, renderer };
  }
  throw new Error(`Unknown desktop probe: ${probe}`);
}

app.whenReady().then(async () => {
  if (notificationProbeActivation) { app.exit(0); return; }
  if (probe) {
    try { await writeReport(await runProbe()); app.exit(0); }
    catch (error) { await writeReport({ status: "failed", error: String(error) }); app.exit(1); }
    return;
  }
  if (!smokeReport && !app.requestSingleInstanceLock()) { app.exit(0); return; }
  try { await startDesktop(configDirectory, { smokeReport, show: systemProbe || !smokeReport }); }
  catch (error) { await writeReport({ status: "failed", error: String(error) }); app.exit(1); }
});
app.on("window-all-closed", () => { /* Tray and coordinator own application lifetime. */ });
