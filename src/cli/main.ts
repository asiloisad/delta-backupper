import { createHash } from "node:crypto";
import { runtimeInfo, VERSION } from "../core/runtime.js";
import { runVssWorker, type VssWorkerScenario } from "../core/vss-worker.js";
import { APPLICATION_HELP, runApplication } from "./application.js";
import { runVssApplicationProbe } from "../core/vss-application-probe.js";

const HELP = `Delta Backupper ${VERSION}
Usage: delta --help | --version | <command>
${APPLICATION_HELP}
Technical probes: delta probe runtime|io|wait|sqlite|vss-worker|vss-application|snapshots
`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith("--")) {
    throw new Error(`Missing value for ${name}`);
  }
  return args[index + 1];
}

function integer(value: string | undefined, fallback: number, min: number, max: number) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`Expected an integer between ${min} and ${max}`);
  }
  return number;
}

async function main(args: string[]): Promise<number> {
  if (args[0] === "internal-snapshot-helper") {
    const { runLinuxSnapshotHelper } = await import("../platform/linux-snapshot-helper.js");
    return runLinuxSnapshotHelper(args.slice(1));
  }
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(HELP);
    return 0;
  }
  if (args[0] === "--version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (args[0] !== "probe") {
    if (!["tasks", "task", "history", "files", "verify", "restore", "pin", "retention", "delete", "unlock", "settings", "scheduler"].includes(args[0]!)) throw new Error(`Unknown command: ${args[0]}`);
    return runApplication(args);
  }
  switch (args[1]) {
    case "snapshots": {
      const remaining = args.slice(2);
      if (remaining.length < 2 || remaining.some((value, index) => index % 2 === 0 && !["--source-directory", "--report"].includes(value)) || remaining.filter(value => value === "--source-directory").length !== 1 || remaining.filter(value => value === "--report").length > 1) throw new Error("Usage: delta probe snapshots --source-directory /path/on/source-filesystem [--report FILE]");
      const { runPosixSnapshotProbe } = await import("../core/posix-snapshot-probe.js");
      const report = await runPosixSnapshotProbe({ sourceDirectory: option(remaining, "--source-directory")!, reportPath: option(remaining, "--report") });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); return report.status === "passed" ? 0 : report.status === "blocked" ? 3 : 1;
    }
    case "vss-application": {
      const remaining = args.slice(2);
      if (remaining.some((value, index) => value !== "--writers" && value !== "--report" && remaining[index - 1] !== "--report") || remaining.filter(value => value === "--writers").length > 1 || remaining.filter(value => value === "--report").length > 1) throw new Error("Usage: delta probe vss-application [--writers] [--report FILE]");
      const report = await runVssApplicationProbe({ reportPath: option(remaining, "--report"), writers: remaining.includes("--writers") });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return report.status === "passed" ? 0 : 1;
    }
    case "vss-worker": {
      if (args.length !== 4 || args[2] !== "--scenario" || !["normal", "cancel", "disconnect"].includes(args[3]!)) {
        throw new Error("Usage: delta probe vss-worker --scenario normal|cancel|disconnect");
      }
      const result = await runVssWorker(process.stdin, process.stdout, { scenario: args[3] as VssWorkerScenario });
      return result.exitCode;
    }
    case "runtime":
      process.stdout.write(`${JSON.stringify(runtimeInfo())}\n`);
      return 0;
    case "io": {
      const exitCode = integer(option(args, "--exit-code"), 0, 0, 255);
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of process.stdin) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(data);
        bytes += data.length;
      }
      process.stdout.write(`${JSON.stringify({ bytes, sha256: hash.digest("hex") })}\n`);
      process.stderr.write(`${option(args, "--stderr") ?? "stderr-probe"}\n`);
      return exitCode;
    }
    case "wait": {
      const milliseconds = integer(option(args, "--milliseconds"), 30_000, 0, 600_000);
      return await new Promise<number>((resolve) => {
        const finish = (code: number, signal: string | null) => {
          clearTimeout(timer);
          process.off("SIGINT", onInterrupt);
          process.off("SIGTERM", onTerminate);
          process.stdout.write(`${JSON.stringify({ cancelled: code !== 0, signal })}\n`);
          resolve(code);
        };
        const onInterrupt = () => finish(130, "SIGINT");
        const onTerminate = () => finish(143, "SIGTERM");
        const timer = setTimeout(() => finish(0, null), milliseconds);
        process.on("SIGINT", onInterrupt);
        process.on("SIGTERM", onTerminate);
        process.stdout.write("ready\n");
      });
    }
    case "sqlite": {
      // Keep the runtime dependency explicit: SEA can load built-ins, not npm modules.
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(":memory:");
      try {
        db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
        db.prepare("INSERT INTO probe (value) VALUES (?)").run("zażółć");
        const row = db.prepare("SELECT value FROM probe WHERE id = 1").get();
        process.stdout.write(`${JSON.stringify({ passed: row?.value === "zażółć" })}\n`);
      } finally {
        db.close();
      }
      return 0;
    }
    default:
      throw new Error(`Unknown probe: ${args[1] ?? "(missing)"}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    const code = (error as { code?: string }).code;
    process.exitCode = code === "DESTINATION_UNAVAILABLE" || code === "DELTA_LOCKED" || code?.startsWith("COORDINATOR_") ? 3 : 2;
  },
);
