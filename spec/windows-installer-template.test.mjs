import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { renderWindowsInstallerSource } from "../script/windows-installer.mjs";

const values = { OUTPUT: "output", LICENSE: "license", BRANDING_DIR: "branding", VERSION: "1.2.3-preview.1", FILE_VERSION: "1.2.3.0", INSTALL_FILES: "install", UNINSTALL_FILES: "uninstall", REMOVE_DIRECTORIES: "directories" };
const tokens = Object.keys(values).map(key => `@@DELTA_${key}@@`).join("\n");

test("NSIS template substitution preserves literal dollar sequences and never expands inserted text twice", () => {
  const inserted = { ...values, OUTPUT: "$& $` $' $$ @@DELTA_LICENSE@@" };
  assert.equal(renderWindowsInstallerSource(tokens, inserted), Object.keys(values).map(key => inserted[key]).join("\n"));
});

test("NSIS template rejects missing, repeated, unknown and nonstring substitutions", () => {
  assert.throws(() => renderWindowsInstallerSource(tokens.replace("@@DELTA_LICENSE@@", ""), values), /missing/);
  assert.throws(() => renderWindowsInstallerSource(`${tokens}\n@@DELTA_OUTPUT@@`, values), /Invalid/);
  assert.throws(() => renderWindowsInstallerSource(`${tokens}\n@@DELTA_UNEXPECTED@@`, values), /Invalid/);
  assert.throws(() => renderWindowsInstallerSource(tokens, { ...values, OUTPUT: undefined }), /Invalid/);
});

test("Windows resource template renders without missing build inputs", async () => {
  const template = await readFile(new URL("../resources/win/installer.nsi", import.meta.url), "utf8");
  const rendered = renderWindowsInstallerSource(template, values);
  assert.equal(rendered.includes("@@DELTA_"), false);
  assert.match(rendered, /RequestExecutionLevel user/);
  assert.match(rendered, /Call \.onVerifyInstDir/);
  assert.match(rendered, /SendMessage 0xFFFF 0x001A 0 "STR:Environment" \/TIMEOUT=5000/);
});

test("branded Modern UI installer supplies English install and removal pages without autorunning the application", async () => {
  const template = await readFile(new URL("../resources/win/installer.nsi", import.meta.url), "utf8");
  const rendered = renderWindowsInstallerSource(template, values);
  assert.match(rendered, /!include "MUI2\.nsh"/);
  assert.match(rendered, /!define DELTA_BRANDING_DIR "branding"/);
  assert.match(rendered, /!define MUI_ICON "\$\{DELTA_BRANDING_DIR\}\\app\.ico"/);
  assert.match(rendered, /installer-header\.bmp/);
  assert.match(rendered, /installer-sidebar\.bmp/);
  const pages = [...rendered.matchAll(/!insertmacro (MUI_(?:UN)?PAGE_[A-Z]+)/g)].map(match => match[1]);
  assert.deepEqual(pages, ["MUI_PAGE_WELCOME", "MUI_PAGE_LICENSE", "MUI_PAGE_DIRECTORY", "MUI_PAGE_INSTFILES", "MUI_PAGE_FINISH", "MUI_UNPAGE_WELCOME", "MUI_UNPAGE_CONFIRM", "MUI_UNPAGE_INSTFILES", "MUI_UNPAGE_FINISH"]);
  assert.match(rendered, /!insertmacro MUI_LANGUAGE "English"/);
  assert.match(rendered, /adds the delta command to your user PATH/);
  assert.match(rendered, /open a new terminal/);
  assert.match(rendered, /Your backup archives and personal settings are preserved/);
  assert.doesNotMatch(rendered, /MUI_FINISHPAGE_RUN|Exec(?:Shell)? ['"]?\$INSTDIR\\Delta Backupper\.exe|\$DESKTOP/);
});

test("installer product metadata and shortcuts use the branded application while ownership safeguards remain", async () => {
  const template = await readFile(new URL("../resources/win/installer.nsi", import.meta.url), "utf8");
  const rendered = renderWindowsInstallerSource(template, values);
  assert.match(rendered, /VIProductVersion "\$\{DELTA_FILE_VERSION\}"/);
  assert.match(rendered, /!define DELTA_VERSION "1\.2\.3-preview\.1"/);
  assert.match(rendered, /!define DELTA_FILE_VERSION "1\.2\.3\.0"/);
  assert.match(rendered, /"DisplayIcon" "\$INSTDIR\\Delta Backupper\.exe,0"/);
  assert.match(rendered, /"Publisher" "Delta Backupper contributors"/);
  assert.match(rendered, /"QuietUninstallString"/);
  assert.match(rendered, /Function un\.onInit/);
  assert.match(rendered, /Cannot verify this installation directory\. No files were removed\./);
  assert.match(rendered, /DELTA_BACKUPPER_INSTALL_V1/);
  assert.doesNotMatch(rendered, /RMDir \/r/);
});
