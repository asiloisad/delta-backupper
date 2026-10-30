import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { ApplicationService, type ApiRequest, type Operation } from "../service/api.js";
import { getTaskStatus, unlockTask } from "../engine/index.mjs";
import { connectCoordinator } from "../service/coordinator.js";

export const APPLICATION_HELP = `Commands:
  delta tasks list
  delta task create --name NAME --destination DIR --source PATH [--source PATH]
  delta task show|validate|run|status|cancel|forget TASK
  delta task pause|resume-operation TASK
  delta task discover DIRECTORY
  delta task edit TASK --file PATCH.json
  delta task duplicate TASK --to DIRECTORY [--name NAME]
  delta task resume|retry TASK --run RUN_ID
  delta history TASK
  delta files TASK --run RUN_ID [--offset N] [--limit N] [--query TEXT]
  delta verify TASK [--run RUN_ID]
  delta restore TASK --to DIRECTORY [--run RUN_ID] [--path PATH] [--dry-run]
  delta scheduler status|pause|resume
  delta pin TASK --run RUN_ID [--unpin]
  delta retention TASK
  delta delete TASK --run RUN_ID
  delta unlock TASK --token OWNER_TOKEN
  delta settings app|defaults [--file JSON]

Options: --json, --config-dir DIR,
         --overwrite error|skip|replace, --settings JSON (task create).
TASK is a task directory or an unambiguous remembered task name.
Exit codes: 0 complete, 1 failed, 2 usage/configuration, 3 unavailable/locked,
            4 incomplete, 130 cancelled. Default restore never overwrites.
`;

export async function runApplication(args: string[]): Promise<number> {
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  const switches = new Set(["json", "unpin", "dry-run"]);
  const allowed = new Set([...switches, "config-dir", "name", "destination", "source", "file", "settings", "to", "run", "path", "overwrite", "offset", "limit", "query", "token"]);
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (!value.startsWith("--")) { positionals.push(value); continue; }
    const key = value.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown option: ${value}`);
    let argument = "true";
    if (!switches.has(key)) {
      argument = args[++index]!;
      if (argument === undefined || argument.startsWith("--")) throw new Error(`Missing value for ${value}`);
    }
    if (flags.has(key) && !["source", "path"].includes(key)) throw new Error(`Repeated option: ${value}`);
    flags.set(key, [...flags.get(key) ?? [], argument]);
  }
  const flag = (name: string) => flags.get(name)?.[0];
  const required = (value: string | undefined, description: string) => { if (!value) throw new Error(`Missing ${description}`); return value; };
  const configDirectory = path.resolve(flag("config-dir") ?? path.join(homedir(), ".delta"));
  const service = new ApplicationService({ configDirectory });
  await service.ready;
  const remote = await connectCoordinator(configDirectory);
  const api = (request: ApiRequest) => remote ? remote.request(request) : service.request(request);
  const [command, subcommand, third] = positionals;
  if (flags.has("dry-run") && command !== "restore") throw new Error("--dry-run is available only for restore");
  let request: ApiRequest;
  let direct: unknown;
  if (command === "tasks" && subcommand === "list") request = { action: "bootstrap" };
  else if (command === "task") {
    switch (subcommand) {
      case "create": request = { action: "create", name: required(flag("name"), "--name"), directory: required(flag("destination"), "--destination"), sources: (flags.get("source") ?? []).map(source => ({ path: path.resolve(source) })), settings: flag("settings") ? JSON.parse(await readFile(flag("settings")!, "utf8")) : undefined }; break;
      case "discover": request = { action: "discover", directory: required(third, "directory") }; break;
      case "show": case "validate": request = { action: "load", reference: required(third, "task") }; break;
      case "edit": { const loaded = await service.resolveTask(required(third, "task")); request = { action: "save", reference: loaded.directory, revision: loaded.revision, patch: JSON.parse(await readFile(required(flag("file"), "--file"), "utf8")) }; break; }
      case "run": case "resume": case "retry": request = { action: subcommand, reference: required(third, "task"), runId: flag("run") }; break;
      case "forget": request = { action: "forget", reference: required(third, "task") }; break;
      case "duplicate": request = { action: "duplicate", reference: required(third, "task"), directory: required(flag("to"), "--to"), name: flag("name") }; break;
      case "status": { const loaded = await service.resolveTask(required(third, "task")); direct = await getTaskStatus(loaded.directory); request = { action: "noop" }; break; }
      case "cancel": case "pause": case "resume-operation": {
        const loaded = await service.resolveTask(required(third, "task"));
        if (!remote) throw Object.assign(new Error(subcommand === "cancel" ? "No active desktop coordinator; use Ctrl+C in the terminal running this task" : "No active desktop coordinator is available to pause or resume this task"), { code: "COORDINATOR_UNAVAILABLE" });
        const operations = await remote.request({ action: "operations", summary: true }) as Operation[];
        const active = operations.filter(operation => operation.taskId === loaded.id && ["queued", "running"].includes(operation.status) && (subcommand === "cancel" || ["run", "resume", "retry"].includes(operation.action)));
        for (const operation of active) await remote.request({ action: subcommand, operationId: operation.id });
        direct = { status: "complete", [subcommand === "cancel" ? "cancellationRequested" : subcommand === "pause" ? "pauseRequested" : "resumeRequested"]: active.map(operation => operation.id) }; request = { action: "noop" }; break;
      }
      default: throw new Error(`Unknown task operation: ${subcommand ?? "(missing)"}`);
    }
  } else if (["history", "files", "verify", "restore", "pin", "retention", "delete"].includes(command ?? "")) {
    if (command === "delete") required(flag("run"), "--run");
    request = { action: command === "restore" && flags.has("dry-run") ? "restore-plan" : command!, reference: required(subcommand, "task"), runId: flag("run"), outputDirectory: flag("to") ? path.resolve(flag("to")!) : undefined, paths: flags.get("path"), overwrite: flag("overwrite"), pinned: !flags.has("unpin"), offset: flag("offset") === undefined ? undefined : Number(flag("offset")), limit: flag("limit") === undefined ? undefined : Number(flag("limit")), query: flag("query") };
    if (["files", "verify", "restore", "pin"].includes(command!) && !request.runId) {
      const history = await api({ action: "history", reference: subcommand }) as Array<{ id: string; status: string; committed?: boolean }>;
      request.runId = history.filter(value => value.committed !== false && ["complete", "incomplete"].includes(value.status)).at(-1)?.id;
      required(request.runId as string, "run ID (no committed backup exists)");
    }
  } else if (command === "scheduler" && ["status", "pause", "resume"].includes(subcommand ?? "")) {
    const current = await service.store.readApp();
    if (subcommand === "status") {
      if (remote) request = { action: "scheduler-status" };
      else { direct = { running: false, paused: current.value.schedulerPaused, suspended: false, stateError: false, tasks: [] }; request = { action: "noop" }; }
    } else request = { action: "app-save", revision: current.revision, value: { ...current.value, schedulerPaused: subcommand === "pause" } };
  } else if (command === "settings" && ["app", "defaults"].includes(subcommand ?? "")) {
    const document = subcommand === "app" ? await service.store.readApp() : await service.store.readDefaults();
    if (flag("file")) request = { action: `${subcommand}-save`, value: JSON.parse(await readFile(flag("file")!, "utf8")), revision: document.revision };
    else { direct = document; request = { action: "noop" }; }
  } else if (command === "unlock") { const loaded = await service.resolveTask(required(subcommand, "task")); direct = await unlockTask(loaded.directory, { token: required(flag("token"), "--token") }); request = { action: "noop" }; }
  else throw new Error(`Unknown command: ${command ?? "(missing)"}`);
  let interrupted = false;
  const requestedOperationId = randomUUID();
  if (["run", "resume", "retry", "verify", "restore", "restore-plan", "retention", "delete"].includes(request.action)) request.operationId = requestedOperationId;
  const interrupt = () => {
    interrupted = true;
    if (remote && request.operationId) void remote.request({ action: "cancel", operationId: requestedOperationId }).catch(() => {});
    else { service.cancel(requestedOperationId); for (const operation of service.operations.values()) service.cancel(operation.id); }
  };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  service.on("operation", (operation: Operation) => {
    if (!flags.has("json") && operation.progress) {
      const progress = operation.progress as { phase?: string; files?: number; bytes?: number };
      process.stderr.write(`${progress.phase ?? operation.status}: ${progress.files ?? 0} files, ${progress.bytes ?? 0} bytes\n`);
    }
  });
  try {
    let result = direct ?? await api(request);
    if (result && typeof result === "object" && "status" in result && "action" in result && "id" in result) {
      const operationId = String(result.id);
      if (interrupted) { if (remote) await remote.request({ action: "cancel", operationId }); else service.cancel(operationId); }
      if (!remote) result = await service.wait(operationId);
      else {
        let operation = result as Operation;
        while (["queued", "running"].includes(operation.status)) {
          await new Promise(resolve => setTimeout(resolve, 250));
          const operations = await remote.request({ action: "operations", operationId }) as Operation[];
          const current = operations.find(value => value.id === operationId);
          if (!current) throw new Error("Coordinator no longer has this operation; inspect task history");
          operation = current;
        }
        result = operation;
      }
    }
    if (request.action === "restore-plan" && result && typeof result === "object" && "result" in result && ["complete", "incomplete"].includes(String((result as Operation).status))) result = (result as Operation).result;
    if (command === "tasks" && subcommand === "list") result = (result as { tasks: unknown }).tasks;
    process.stdout.write(`${JSON.stringify(result ?? { status: "complete" }, null, flags.has("json") ? undefined : 2)}\n`);
    const status = (result as { status?: string } | undefined)?.status;
    const code = (result as { code?: string } | undefined)?.code;
    return interrupted ? 130 : code === "DELTA_LOCKED" || code === "DESTINATION_UNAVAILABLE" ? 3 : ["incomplete", "blocked"].includes(status ?? "") ? 4 : status === "cancelled" ? 130 : status === "failed" ? 1 : 0;
  } finally {
    process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt);
  }
}
