const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")

const panel = fs.readFileSync(path.join(__dirname, "..", "Panel.qml"), "utf8")

test("account selection is shared through the service", () => {
  assert.match(panel, /readonly property string accountFilter:\s*service\.accountFilter/)
  assert.match(panel, /function setAccountFilter\(value\)\s*{\s*service\.setAccountFilter\(value\)/)
})

test("account options expose unread counts as styled badges", () => {
  assert.match(panel, /label:\s*options\[i\]\.label,\s*badge:\s*count > 0 \? String\(count\) : ""/)
  assert.match(panel, /function accountUnreadCount\(accountId\)\s*{\s*return Model\.unreadCount\(service\.notifications, String\(accountId \|\| ""\)\)/)
  assert.match(panel, /id:\s*accountDropdown[\s\S]*?badgeColor:\s*root\.urgent/)
})

test("shared account changes reset each panel's filtered view", () => {
  assert.match(panel, /Connections\s*{\s*target:\s*root\.service\s*function onAccountFilterChanged\(\)\s*{\s*root\.resetFilteredView\(\)/)
  assert.match(panel, /function onFolderFilterChanged\(\)\s*{\s*root\.resetFilteredView\(\)/)
})

test("folder selection is shared through the service and drives the list", () => {
  assert.match(panel, /readonly property string folderFilter:\s*service\.folderFilter/)
  assert.match(panel, /function toggleFolderFilter\(value\)\s*{\s*service\.toggleFolderFilter\(value\)/)
  assert.match(panel, /readonly property var folderChips:\s*Model\.folderChips\(service\.folders,\s*accountFilter\)/)
  assert.match(panel, /readonly property bool showFolderChips:\s*service\.foldersMode === "all" && folderChips\.length > 1 && !needsSetup/)
  assert.match(panel, /Model\.filterNotifications\(service\.notifications,\s*accountFilter,\s*stateFilter,\s*folderFilter,\s*folderChips\)/)
})

test("folder chips render the folder name with an urgent count bubble and toggle on click", () => {
  const strip = panel.slice(panel.indexOf("id: folderStrip"), panel.indexOf("id: panelFlick"))
  assert.match(strip, /visible:\s*root\.showFolderChips/)
  assert.match(strip, /flickableDirection:\s*Flickable\.HorizontalFlick/)
  assert.match(strip, /model:\s*root\.folderChips/)
  assert.match(strip, /text:\s*folderChip\.modelData\.name/)
  assert.match(strip, /text:\s*String\(folderChip\.modelData\.unreadCount\)/)
  assert.match(strip, /color:\s*root\.urgent/)
  assert.match(strip, /Style\.selectedFillFor\(root\.foreground,\s*Color\.accent\)/)
  assert.match(strip, /onClicked:\s*root\.toggleFolderFilter\(folderChip\.modelData\.id\)/)
  assert.doesNotMatch(strip, /import /, "the strip is inlined rather than a local component")
})

test("F cycles the folder filter while arrows still cycle accounts", () => {
  assert.match(panel, /if \(dx !== 0\) root\.cycleAccountFilter\(dx\)/)
  assert.match(panel, /else if \(text === "f" \|\| text === "F"\) root\.cycleFolderFilter\(\)/)
  assert.match(panel, /function cycleFolderFilter\(\)\s*{\s*if \(!showFolderChips\) return/)
})

test("rows name the folder while the list spans folders", () => {
  assert.match(panel, /Model\.notificationMeta\(notificationRow\.modelData,\s*root\.nowMs,\s*root\.accountFilter === "" && service\.accountCount > 1,\s*root\.folderFilter === ""\)/)
})

test("settings expose the folders mode and the exclude list", () => {
  assert.match(panel, /PlainTextDropdown\s*{\s*id:\s*foldersDropdown[\s\S]*?options:\s*root\.foldersOptions/)
  assert.match(panel, /{ value: "all", label: "All folders" },\s*{ value: "inbox", label: "Inbox only" }/)
  assert.match(panel, /onChanged:\s*function\(value\)\s*{\s*root\.persistSettings\({ folders: value }\)/)
  assert.match(panel, /Binding on value\s*{\s*value:\s*service\.foldersMode\s*}/)
  assert.match(panel, /TextField\s*{\s*id:\s*excludeFoldersField/)
  assert.match(panel, /maximumLength:\s*Model\.excludeFoldersSettingCharacterLimit/)
  assert.match(panel, /onEditingFinished:\s*root\.persistExcludeFolders\(text\)/)
  assert.match(panel, /Binding on text\s*{\s*value:\s*root\.excludeFoldersText\s*}/)
  assert.match(panel, /persistSettings\({ excludeFolders: normalized }\)/)
  assert.match(panel, /foldersDropdown\.close\(\)/)
  assert.match(panel, /blocked:[^\n]*foldersDropdown\.popupOpen/)
})

test("bar tooltip stays hidden while Fastmail setup is needed", () => {
  assert.match(panel, /tooltipText:\s*root\.needsSetup\s*\?\s*""\s*:\s*service\.refreshing/)
})

test("setup panel keeps the Fastmail header visible", () => {
  assert.match(panel, /Column\s*{\s*id:\s*fixedContent\s*Layout\.fillWidth/)
  const header = panel.slice(panel.indexOf("id: fixedContent"), panel.indexOf("PanelSeparator", panel.indexOf("id: fixedContent")))
  assert.match(header, /MailIcon\s*{/)
  assert.match(header, /text:\s*"Fastmail"/)
})

test("missing CLI state hides header actions", () => {
  assert.match(panel, /id:\s*settingsButton\s*visible:\s*!root\.missingCli/)
  assert.match(panel, /id:\s*refreshButton\s*visible:\s*!root\.missingCli/)
})
