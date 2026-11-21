/** A local loading page with no preload, IPC, scripts, network or database access. */
import type { AppTranslate } from "@openbot/i18n";
import { app, BrowserWindow, nativeTheme, session } from "electron";

interface StartupLoadingOptions {
  translate: AppTranslate;
  iconPath: string;
  quit(): void;
}

export interface StartupLoadingWindow {
  window: BrowserWindow;
  ready: Promise<void>;
  close(): void;
}

export function openStartupLoadingWindow(options: StartupLoadingOptions): StartupLoadingWindow {
  const isolatedSession = session.fromPartition("openbot-startup-loading");
  isolatedSession.setPermissionRequestHandler((_contents, _permission, reply) => reply(false));
  isolatedSession.setPermissionCheckHandler(() => false);
  const label = options.translate("app.loading");
  const color = nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff";
  const foreground = nativeTheme.shouldUseDarkColors ? "#f5f5f7" : "#1c1c1e";
  const safeLabel = label.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const page = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'none'; base-uri 'none'; form-action 'none'">
<title>${safeLabel}</title><style>
html{color:${foreground};background:${color};font:16px system-ui;text-align:center}
body{margin:56px 24px}progress{display:block;margin:28px auto;width:220px}
</style><main role="status"><h1>${safeLabel}</h1><progress></progress></main>`;
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(page)}`;
  isolatedSession.webRequest.onBeforeRequest((details, reply) => reply({ cancel: details.url !== url }));
  const window = new BrowserWindow({
    width: 420,
    height: 240,
    show: false,
    resizable: false,
    title: label,
    icon: options.iconPath,
    backgroundColor: color,
    autoHideMenuBar: true,
    webPreferences: {
      session: isolatedSession,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-attach-webview", (event) => event.preventDefault());
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  let closing = false;
  const close = () => {
    closing = true;
    if (!window.isDestroyed()) window.destroy();
  };
  window.on("close", (event) => {
    if (closing) return;
    event.preventDefault();
    options.quit();
  });
  app.once("before-quit", close);
  window.once("closed", () => app.removeListener("before-quit", close));
  window.once("ready-to-show", () => window.showInactive());
  const ready = window.loadURL(url).then(() => {
    performance.mark("openbot:loading-window-ready");
  });
  return { window, ready, close };
}
