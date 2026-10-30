import type { BrowserWindow } from "electron";
import { lstat } from "node:fs/promises";

export interface UiAccessibilityQualification {
  assertions: string[];
  platform: string;
  scope: string;
}

/** Explicit isolated smoke checks; app preferences are restored, and no backup or credential data is changed. */
export async function qualifyUiAccessibility(window: BrowserWindow, taskId: string, outputDirectory?: string): Promise<UiAccessibilityQualification> {
  const initiallyVisible = window.isVisible(); if (window.isMinimized()) window.restore(); window.showInactive(); window.focus(); window.webContents.focus();
  const result: UiAccessibilityQualification = { assertions: [], platform: process.platform, scope: "Actual Electron keyboard events, tab semantics, focus across rerender, inline source filters, draft duplication, modal submission/cancellation and named controls. Shared task defaults are saved through the form, inherited by a new draft and restored. Unsaved task-form edits, nonblocking change warnings, read-only restore previews and a restored isolated preference toggle; no screen-reader, other-platform or physical DPI claim." };
  const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); result.assertions.push(message); };
  const evaluate = async <T = unknown>(code: string): Promise<T> => window.webContents.executeJavaScript(code) as Promise<T>;
  async function waitFor(code: string, description: string) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) { if (window.isDestroyed()) throw new Error(`Window destroyed while waiting for ${description}`); if (await evaluate(code)) return; await new Promise(resolve => setTimeout(resolve, 35)); }
    throw new Error(`Timed out waiting for ${description}`);
  }
  async function click(label: string, scope = "document") {
    await evaluate(`(() => {const root=${scope};const button=[...root.querySelectorAll('button')].find(element=>element.textContent.trim()===${JSON.stringify(label)});if(!button||button.disabled)throw new Error('Unavailable qualification button: '+${JSON.stringify(label)});button.click();})()`);
  }
  async function key(keyCode: string) {
    window.webContents.focus(); window.webContents.sendInputEvent({ type: "keyDown", keyCode }); if (keyCode === "Enter") window.webContents.sendInputEvent({ type: "char", keyCode: "\r" }); window.webContents.sendInputEvent({ type: "keyUp", keyCode });
  }
  async function openQualificationTask(): Promise<void> {
    await evaluate(`(async () => {const listing=(await window.delta.request({action:'bootstrap'})).tasks.find(task=>task.id===${JSON.stringify(taskId)});const task=[...document.querySelectorAll('.task-item')].find(element=>element.dataset.focusKey==='task:'+listing?.directory);if(!task)throw new Error('Qualification task is unavailable');task.click()})()`);
    await waitFor("document.getElementById('main').dataset.view==='task'&&!!document.getElementById('task-tab-overview')", "task navigation from sidebar");
  }
  async function inlinePicker(label: string, pickerLabel: string, expectedSvg: string, scope = "#dialog"): Promise<boolean> {
    return evaluate(`(() => {const label=[...document.querySelectorAll(${JSON.stringify(`${scope} label`)})].find(element=>element.querySelector('.field-label')?.textContent===${JSON.stringify(label)}),row=label?.querySelector('.path-field-row'),input=row?.querySelector('input'),button=row?.querySelector('.path-browse-button');if(!row||!input||!button)return false;const field=input.getBoundingClientRect(),picker=button.getBoundingClientRect();return input.parentElement===button.parentElement&&field.width>0&&picker.width>0&&Math.abs(field.top-picker.top)<=1&&Math.abs(field.bottom-picker.bottom)<=1&&picker.left>=field.right&&button.getAttribute('aria-label')===${JSON.stringify(pickerLabel)}&&button.querySelector('svg')?.outerHTML===${JSON.stringify(expectedSvg)}})()`);
  }
  async function editorPalette(editorExpression: string, state: "warning" | "error" | "focus", focusFirst = false): Promise<boolean> {
    return evaluate(`(() => {const editor=${editorExpression};if(!editor)return false;if(${focusFirst})editor.focus();const probe=document.createElement('span');probe.style.color='var(--${state})';probe.style.backgroundColor='var(--${state === "focus" ? "input-focus-bg" : `${state}-soft`})';document.body.append(probe);const expected=getComputedStyle(probe),border=expected.color,background=expected.backgroundColor;probe.remove();const matches=()=>{const actual=getComputedStyle(editor);return actual.borderTopColor===border&&actual.backgroundColor===background};if(!matches())return false;editor.focus();return document.hasFocus()&&document.activeElement===editor&&editor.matches(':focus')&&matches()})()`);
  }
  async function headerSaveLayout(buttonId: string, formId: string, page: string): Promise<void> {
    assert(await evaluate(`(() => {const button=document.getElementById(${JSON.stringify(buttonId)}),form=document.getElementById(${JSON.stringify(formId)}),content=document.getElementById('page-content'),header=document.querySelector('#main > .page-header');return button instanceof HTMLButtonElement&&button.type==='submit'&&button.form===form&&button.getAttribute('form')===form.id&&header.contains(button)&&button.closest('.toolbar')!==null&&!content.contains(button)&&content.contains(form)&&form.querySelectorAll('button[type=submit],input[type=submit]').length===0&&document.querySelectorAll('#main button[type=submit]').length===1&&!button.disabled})()`), `${page} has one named, form-associated Save button in its fixed header toolbar and no footer duplicate`);
    const before = await evaluate<{ top: number; bottom: number }>(`(() => {const content=document.getElementById('page-content');content.scrollTop=0;content.focus({preventScroll:true});const bounds=document.getElementById(${JSON.stringify(buttonId)}).getBoundingClientRect();return {top:bounds.top,bottom:bounds.bottom}})()`);
    await key("PageDown"); await waitFor("document.getElementById('page-content').scrollTop>0", `${page} keyboard content scrolling`);
    assert(await evaluate(`(() => {const content=document.getElementById('page-content'),button=document.getElementById(${JSON.stringify(buttonId)}),bounds=button.getBoundingClientRect();return content.scrollTop>0&&document.documentElement.scrollHeight===document.documentElement.clientHeight&&!content.contains(button)&&Math.abs(bounds.top-${JSON.stringify(before.top)})<=1&&Math.abs(bounds.bottom-${JSON.stringify(before.bottom)})<=1&&bounds.top>=0&&bounds.bottom<=content.getBoundingClientRect().top})()`), `${page} keeps its Save button visible and fixed when PageDown scrolls the form`);
  }
  async function dialogHeaderActions(submitLabel: string): Promise<void> {
    assert(await evaluate(`(() => {const dialog=document.getElementById('dialog'),form=document.getElementById('dialog-form'),header=dialog.querySelector('.dialog-header'),actions=header?.querySelector('.dialog-actions'),submit=actions?.querySelector('button[type=submit]'),cancel=[...actions?.querySelectorAll('button')??[]].find(button=>button.textContent==='Cancel');if(!form||!header||!actions||!submit||!cancel)return false;const a=header.getBoundingClientRect(),s=submit.getBoundingClientRect(),c=cancel.getBoundingClientRect();return submit instanceof HTMLButtonElement&&submit.form===form&&submit.getAttribute('form')===form.id&&submit.textContent===${JSON.stringify(submitLabel)}&&cancel.type==='button'&&!form.contains(submit)&&!form.contains(cancel)&&dialog.querySelectorAll('button[type=submit]').length===1&&form.querySelectorAll('.form-actions').length===0&&Math.abs(s.top-c.top)<1&&Math.abs(s.bottom-c.bottom)<1&&s.top>=a.top&&s.bottom<=a.bottom})()`), `${submitLabel} confirmation and Cancel share the modal header, with native form association and no footer duplicate`);
  }
  async function expectTab(tab: string) {
    await waitFor(`(() => {const tab=document.getElementById('task-tab-${tab}'),panel=document.getElementById('task-panel');return !!tab&&tab===document.activeElement&&tab.getAttribute('aria-selected')==='true'&&tab.tabIndex===0&&panel?.getAttribute('aria-labelledby')===tab.id&&[...document.querySelectorAll('[role=tab]')].filter(element=>element.tabIndex===0&&element.getAttribute('aria-selected')==='true').length===1})()`, `active, focused and associated ${tab} tab`);
  }
  await waitFor("!!document.querySelector('[role=tablist]')", "task tabs");
  const remembered = await evaluate<any>("window.delta.request({action:'bootstrap'})");
  assert(remembered.tasks.some((task: { id: string }) => task.id === taskId) && await evaluate("!!document.querySelector('.task-item[aria-current=page]')"), "real remembered task has an accessible current sidebar item");
  assert(await evaluate("(() => {const home=document.getElementById('home'),refresh=document.getElementById('refresh'),actions=refresh?.closest('.titlebar-actions'),titlebar=document.getElementById('titlebar'),separator=document.body.dataset.platform==='darwin'?titlebar.querySelector('.titlebar-content'):actions,style=separator&&getComputedStyle(separator),border=style&&(document.body.dataset.platform==='darwin'?style.borderLeftWidth:style.borderRightWidth),a=home?.getBoundingClientRect(),b=refresh?.getBoundingClientRect();return refresh instanceof HTMLButtonElement&&refresh.getAttribute('aria-label')==='Refresh tasks'&&refresh.title==='Refresh'&&home.nextElementSibling===refresh&&actions?.contains(home)&&titlebar.contains(refresh)&&!document.querySelector('.sidebar #refresh')&&getComputedStyle(refresh).getPropertyValue('-webkit-app-region')==='no-drag'&&parseFloat(border)>0&&a.height>0&&Math.abs(a.top-b.top)<1&&Math.abs(a.bottom-b.bottom)<1&&b.left>=a.right})()"), "Refresh follows Home in the non-draggable titlebar, aligns with it and has a platform-side separator before native window controls");
  await click("Overview"); await expectTab("overview"); await key("Right"); await expectTab("settings");
  assert(true, "ArrowRight selects and focuses the next task tab with one tab stop");
  assert(await evaluate("!document.getElementById('task-retention')"), "Overview omits task management actions");
  await key("End"); await expectTab("manage");
  assert(await evaluate("['Relink destination','Run retention now…','Forget task'].every(label=>[...document.querySelectorAll('#task-panel button')].some(button=>button.textContent===label))"), "Manage contains the relocated task management actions");
  await key("Right"); await expectTab("overview"); await key("Left"); await expectTab("manage"); await key("Home"); await expectTab("overview");
  assert(true, "Home, End and wrapping arrow navigation preserve tab and panel semantics");
  await evaluate("new Promise((resolve,reject)=>{const previous=document.getElementById('task-tab-overview'),deadline=Date.now()+12000;const timer=setInterval(()=>{if(!previous.isConnected&&document.activeElement===document.getElementById('task-tab-overview')){clearInterval(timer);resolve(true)}else if(Date.now()>deadline){clearInterval(timer);reject(new Error('Focus was lost during task refresh'))}},35);document.getElementById('refresh').click()})"); await expectTab("overview");
  assert(true, "refreshing real task data retains focus on the replaced tab control");
  await key("F6"); await waitFor("document.activeElement?.matches('.task-item[aria-current=page]')", "F6 focus in task sidebar");
  await key("F6"); await waitFor("document.activeElement===document.getElementById('page-content')", "F6 focus in task details");
  assert(true, "F6 moves between details and the current sidebar task without changing tasks");
  await evaluate("document.querySelector('.skip-link').focus()"); await key("Enter"); await waitFor("document.activeElement===document.getElementById('page-content')", "skip link destination");
  assert(true, "keyboard skip link focuses the main task details landmark");
  for (const activation of ["Enter", "Space"]) {
    await evaluate("document.getElementById('about').focus()");
    await key(activation);
    await waitFor("document.getElementById('main').dataset.view==='about'&&!document.getElementById('main').hasAttribute('aria-busy')&&!!document.querySelector('.about-content .details')", `${activation} titlebar About navigation`);
    assert(await evaluate("(() => {const button=document.getElementById('about');return button instanceof HTMLButtonElement&&button===document.activeElement&&button.closest('#titlebar')!==null&&button.getAttribute('aria-label')==='About Delta Backupper'&&getComputedStyle(button).getPropertyValue('-webkit-app-region')==='no-drag'})()"), `${activation} activates the named titlebar logo button and retains keyboard focus`);
    await openQualificationTask();
  }
  await evaluate("document.getElementById('home').focus()"); await key("Enter");
  await waitFor("document.getElementById('main').dataset.view==='home'&&!!document.getElementById('home-current')", "keyboard Home navigation");
  assert(await evaluate("(() => {const home=document.getElementById('home');return home instanceof HTMLButtonElement&&home===document.activeElement&&home.closest('#titlebar')!==null&&home.getAttribute('aria-label')==='Home'&&home.title==='Home'&&home.parentElement.classList.contains('titlebar-actions')&&!document.getElementById('window-devtools')&&getComputedStyle(home).getPropertyValue('-webkit-app-region')==='no-drag'&&getComputedStyle(home).cursor==='default'&&!!home.querySelector('svg')})()"), "Enter activates the named Home icon in the non-draggable titlebar without a DevTools button");
  await openQualificationTask();
  await click("Task defaults"); await waitFor("document.getElementById('main').dataset.view==='task-defaults'&&!!document.querySelector('#main form')", "global task defaults");
  assert(await evaluate("window.delta.request({action:'bootstrap'}).then(value=>!Object.hasOwn(value.defaults.value.settings,'sources')&&!Object.hasOwn(value.defaults.value.settings,'filters')&&document.getElementById('task-sources')===null&&![...document.querySelectorAll('#main h2')].some(heading=>heading.textContent==='Filters'||heading.textContent==='Sources and filters')&&![...document.querySelectorAll('#main .field-label')].some(label=>label.textContent.startsWith('Include')||label.textContent.startsWith('Exclude'))&&!!document.getElementById('task-schedules'))"), "global task defaults omit sources and filters while retaining shared schedule settings");
  assert(await evaluate("![...document.querySelectorAll('#main button')].some(button=>/^Back to /.test(button.textContent))"), "global pages omit redundant Back navigation buttons");
  await headerSaveLayout("task-defaults-save", "task-defaults-form", "Task defaults");
  const originalDefaults = await evaluate<any>("window.delta.request({action:'bootstrap'}).then(value=>value.defaults)");
  const defaultsWorkingDirectory = originalDefaults.value.settings.wdir === "." ? ".." : ".", defaultsMode = originalDefaults.value.settings.mode === 0 ? 2 : 0, defaultsLevel = originalDefaults.value.settings.archive.level === 0 ? 9 : 0;
  let changedDefaults: { revision: string } | undefined;
  try {
    await evaluate("[...document.querySelectorAll('#main label')].find(label=>label.querySelector('.field-label')?.textContent==='Pause schedules').querySelector('input').focus()"); await key("Space");
    await evaluate(`(() => {const field=label=>[...document.querySelectorAll('#main label')].find(element=>element.querySelector('.field-label')?.textContent===label)?.querySelector('input,select');for(const [label,value]of ${JSON.stringify([["Working directory", defaultsWorkingDirectory], ["Paths in ZIP archives", String(defaultsMode)], ["Compression level (0–9)", String(defaultsLevel)]])}){const editor=field(label);if(!editor||editor.disabled)throw new Error('Missing editable default: '+label);editor.value=value;editor.dispatchEvent(new Event(editor instanceof HTMLSelectElement?'change':'input',{bubbles:true}))}})()`);
    assert(await evaluate("!document.querySelector('#task-defaults-form [data-change-impact=unsafe],#task-defaults-form [data-change-risk=unsafe]')&&!document.getElementById('task-change-warning')"), "editing task defaults does not show saved-task unsafe-change markings");
    await evaluate("document.getElementById('task-defaults-save').focus()"); await key("Enter");
    await waitFor(`window.delta.request({action:'bootstrap'}).then(value=>{const settings=value.defaults.value.settings;return settings.schedulesPaused===${JSON.stringify(!originalDefaults.value.settings.schedulesPaused)}&&settings.wdir===${JSON.stringify(defaultsWorkingDirectory)}&&settings.mode===${defaultsMode}&&settings.archive.level===${defaultsLevel}&&!Object.hasOwn(settings.archive,'compression')})`, "header Save defaults submitting changed form values");
    changedDefaults = await evaluate<any>("window.delta.request({action:'bootstrap'}).then(value=>value.defaults)");
    assert(true, "Enter on the header Save defaults button persists schedule pause, working directory, archive paths and the single compression level through the actual form");
    await evaluate("document.getElementById('new-task').focus()"); await key("Enter");
    await waitFor("document.getElementById('main').dataset.view==='draft'&&!!document.getElementById('draft-form')", "draft inheriting freshly saved defaults");
    assert(await evaluate(`(() => {const field=label=>[...document.querySelectorAll('#draft-form label')].find(element=>element.querySelector('.field-label')?.textContent===label)?.querySelector('input,select');return field('Working directory')?.value===${JSON.stringify(defaultsWorkingDirectory)}&&field('Paths in ZIP archives')?.value===${JSON.stringify(String(defaultsMode))}&&field('Compression level (0–9)')?.value===${JSON.stringify(String(defaultsLevel))}&&field('Pause schedules')?.checked===${JSON.stringify(!originalDefaults.value.settings.schedulesPaused)}})()`), "a new draft inherits all freshly saved file-path, compression and schedule-pause defaults without hardcoded replacements");
    await evaluate("document.getElementById('draft-cancel').focus()"); await key("Enter"); await waitFor("document.getElementById('main').dataset.view==='home'", "discarding default-inheritance draft");
    assert(await evaluate(`window.delta.request({action:'bootstrap'}).then(value=>value.tasks.length===${remembered.tasks.length})`), "checking inherited defaults and cancelling the draft writes no new task");
  } finally {
    if (changedDefaults) {
      const current = await evaluate<any>("window.delta.request({action:'bootstrap'}).then(value=>value.defaults)");
      if (current.revision !== changedDefaults.revision) throw new Error("Isolated task defaults changed unexpectedly; refusing to overwrite a different revision");
      await click("Task defaults"); await waitFor("document.getElementById('main').dataset.view==='task-defaults'&&!!document.getElementById('task-defaults-save')", "task defaults ready for isolated restoration");
      await evaluate(`(() => {const field=label=>[...document.querySelectorAll('#main label')].find(element=>element.querySelector('.field-label')?.textContent===label)?.querySelector('input,select');for(const [label,value]of ${JSON.stringify([["Working directory", originalDefaults.value.settings.wdir], ["Paths in ZIP archives", String(originalDefaults.value.settings.mode)], ["Compression level (0–9)", String(originalDefaults.value.settings.archive.level)]])}){const editor=field(label);editor.value=value;editor.dispatchEvent(new Event(editor instanceof HTMLSelectElement?'change':'input',{bubbles:true}))}const pause=field('Pause schedules');pause.checked=${JSON.stringify(originalDefaults.value.settings.schedulesPaused)};pause.dispatchEvent(new Event('change',{bubbles:true}))})()`);
      await waitFor("!document.getElementById('task-defaults-save').disabled", "Save defaults ready for restoration");
      await click("Save defaults", "document.querySelector('#main > .page-header')");
      await waitFor(`window.delta.request({action:'bootstrap'}).then(value=>JSON.stringify(value.defaults.value)===${JSON.stringify(JSON.stringify(originalDefaults.value))})`, "restored task defaults after header submission");
      assert(true, "clicking the same header Save defaults button restores the isolated defaults through the real form");
    }
  }
  await openQualificationTask();
  await click("Settings"); await waitFor("!!document.querySelector('#main form .source-row')", "task settings sources");
  await headerSaveLayout("task-save", "task-settings-form", "Task Settings");
  assert(await evaluate("!document.getElementById('task-open-folder')&&!document.getElementById('task-run')&&!document.getElementById('task-pause')&&document.querySelectorAll('#main > .page-header .toolbar button').length===1&&document.querySelector('#main > .page-header .toolbar button')?.id==='task-save'"), "task Settings replaces Overview's folder and backup controls with only the header Save settings action");
  assert(await evaluate("(() => {const labels=[...document.querySelectorAll('#main label')],working=labels.find(label=>label.querySelector('.field-label')?.textContent==='Working directory'),paths=labels.find(label=>label.querySelector('.field-label')?.textContent==='Paths in ZIP archives'),input=working?.querySelector('input'),picker=working?.querySelector('.path-browse-button'),mode=paths?.querySelector('select');return input instanceof HTMLInputElement&&!input.readOnly&&!input.disabled&&picker?.getAttribute('aria-label')==='Choose working directory'&&!picker.disabled&&mode instanceof HTMLSelectElement&&!mode.disabled})()"), "saved task settings expose editable working-directory and ZIP-path controls with a named folder picker");
  const zipMode = "[...document.querySelectorAll('#task-settings-form label')].find(label=>label.querySelector('.field-label')?.textContent==='Paths in ZIP archives').querySelector('select')";
  const taskName = "[...document.querySelectorAll('#task-settings-form label')].find(label=>label.querySelector('.field-label')?.textContent==='Name').querySelector('input')";
  const originalZipMode = await evaluate<string>(`${zipMode}.value`);
  await evaluate(`(${taskName}).focus()`); await key("Tab");
  await waitFor("document.hasFocus()&&document.activeElement?.dataset.taskSetting==='wdir'&&document.activeElement.matches(':focus')&&!document.activeElement.hasAttribute('data-change-impact')", "native Tab focus on the unchanged working-directory editor");
  assert(await editorPalette("document.activeElement", "warning"), "native Tab navigation colors the unchanged working-directory border and background before the first edit");
  await key("Tab"); await key("Tab");
  await waitFor(`document.hasFocus()&&document.activeElement===(${zipMode})&&document.activeElement.matches(':focus')&&!document.activeElement.hasAttribute('data-change-impact')`, "native Tab focus on unchanged ZIP archive paths");
  assert(await editorPalette(zipMode, "warning", true) && await evaluate(`(() => {const editor=${zipMode};return editor.dataset.changeRisk==='unsafe'&&!editor.hasAttribute('data-change-impact')&&editor.title.startsWith('Unsafe change:')&&editor.getAttribute('aria-description')===editor.title})()`), "focusing unchanged ZIP paths immediately applies the unsafe palette and accessible risk explanation before any edit");
  await evaluate(`(() => {const editor=${zipMode};editor.value=${JSON.stringify(originalZipMode === "0" ? "1" : "0")};editor.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  assert(await editorPalette(zipMode, "warning") && await evaluate(`(() => {const editor=${zipMode};return editor.dataset.changeImpact==='unsafe'&&editor.title.startsWith('Unsafe change:')&&editor.getAttribute('aria-description')===editor.title&&!editor.disabled&&!document.getElementById('task-save').disabled&&!document.getElementById('task-change-warning')&&!document.querySelector('#task-settings-form > .notice.warning')})()`), "unsafe ZIP-path edits use matching warning border and background, retain both colors on focus and explain their impact accessibly without a banner or blocking Save");
  await evaluate(`(() => {const editor=${zipMode};editor.value=${JSON.stringify(originalZipMode)};editor.dispatchEvent(new Event('change',{bubbles:true}))})()`);
  assert(await editorPalette(zipMode, "warning") && await evaluate(`(() => {const editor=${zipMode};return !editor.hasAttribute('data-change-impact')&&editor.dataset.changeRisk==='unsafe'&&editor.title.startsWith('Unsafe change:')&&editor.getAttribute('aria-description')===editor.title})()`), "reverting unsafe ZIP paths removes the dirty marker while the focused field keeps its potential-risk palette and explanation");
  assert(await editorPalette(taskName, "focus", true) && await evaluate(`(() => {const editor=${zipMode},probe=document.createElement('span');probe.style.color='var(--warning)';probe.style.backgroundColor='var(--warning-soft)';document.body.append(probe);const expected=getComputedStyle(probe),border=expected.color,background=expected.backgroundColor;probe.remove();const actual=getComputedStyle(editor);return actual.borderTopColor!==border&&actual.backgroundColor!==background})()`), "leaving an unchanged or reverted risky editor restores both normal colors and routine Name editing retains the accent focus palette");
  assert(await evaluate("(() => {const main=document.getElementById('main');return getComputedStyle(main).userSelect==='none'&&[...main.querySelectorAll('.field-label')].every(label=>getComputedStyle(label).userSelect==='none')&&[...main.querySelectorAll('input:not([type=checkbox]),textarea')].every(field=>getComputedStyle(field).userSelect==='text')})()"), "interface text cannot be selected while editable fields retain normal text selection");
  const sourcesNamed = await evaluate("(() => {const rows=[...document.querySelectorAll('#main #task-sources .source-row')],add=document.getElementById('task-sources-add-source');return rows.length>=2&&rows.every(row=>row.dataset.empty==='false'&&row.querySelector('button.source-remove')?.getAttribute('aria-label')==='Remove source'&&row.querySelector('.source-browse').hidden&&!row.querySelector('.source-filter-add').hidden)&&add instanceof HTMLButtonElement&&add.type==='button'&&!document.getElementById('task-sources').contains(add)})()");
  assert(sourcesNamed, "saved sources expose named removal and Add filter controls with a separate Add source button and no empty rows");
  const filtersBeforeKeyboard = await evaluate<string>(`window.delta.request({action:'load',reference:${JSON.stringify(taskId)}}).then(task=>JSON.stringify({revision:task.revision,sources:task.value.sources}))`);
  const sourceCount = await evaluate<number>("document.querySelectorAll('#task-sources .source-row').length");
  await evaluate("document.getElementById('task-sources-add-source').focus()"); await key("Space");
  await waitFor("document.activeElement?.matches('#task-sources .source-row[data-empty=true] .source-path')", "Add source creating and focusing a requested blank source");
  assert(await editorPalette("document.querySelector('#task-sources .source-row[data-empty=true] .source-path')", "warning") && await evaluate("(() => {const editor=document.activeElement;return editor.dataset.changeRisk==='unsafe'&&!editor.hasAttribute('data-change-impact')&&editor.value===''})()"), "a requested blank source in saved-task Settings shows the unsafe focus palette before its first character is entered");
  const expectedPickerSvg = await evaluate<string>("document.querySelector('#task-sources .source-row[data-empty=true] .source-browse svg').outerHTML");
  assert(await inlinePicker("Working directory", "Choose working directory", expectedPickerSvg, "#main"), "Working directory uses the same aligned inline folder picker as source and destination paths");
  assert(await evaluate("(() => {const row=document.querySelector('#task-sources .source-row[data-empty=true]');return row.querySelector('.source-remove')?.getAttribute('aria-label')==='Cancel source'&&!row.querySelector('.source-browse').hidden&&row.querySelector('.source-browse').getAttribute('aria-label')==='Choose source folder'&&row.querySelector('.source-filter-add').hidden&&row.querySelector('.source-filters').hidden})()"), "a requested blank source exposes its named folder picker and cancellation control without filter rows");
  await evaluate("document.getElementById('task-sources-add-source').click()");
  assert(await evaluate(`document.querySelectorAll('#task-sources .source-row').length===${sourceCount + 1}&&document.activeElement?.matches('#task-sources .source-row[data-empty=true] .source-path')`), "repeating Add source reuses and focuses the one pending blank row");
  await key("Escape");
  await waitFor("!document.querySelector('#task-sources .source-row[data-empty=true]')&&document.activeElement===document.getElementById('task-sources-add-source')", "Escape cancelling a blank source and focusing Add source");
  assert(true, "Escape removes a requested blank source and returns focus to Add source");
  await key("Enter"); await waitFor("document.activeElement?.matches('#task-sources .source-row[data-empty=true] .source-path')", "Enter adding another source");
  await window.webContents.insertText("qualification-keyboard-source");
  await waitFor(`document.querySelectorAll('#task-sources .source-row').length===${sourceCount + 1}&&!document.querySelector('#task-sources .source-row[data-empty=true]')`, "typing a source without appending an empty row");
  await key("Enter"); await waitFor("document.activeElement===document.getElementById('task-sources-add-source')", "Enter returning from the source path to Add source");
  assert(true, "typing a source creates no placeholder and Enter returns focus to Add source without submitting");
  await evaluate("[...document.querySelectorAll('#task-sources .source-row')].find(row=>row.querySelector('.source-path').value==='qualification-keyboard-source').querySelector('.source-remove').focus()"); await key("Enter");
  await waitFor(`document.querySelectorAll('#task-sources .source-row').length===${sourceCount}&&!document.querySelector('#task-sources .source-row[data-empty=true]')`, "keyboard removal of the unsaved source");
  assert(true, "Enter removes an unsaved source without creating an empty replacement row");
  await evaluate("document.querySelector('#task-sources .source-row[data-empty=false] .source-filter-add').focus()"); await key("Space");
  await waitFor("document.activeElement?.matches('#task-sources .source-row[data-empty=false] .source-filter-row[data-empty=true] .source-filter-pattern')", "Add filter creating and focusing a requested blank pattern");
  const inlineFilter = await evaluate<{ kind: string; count: number }>("(() => {const source=document.querySelector('#task-sources .source-row[data-empty=false]'),rows=[...source.querySelectorAll('.source-filter-row')],row=source.querySelector('.source-filter-row[data-empty=true]');return {kind:row.dataset.kind,count:rows.length-1}})()");
  assert(await evaluate("(() => {const source=document.querySelector('#task-sources .source-row[data-empty=false]'),filters=source.querySelector('.source-filters'),row=filters.querySelector('.source-filter-row[data-empty=true]'),toggle=row.querySelector('.source-filter-kind'),input=row.querySelector('.source-filter-pattern'),remove=row.querySelector('.source-filter-remove');return !document.getElementById('dialog').open&&!filters.hidden&&toggle instanceof HTMLButtonElement&&toggle.type==='button'&&!!toggle.getAttribute('aria-label')&&input instanceof HTMLInputElement&&!!input.getAttribute('aria-label')&&!remove.hidden&&remove.getAttribute('aria-label')==='Cancel filter'})()"), "a requested filter exposes named native toggle, pattern and cancellation controls inline");
  await evaluate("document.querySelector('#task-sources .source-row[data-empty=false] .source-filter-add').click()");
  assert(await evaluate(`document.querySelector('#task-sources .source-row[data-empty=false]').querySelectorAll('.source-filter-row').length===${inlineFilter.count + 1}&&document.activeElement?.matches('.source-filter-row[data-empty=true] .source-filter-pattern')`), "repeating Add filter reuses and focuses the one pending blank pattern");
  await evaluate("document.querySelector('#task-sources .source-row[data-empty=false] .source-filter-row[data-empty=true] .source-filter-kind').focus()");
  await key("Space");
  await waitFor(`(() => {const row=document.querySelector('#task-sources .source-row[data-empty=false] .source-filter-row[data-empty=true]');return row.dataset.kind!==${JSON.stringify(inlineFilter.kind)}&&document.activeElement===row.querySelector('.source-filter-kind')})()`, "Space switching the inline filter type with retained toggle focus");
  assert(true, "Space switches the inline include/exclude type and retains focus on its toggle");
  await key("Enter");
  await waitFor(`(() => {const row=document.querySelector('#task-sources .source-row[data-empty=false] .source-filter-row[data-empty=true]');return row.dataset.kind===${JSON.stringify(inlineFilter.kind)}&&document.activeElement===row.querySelector('.source-filter-kind')&&!document.getElementById('dialog').open})()`, "Enter switching the inline filter type without form submission");
  assert(true, "Enter switches the inline type without submitting the task form or opening a dialog");
  await key("Tab"); await waitFor("document.activeElement?.matches('#task-sources .source-row[data-empty=false] .source-filter-pattern')", "keyboard focus in an empty inline pattern");
  await window.webContents.insertText("qualification-keyboard.tmp");
  await waitFor(`(() => {const source=document.querySelector('#task-sources .source-row[data-empty=false]');return source.querySelectorAll('.source-filter-row').length===${inlineFilter.count + 1}&&!source.querySelector('.source-filter-row[data-empty=true]')&&document.activeElement?.value==='qualification-keyboard.tmp'})()`, "typing an inline filter without appending an empty pattern");
  assert(true, "typing a filter retains the active input and creates no empty replacement pattern");
  await key("Enter"); await waitFor("document.activeElement===document.querySelector('#task-sources .source-row[data-empty=false] .source-filter-add')", "Enter returning from the pattern to Add filter");
  assert(true, "Enter returns from a pattern to Add filter without submitting the task form");
  await evaluate("[...document.querySelectorAll('#task-sources .source-row[data-empty=false] .source-filter-pattern')].find(input=>input.value==='qualification-keyboard.tmp').focus()");
  await key("Tab"); await waitFor("document.activeElement?.matches('.source-filter-remove')", "keyboard focus on filled filter removal");
  assert(await evaluate("document.activeElement instanceof HTMLButtonElement&&document.activeElement.type==='button'&&!!document.activeElement.getAttribute('aria-label')&&!document.activeElement.hidden"), "a filled filter exposes a named native removal button in the tab order");
  await key("Enter");
  await waitFor(`(() => {const source=document.querySelector('#task-sources .source-row[data-empty=false]');return source.querySelectorAll('.source-filter-row').length===${inlineFilter.count}&&!source.querySelector('.source-filter-row[data-empty=true]')&&![...source.querySelectorAll('.source-filter-pattern')].some(input=>input.value==='qualification-keyboard.tmp')&&(document.activeElement?.matches('.source-filter-pattern')||document.activeElement===source.querySelector('.source-filter-add'))})()`, "Enter removing the inline filter and focusing an adjacent pattern or Add filter");
  assert(true, "Enter removes the focused filter without a placeholder and restores focus beside the removed row");
  await evaluate("document.querySelector('#task-sources .source-row[data-empty=false] .source-filter-add').focus()"); await key("Enter");
  await waitFor("document.activeElement?.matches('#task-sources .source-row[data-empty=false] .source-filter-row[data-empty=true] .source-filter-pattern')", "Enter adding a cancellable blank filter");
  await key("Escape");
  await waitFor("!document.querySelector('#task-sources .source-row[data-empty=false] .source-filter-row[data-empty=true]')&&document.activeElement===document.querySelector('#task-sources .source-row[data-empty=false] .source-filter-add')", "Escape cancelling the blank filter and focusing Add filter");
  assert(true, "Escape removes a requested blank filter and returns focus to Add filter");
  assert(await evaluate<string>(`window.delta.request({action:'load',reference:${JSON.stringify(taskId)}}).then(task=>JSON.stringify({revision:task.revision,sources:task.value.sources}))`) === filtersBeforeKeyboard, "keyboard filter edits and removal leave the saved task revision and source filters unchanged");
  const beforeScroll = await evaluate<{ headerTop: number; tabsTop: number }>("(() => {const content=document.getElementById('page-content');content.scrollTop=0;content.focus({preventScroll:true});return {headerTop:document.querySelector('#main > .page-header').getBoundingClientRect().top,tabsTop:document.querySelector('#main > .tabs').getBoundingClientRect().top}})()"); await key("PageDown");
  await waitFor("document.getElementById('page-content').scrollTop>0", "keyboard scrolling inside task settings");
  assert(await evaluate(`(() => {const content=document.getElementById('page-content'),header=document.querySelector('#main > .page-header'),tabs=document.querySelector('#main > .tabs'),title=document.getElementById('titlebar').getBoundingClientRect(),main=document.getElementById('main').getBoundingClientRect();return window.scrollY===0&&document.documentElement.scrollHeight===document.documentElement.clientHeight&&title.top===0&&main.top>=title.bottom&&getComputedStyle(content).overflowY==='auto'&&!content.contains(header)&&!content.contains(tabs)&&content.getBoundingClientRect().top>=tabs.getBoundingClientRect().bottom-1&&Math.abs(header.getBoundingClientRect().top-${JSON.stringify(beforeScroll.headerTop)})<=1&&Math.abs(tabs.getBoundingClientRect().top-${JSON.stringify(beforeScroll.tabsTop)})<=1})()`), "PageDown scrolls only page content while the titlebar, page header, task tabs and document stay fixed");
  await evaluate("document.getElementById('new-task').focus()"); await key("Space");
  await waitFor("document.getElementById('main').dataset.view==='draft'&&document.activeElement===document.getElementById('draft-task-name')", "direct draft initial focus");
  assert(await evaluate("!document.getElementById('dialog').open&&!!document.getElementById('draft-form')"), "New task opens the main draft editor directly without a modal");
  await key("Enter"); await waitFor("!document.getElementById('notification').hidden&&document.getElementById('notification').dataset.error==='true'&&document.getElementById('draft-task-name').getAttribute('aria-invalid')==='true'", "draft validation notification and invalid editors");
  assert(await evaluate("document.getElementById('notification').getAttribute('role')==='alert'&&document.getElementById('main').dataset.view==='draft'&&['draft-task-name','new-task-destination'].every(id=>{const input=document.getElementById(id);return input.getAttribute('aria-invalid')==='true'&&input.getAttribute('aria-errormessage')==='notification'})&&!document.getElementById('draft-error')"), "Enter validates an incomplete draft with one accessible notification linked to its name and destination editors");
  assert(await editorPalette("document.getElementById('draft-task-name')", "error") && await editorPalette("document.getElementById('new-task-destination')", "error"), "invalid draft text editors use the same error border and tinted background while focused");
  assert(await evaluate(`window.delta.request({action:'bootstrap'}).then(value=>value.tasks.length===${remembered.tasks.length}&&!!document.getElementById('new-task-destination'))`), "opening an incomplete draft creates no task or registry entry");
  assert(await evaluate("(() => {const list=document.getElementById('new-task-sources');if(list.querySelector('.source-row'))return false;for(const path of ['qualification-source-one','qualification-source-two']){document.getElementById('new-task-sources-add-source').click();const input=list.querySelector('.source-row[data-empty=true] .source-path');input.value=path;input.dispatchEvent(new Event('input',{bubbles:true}))}const before=list.querySelectorAll('.source-row[data-empty=false]').length;list.querySelector('.source-remove').click();const rows=[...list.querySelectorAll('.source-row')];return before===2&&rows.length===1&&rows.every(row=>row.dataset.empty==='false'&&!row.querySelector('.source-name')&&row.querySelector('.source-browse').hidden&&!row.querySelector('.source-filter-add').hidden)})()"), "draft source rows are added on request and removed without empty placeholders or artificial source names");
  await evaluate("document.getElementById('draft-cancel').click()"); await waitFor("document.getElementById('main').dataset.view==='home'", "cancel volatile draft"); await openQualificationTask();
  await click("Manage"); await expectTab("manage");
  await click("Duplicate"); await waitFor("document.getElementById('main').dataset.view==='draft'&&document.activeElement===document.getElementById('draft-task-name')", "duplicate draft with initial name focus");
  assert(await evaluate(`window.delta.request({action:'load',reference:${JSON.stringify(taskId)}}).then(task=>{const form=document.getElementById('draft-form'),destination=document.getElementById('new-task-destination'),labels=[...form.querySelectorAll('label')],field=label=>labels.find(element=>element.querySelector('.field-label')?.textContent===label)?.querySelector('input,select');return !document.getElementById('dialog').open&&document.getElementById('draft-task-name').value===task.value.name+' (copy)'&&destination.value===''&&field('Working directory').value===task.value.wdir&&field('Paths in ZIP archives').value===String(task.value.mode)&&field('Change detection').value===task.value.detection&&[...form.querySelectorAll('.source-row[data-empty=false]')].every((row,index)=>row.querySelector('.source-path').value===task.value.sources[index].path)&&form.querySelectorAll('.source-row[data-empty=false]').length===task.value.sources.length})`), "Duplicate opens a focused main-page draft with copied settings and sources, and a blank independent destination");
  assert(await evaluate(`window.delta.request({action:'bootstrap'}).then(value=>value.tasks.length===${remembered.tasks.length})`), "opening a duplicate draft creates no task or registry entry");
  assert(await inlinePicker("Existing destination folder", "Choose destination folder", expectedPickerSvg, "#draft-form") && await inlinePicker("Working directory", "Choose working directory", expectedPickerSvg, "#draft-form"), "duplicate drafts keep destination and working-directory editors aligned with their named shared pickers");
  await evaluate("document.getElementById('draft-cancel').focus()"); await key("Enter"); await waitFor("document.getElementById('main').dataset.view==='home'", "keyboard cancellation of duplicate draft");
  assert(await evaluate(`window.delta.request({action:'bootstrap'}).then(value=>value.tasks.length===${remembered.tasks.length})`), "cancelling a duplicate draft returns Home without writing a task");
  await openQualificationTask();
  await click("Manage");
  const retentionOperations = await evaluate<number>("window.delta.request({action:'operations'}).then(operations=>operations.filter(operation=>operation.action==='retention').length)");
  await click("Run retention now…"); await waitFor("document.getElementById('dialog').open", "retention confirmation");
  await dialogHeaderActions("Run retention");
  assert(await evaluate("document.getElementById('dialog-description').textContent.includes('permanently deleted')&&document.getElementById('dialog').textContent.includes('Keep cycles')"), "manual retention requires a policy summary and explicit deletion confirmation");
  await click("Cancel", "document.querySelector('#dialog .dialog-header')"); await waitFor("!document.getElementById('dialog').open", "retention header cancellation");
  assert(await evaluate(`window.delta.request({action:'operations'}).then(operations=>operations.filter(operation=>operation.action==='retention').length===${retentionOperations})`), "the modal header Cancel closes retention without submitting the form or starting deletion");
  const originalPreferences = await evaluate<any>("window.delta.request({action:'bootstrap'}).then(value=>value.app)");
  let changedPreferences: { revision: string } | undefined;
  try {
    changedPreferences = await evaluate<any>(`window.delta.request({action:'app-save',revision:${JSON.stringify(originalPreferences.revision)},value:${JSON.stringify({ ...originalPreferences.value, schedulerPaused: !originalPreferences.value.schedulerPaused })}})`);
    await click("Application settings");
    await waitFor("!!document.querySelector('#main form')&&!document.getElementById('main').hasAttribute('aria-busy')", "current application preferences");
    assert(await evaluate("(() => {const main=document.getElementById('main').getBoundingClientRect(),header=document.querySelector('#main > .page-header'),bounds=header.getBoundingClientRect();return Number.parseFloat(getComputedStyle(header).borderBottomWidth)>0&&Math.abs(bounds.left-main.left)<=1&&Math.abs(bounds.right-main.right)<=1&&!document.getElementById('page-content').contains(header)})()"), "application settings keeps its full-width header divider outside the scrollable content");
    assert(await evaluate("[...document.querySelectorAll('#main label')].some(label=>label.querySelector('.field-label')?.textContent==='Pause scheduled backups'&&label.querySelector('input')?.type==='checkbox')"), "application settings exposes the persistent scheduled-backup pause control");
    assert(await evaluate(`(() => {const label=[...document.querySelectorAll('#main label')].find(label=>label.querySelector('.field-label')?.textContent==='Pause scheduled backups');return label?.querySelector('input')?.checked===${JSON.stringify(!originalPreferences.value.schedulerPaused)}})()`), "opening preferences reloads a scheduler pause changed outside the renderer's cached settings");
    await headerSaveLayout("app-settings-save", "app-settings-form", "Application settings");
    await evaluate("[...document.querySelectorAll('#main label')].find(label=>label.querySelector('.field-label')?.textContent==='Pause scheduled backups').querySelector('input').focus()"); await key("Space");
    await click("Save settings", "document.querySelector('#main > .page-header')");
    await waitFor(`window.delta.request({action:'bootstrap'}).then(value=>value.app.value.schedulerPaused===${JSON.stringify(originalPreferences.value.schedulerPaused)})`, "header Save settings submitting the real application form");
    changedPreferences = await evaluate<any>("window.delta.request({action:'bootstrap'}).then(value=>value.app)");
    assert(true, "clicking the application header Save settings button persists the real form's changed scheduler-pause value");
  } finally {
    if (changedPreferences) {
      const current = await evaluate<any>("window.delta.request({action:'bootstrap'}).then(value=>value.app)");
      if (current.revision !== changedPreferences.revision) throw new Error("Isolated preferences changed unexpectedly; refusing to overwrite a different revision");
      const restored = await evaluate<any>(`window.delta.request({action:'app-save',revision:${JSON.stringify(current.revision)},value:${JSON.stringify(originalPreferences.value)}})`);
      const verified = await evaluate<any>("window.delta.request({action:'bootstrap'}).then(value=>value.app)");
      assert(JSON.stringify(verified.value) === JSON.stringify(originalPreferences.value) && verified.revision === restored.revision, "isolated application preferences and their current revision are restored after the external-change regression check");
    }
  }
  await openQualificationTask();
  if (outputDirectory) {
    const restoreOperations = await evaluate<number>("window.delta.request({action:'operations'}).then(operations=>operations.filter(operation=>operation.action==='restore').length)");
    await click("Restore"); await waitFor("[...document.querySelectorAll('#main button')].some(button=>button.textContent==='Restore entire backup…')", "real restore browser");
    await click("Restore entire backup…"); await waitFor("document.getElementById('dialog').open&&document.getElementById('dialog-title').textContent==='Restore backup'", "restore dialog");
    await dialogHeaderActions("Restore");
    assert(await inlinePicker("Output directory", "Choose output folder", expectedPickerSvg), "Restore keeps its editable output directory and shared arrow picker aligned in one row");
    await click("Preview restore", "document.getElementById('dialog')");
    await waitFor("(() => {const input=document.querySelector('#dialog .path-field-row input'),notification=document.getElementById('notification');return input?.getAttribute('aria-invalid')==='true'&&notification&&!notification.hidden&&notification.dataset.error==='true'})()", "empty restore output notification and editor error");
    assert(await evaluate("(() => {const dialog=document.getElementById('dialog'),input=dialog.querySelector('.path-field-row input'),notification=document.getElementById('notification');return dialog.open&&dialog.contains(notification)&&notification.getAttribute('role')==='alert'&&notification.textContent==='Choose an output directory.'&&input.getAttribute('aria-errormessage')===notification.id&&!document.getElementById('dialog-error')&&!dialog.querySelector('.notice.error')})()"), "empty restore output shows its notification in the modal top layer and marks its editor without a duplicate inline error");
    assert(await editorPalette("document.querySelector('#dialog .path-field-row input')", "error"), "the invalid restore-output editor uses the shared error border and background, including on focus");
    await evaluate(`(() => {const label=[...document.querySelectorAll('#dialog label')].find(label=>label.querySelector('.field-label')?.textContent==='Output directory');const input=label.querySelector('input');input.value=${JSON.stringify(outputDirectory)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    assert(await evaluate("(() => {const button=[...document.querySelectorAll('#dialog button')].find(button=>button.textContent==='Preview restore');button.click();const cancel=document.getElementById('restore-preview-cancel');return !!cancel&&!cancel.hidden&&!cancel.disabled&&!document.getElementById('restore-preview-status').hidden})()"), "a pending restore preview immediately exposes its own enabled cancellation control");
    await waitFor("!document.getElementById('restore-preview').hidden&&document.getElementById('restore-preview').textContent.includes('Resolve these issues before restoring')&&document.querySelector('#dialog button[type=submit]').disabled", "blocked collision preview");
    assert(true, "read-only restore preview reports existing-file collisions and blocks the default overwrite policy");
    await evaluate("(() => {const select=document.querySelector('#dialog select');select.value='replace';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
    assert(await evaluate("document.getElementById('restore-preview').hidden&&!document.querySelector('#dialog button[type=submit]').disabled"), "changing restore policy invalidates the previous preview and its blocked state");
    await click("Preview restore", "document.getElementById('dialog')");
    await waitFor("!document.getElementById('restore-preview').hidden&&document.getElementById('restore-preview').textContent.includes('Ready to restore')&&/[1-9][0-9]* conflicts/.test(document.getElementById('restore-preview').textContent)&&![...document.querySelectorAll('#dialog button')].find(button=>button.textContent==='Preview restore').disabled", "replacement preview with collisions");
    await click("Restore", "document.getElementById('dialog')");
    await waitFor("document.querySelector('#dialog button[type=submit]').textContent==='Confirm replacement'&&!document.querySelector('#dialog button[type=submit]').disabled&&document.getElementById('restore-preview').textContent.includes('existing files will be replaced')", "explicit replacement confirmation");
    await dialogHeaderActions("Confirm replacement");
    assert(await evaluate<number>("window.delta.request({action:'operations'}).then(operations=>operations.filter(operation=>operation.action==='restore').length)") === restoreOperations, "replacement preview requires a second explicit confirmation and has not queued or overwritten files");
    await key("Escape"); await waitFor("!document.getElementById('dialog').open", "replacement confirmation cancellation");
    assert(await evaluate<number>("window.delta.request({action:'operations'}).then(operations=>operations.filter(operation=>operation.action==='restore').length)") === restoreOperations, "cancelling the replacement review does not queue another restore operation");
    const cancelledOutput = `${outputDirectory}-cancelled-preview`;
    const existedBefore = await lstat(cancelledOutput).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
    if (existedBefore) throw new Error("Cancellation qualification requires a new isolated output path");
    await click("Restore entire backup…"); await waitFor("document.getElementById('dialog').open&&document.getElementById('dialog-title').textContent==='Restore backup'", "restore cancellation regression dialog");
    await evaluate(`(() => {const label=[...document.querySelectorAll('#dialog label')].find(label=>label.querySelector('.field-label')?.textContent==='Output directory');const input=label.querySelector('input');input.value=${JSON.stringify(cancelledOutput)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const cancellation = await evaluate<any>(`new Promise((resolve,reject)=>{
      const originalClock=window.setTimeout,held=[];let released=false,unsubscribe=()=>{};
      const release=()=>{released=true;window.setTimeout=originalClock;for(const resume of held.splice(0))resume()};
      const timeout=originalClock.call(window,()=>{unsubscribe();release();reject(new Error('No real terminal preview event arrived for the cancellation regression'))},12000);
      const finish=(error,value)=>{clearTimeout(timeout);unsubscribe();release();if(error)reject(error);else resolve({...value,clockRestored:window.setTimeout===originalClock})};
      unsubscribe=window.delta.onProgress(operation=>{
        if(operation.action!=='restore-plan'||operation.taskId!==${JSON.stringify(taskId)}||operation.status!=='complete')return;
        const cancel=document.getElementById('restore-preview-cancel');
        if(!cancel||cancel.hidden||cancel.disabled){finish(new Error('The real completed preview was consumed before the cancellation regression callback'));return}
        cancel.click();finish(null,{id:operation.id,status:operation.status,planStatus:operation.result?.status});
      });
      // Hold only the renderer's preview polling boundary. The real worker runs
      // to completion and sends its genuine terminal operation event.
      window.setTimeout=function(handler,delay,...args){
        if(delay!==150||typeof handler!=='function')return originalClock.call(window,handler,delay,...args);
        return originalClock.call(window,()=>{const resume=()=>handler(...args);if(released)resume();else held.push(resume)},delay);
      };
      document.querySelector('#dialog button[type=submit]').click();
    })`);
    assert(cancellation.status === "complete" && cancellation.planStatus === "ready" && cancellation.clockRestored, "real worker completes a ready preview before its pending renderer continuation is cancelled, with the test clock restored");
    await waitFor("document.getElementById('dialog').open&&!document.getElementById('notification').hidden&&document.getElementById('notification').dataset.error==='true'&&document.getElementById('notification').textContent.includes('Restore preview cancelled.')&&!document.querySelector('#dialog button[type=submit]').disabled", "human cancellation overriding a ready preview result");
    assert(await evaluate("(() => {const dialog=document.getElementById('dialog'),notification=document.getElementById('notification');return dialog.contains(notification)&&notification.getAttribute('role')==='alert'&&!dialog.querySelector('[aria-invalid=true]')&&!document.getElementById('dialog-error')})()"), "preview cancellation uses one modal notification without marking a valid editor as invalid");
    assert(await evaluate<number>("window.delta.request({action:'operations'}).then(operations=>operations.filter(operation=>operation.action==='restore').length)") === restoreOperations, "cancelling an already completed pre-restore preview never submits an actual restore");
    const existsAfter = await lstat(cancelledOutput).then(() => true, error => { if (error.code === "ENOENT") return false; throw error; });
    assert(!existsAfter, "cancelled pre-restore preview creates no output directory or restored files");
    await key("Escape"); await waitFor("!document.getElementById('dialog').open", "completed preview cancellation regression dismissal");
  }
  await click("Overview"); await expectTab("overview");
  if (!initiallyVisible) window.hide();
  return result;
}
