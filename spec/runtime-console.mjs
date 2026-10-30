import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const execute = promisify(execFile);

// Qualification harness only. Native Win32 console events cannot be modelled by
// child.kill() on Windows. CREATE_NEW_CONSOLE + SW_HIDE avoids opening a visible UI.
const source = String.raw`
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class DeltaConsoleProbe {
  [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes {
    public int length; public IntPtr descriptor;
    [MarshalAs(UnmanagedType.Bool)] public bool inherit;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int cb; public string reserved; public string desktop; public string title;
    public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
    public ushort showWindow, reservedBytes; public IntPtr reservedPointer;
    public IntPtr stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation {
    public IntPtr process, thread; public uint processId, threadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateFile(string name, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool CreateProcess(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation information);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint processId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GenerateConsoleCtrlEvent(uint consoleEvent, uint processGroupId);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);

  static void Require(bool success, string operation) {
    if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
  }
  static IntPtr Open(string file, uint access, uint creation, ref SecurityAttributes security) {
    IntPtr handle = CreateFile(file, access, 3, ref security, creation, 0x80, IntPtr.Zero);
    if (handle == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateFile");
    return handle;
  }
  static string ReadShared(string file) {
    using (FileStream stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
    using (StreamReader reader = new StreamReader(stream, Encoding.UTF8)) return reader.ReadToEnd();
  }
  public static int Main(string[] args) {
    string directory = args[1];
    ProcessInformation child = new ProcessInformation();
    bool attached = false;
    try {
      SecurityAttributes security = new SecurityAttributes();
      security.length = Marshal.SizeOf(typeof(SecurityAttributes)); security.inherit = true;
      StartupInfo startup = new StartupInfo(); startup.cb = Marshal.SizeOf(typeof(StartupInfo));
      startup.flags = 0x00000101; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
      startup.showWindow = 0; // SW_HIDE, set before creating the new console
      startup.stdin = Open("NUL", 0x80000000, 3, ref security);
      startup.stdout = Open(Path.Combine(directory, "child-stdout.txt"), 0x40000000, 2, ref security);
      startup.stderr = Open(Path.Combine(directory, "child-stderr.txt"), 0x40000000, 2, ref security);
      try {
        Require(CreateProcess(args[0], new StringBuilder("\"" + args[0] + "\" probe wait --milliseconds 30000"), IntPtr.Zero, IntPtr.Zero, true, 0x00000010, IntPtr.Zero, directory, ref startup, out child), "CreateProcess CREATE_NEW_CONSOLE");
      } finally {
        CloseHandle(startup.stdin); CloseHandle(startup.stdout); CloseHandle(startup.stderr);
      }
      DateTime deadline = DateTime.UtcNow.AddSeconds(10);
      while (!ReadShared(Path.Combine(directory, "child-stdout.txt")).Contains("ready\n")) {
        if (DateTime.UtcNow > deadline) throw new Exception("CLI did not report readiness");
        Thread.Sleep(20);
      }
      FreeConsole();
      Require(AttachConsole(child.processId), "AttachConsole"); attached = true;
      Require(SetConsoleCtrlHandler(IntPtr.Zero, true), "Ignore harness Ctrl+C");
      Require(GenerateConsoleCtrlEvent(0, 0), "GenerateConsoleCtrlEvent CTRL_C_EVENT");
      Thread.Sleep(100);
      FreeConsole(); attached = false;
      if (WaitForSingleObject(child.process, 10000) != 0) throw new Exception("CLI did not stop after Ctrl+C");
      uint code; Require(GetExitCodeProcess(child.process, out code), "GetExitCodeProcess");
      File.WriteAllText(Path.Combine(directory, "console-result.json"), "{\"exitCode\":" + code + ",\"consoleEvent\":\"CTRL_C_EVENT\",\"hiddenConsole\":true}");
      return 0;
    } catch (Exception error) {
      File.WriteAllText(Path.Combine(directory, "harness-error.txt"), error.ToString()); return 1;
    } finally {
      if (attached) FreeConsole();
      if (child.process != IntPtr.Zero) {
        uint code; if (GetExitCodeProcess(child.process, out code) && code == 259) TerminateProcess(child.process, 255);
        CloseHandle(child.process); CloseHandle(child.thread);
      }
    }
  }
}
`;

export async function probeWindowsCtrlC(cli, directory) {
  await mkdir(directory, { recursive: true });
  const sourcePath = path.join(directory, "console-harness.cs");
  const compilerPath = path.join(directory, "compile.ps1");
  const executable = path.join(directory, "console-harness.exe");
  await writeFile(sourcePath, source);
  await writeFile(compilerPath, [
    "$ErrorActionPreference = 'Stop'",
    "$source = [IO.File]::ReadAllText($env:DELTA_CONSOLE_SOURCE)",
    "Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly $env:DELTA_CONSOLE_OUTPUT -OutputType ConsoleApplication",
    "",
  ].join("\r\n"));
  const powershell = path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  await execute(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", compilerPath], {
    windowsHide: true, timeout: 30_000,
    env: { ...process.env, DELTA_CONSOLE_SOURCE: sourcePath, DELTA_CONSOLE_OUTPUT: executable },
  });
  try {
    await execute(executable, [cli, directory], { windowsHide: true, timeout: 25_000 });
  } catch (error) {
    const detail = await readFile(path.join(directory, "harness-error.txt"), "utf8").catch(() => "No native harness diagnostic");
    throw new Error(`${error.message}\n${detail}`);
  }
  return {
    ...JSON.parse(await readFile(path.join(directory, "console-result.json"), "utf8")),
    stdout: await readFile(path.join(directory, "child-stdout.txt"), "utf8"),
    stderr: await readFile(path.join(directory, "child-stderr.txt"), "utf8"),
  };
}
