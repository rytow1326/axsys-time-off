// Axsys Time Off — employee desktop app (main process)
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage } = require("electron");
const path = require("path");

const APP_ID = "com.axsysinc.timeoff";
let win = null;
let tray = null;
let quitting = false;
let trayHintShown = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
}

if (process.platform === "win32") app.setAppUserModelId(APP_ID);

function iconPath() {
  return path.join(__dirname, "build", "icon.png");
}

function createWindow() {
  win = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 820,
    minHeight: 600,
    title: "Axsys Time Off",
    icon: iconPath(),
    backgroundColor: "#0b2447",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => win.show());

  // Links open in the default browser, never inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://")) { e.preventDefault(); }
  });

  // Closing the window keeps the app in the tray so approval alerts still arrive
  win.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({
        title: "Axsys Time Off is still running",
        body: "You'll get a notification when a request is approved or denied. Right-click the tray icon to quit.",
        icon: iconPath(),
      }).show();
    }
  });
}

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createTray() {
  const img = nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip("Axsys Time Off");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Open Axsys Time Off", click: showWindow },
    { type: "separator" },
    { label: "Quit", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showWindow);
}

// ---- IPC from the page -------------------------------------------------
ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("app:open-external", (_e, url) => {
  if (typeof url === "string" && /^https:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.handle("app:notify", (_e, { title, body }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: String(title).slice(0, 120), body: String(body).slice(0, 400), icon: iconPath() });
  n.on("click", showWindow);
  n.show();
});
ipcMain.handle("app:set-badge", (_e, count) => {
  tray?.setToolTip(count ? `Axsys Time Off — ${count} new` : "Axsys Time Off");
  if (process.platform === "win32" && win) win.flashFrame(Boolean(count) && !win.isFocused());
});

// ---- Auto-update (GitHub Releases; see SETUP.md) -------------------------
function setupAutoUpdate() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = true;
    autoUpdater.on("update-downloaded", (info) => {
      win?.webContents.send("app:update-ready", info.version);
    });
    autoUpdater.on("error", () => { /* offline or no releases yet — ignore */ });
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
    ipcMain.handle("app:install-update", () => { quitting = true; autoUpdater.quitAndInstall(); });
  } catch {
    /* updater not available */
  }
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  setupAutoUpdate();
});

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { /* stay in tray */ });
