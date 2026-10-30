import { runtimeInfo } from "./core/runtime.js";
import { DatabaseSync } from "node:sqlite";

const mode = process.argv[2] ?? "normal";
if (mode === "exit-without-message") process.exit(0);
if (!process.parentPort) throw new Error("Utility process parent port is unavailable");
process.parentPort.once("message", () => { process.exit(mode === "crash-after-message" ? 17 : 0); });
const db = new DatabaseSync(":memory:");
db.exec("CREATE TABLE probe (value TEXT NOT NULL)");
db.prepare("INSERT INTO probe VALUES (?)").run("zażółć");
const sqlite = db.prepare("SELECT value FROM probe").get()?.value === "zażółć";
db.close();
process.parentPort.postMessage(mode === "invalid-message" ? { role: "invalid" } : { ...runtimeInfo(), role: "worker", sqlite });
