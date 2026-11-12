/**
 * BeatSync Studio — macOS app shell.
 *
 * Starts the bundled Next.js production server (with a bundled FFmpeg) on a
 * FIXED local port and shows it in a native window. The port must stay the
 * same between launches: saved projects live in IndexedDB, which is scoped to
 * the page origin including its port.
 */
const { app, BrowserWindow, dialog, shell, utilityProcess } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");

const PORT = 47100;
const HOST = "127.0.0.1";
const ORIGIN = `http://${HOST}:${PORT}`;

let server = null;
let win = null;
let quitting = false;

// Packaged: <App>/Contents/Resources/{server,bin}. Dev: the assembled app-build/ folder.
const resources = app.isPackaged ? process.resourcesPath : path.join(__dirname, "..", "app-build");
const serverDir = path.join(resources, "server");
const binDir = path.join(resources, "bin");

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(start);
}

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, HOST);
  });
}

async function waitForServer(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${ORIGIN}/api/health`, { cache: "no-store" });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const SPLASH = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0e;color:#c3c7d3;font:14px -apple-system,system-ui,sans-serif">
<div style="text-align:center"><div style="font-size:20px;color:#fff;font-weight:600;margin-bottom:8px">BeatSync <span style="background:linear-gradient(90deg,#a78bfa,#22d3ee);-webkit-background-clip:text;color:transparent">Studio</span></div>Starting…</div></body></html>`)}`;

async function start() {
  if (!(await portFree(PORT))) {
    dialog.showErrorBox(
      "BeatSync Studio can't start",
      `Port ${PORT} is already in use. Another copy of BeatSync may still be running — quit it (or restart your Mac) and try again.`,
    );
    app.quit();
    return;
  }
  if (!fs.existsSync(path.join(serverDir, "server.js"))) {
    dialog.showErrorBox("BeatSync Studio is incomplete", `The app's server files are missing (${serverDir}). Please reinstall.`);
    app.quit();
    return;
  }

  const dataDir = path.join(app.getPath("userData"), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  server = utilityProcess.fork(path.join(serverDir, "server.js"), [], {
    cwd: serverDir,
    serviceName: "BeatSync Server",
    stdio: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      HOSTNAME: HOST,
      BEATSYNC_DATA_DIR: dataDir,
      FFMPEG_PATH: path.join(binDir, "ffmpeg"),
      FFPROBE_PATH: path.join(binDir, "ffprobe"),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  const log = fs.createWriteStream(path.join(app.getPath("userData"), "server.log"), { flags: "a" });
  server.stdout?.pipe(log);
  server.stderr?.pipe(log);
  server.on("exit", (code) => {
    server = null;
    if (!quitting) {
      dialog.showErrorBox("BeatSync Studio stopped", `The editor's background server exited (code ${code}). Details are in ${path.join(app.getPath("userData"), "server.log")}.`);
      app.quit();
    }
  });

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#0b0b0e",
    title: "BeatSync Studio",
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => (win = null));
  await win.loadURL(SPLASH);

  // Links that leave the app open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(ORIGIN)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(ORIGIN) && !url.startsWith("data:")) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  // Exports: ask where to save, starting in Downloads.
  win.webContents.session.on("will-download", (_e, item) => {
    item.setSaveDialogOptions({ defaultPath: path.join(app.getPath("downloads"), item.getFilename()) });
  });

  if (!(await waitForServer(60_000))) {
    dialog.showErrorBox("BeatSync Studio didn't start", `The editor's server didn't respond. Details are in ${path.join(app.getPath("userData"), "server.log")}.`);
    app.quit();
    return;
  }
  await win.loadURL(ORIGIN);
}

function stopServer() {
  quitting = true;
  if (server) {
    server.kill();
    server = null;
  }
}

app.on("before-quit", stopServer);
// A single-window editor: closing the window quits the app (and its server).
app.on("window-all-closed", () => app.quit());
