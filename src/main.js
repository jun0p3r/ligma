'use strict';
const { app, BaseWindow, BrowserWindow, WebContentsView, dialog, ipcMain, session, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { startFontAgent } = require('./fontAgent');

const START_URL = 'https://www.figma.com/files';
const PARTITION = 'persist:figma';
const TITLEBAR_HEIGHT = 36;
const FIGMA_ORIGIN = 'https://www.figma.com';
// Hosts allowed to open as in-app popups (OAuth needs window.opener). Everything else goes to the system browser.
const POPUP_HOSTS = [/(^|\.)figma\.com$/, /^appleid\.apple\.com$/];
// Google doesn't allow sign-in from embedded browsers, so Ligma doesn't offer it.
const GOOGLE_SIGN_IN_HOST = /^accounts\.google\.com$/;
// Figma documents open in their own tab.
const DOC_PATH = /^\/(file|design|board|proto|slides|deck|site|make)\//;
const GRANTED_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'notifications',
  'local-network-access',
  'local-network',
  'loopback-network',
]);

app.setName('Ligma');

// --- Chromium switches ------------------------------------------------------
// The bundled font agent is the only local service Figma talks to; skip Chrome's local-network prompt.
const disabledFeatures = ['LocalNetworkAccessChecks'];
// Chromium ships WebGPU on Linux; don't let a driver blocklist entry knock it back to WebGL.
// Avoid the 'Vulkan' compositing feature: on Wayland it is unsupported and on X11 it disables
// WebGPU canvas interop (forcing a copy per frame).
if (process.env.LIGMA_NO_WEBGPU) {
  disabledFeatures.push('WebGPU');
} else {
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  // Last resort for GPUs/drivers where WebGPU isn't exposed by default.
  if (process.env.LIGMA_FORCE_WEBGPU) app.commandLine.appendSwitch('enable-unsafe-webgpu');
}
app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));


// --- Window state ------------------------------------------------------------
const statePath = () => path.join(app.getPath('userData'), 'window.json');

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return { width: 1440, height: 900 };
  }
}

function saveState(ligmaWin) {
  const { win, tabs } = ligmaWin;
  const fileTabs = tabs.filter((t) => !t.home);
  const state = {
    ...win.getNormalBounds(),
    maximized: win.isMaximized(),
    tabs: fileTabs
      .map((t) => ({ url: t.pending || t.view.webContents.getURL(), title: t.title }))
      .filter((t) => isFigmaUrl(parseUrl(t.url))),
    activeTab: fileTabs.findIndex((t) => t.id === ligmaWin.activeId),
  };
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state));
  } catch (err) {
    console.error('[ligma] failed to save window state:', err);
  }
}

// --- Helpers -----------------------------------------------------------------
function parseUrl(raw) {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function isFigmaUrl(url) {
  return Boolean(url && url.protocol === 'https:' && /(^|\.)figma\.com$/.test(url.hostname));
}

function isDocUrl(url) {
  return isFigmaUrl(url) && DOC_PATH.test(url.pathname);
}

// "/design/<key>/<name>" -> "<key>", used to avoid opening the same file twice.
function docKey(url) {
  return url.pathname.split('/')[2];
}

function openExternal(raw) {
  const url = parseUrl(raw);
  if (url && ['https:', 'http:', 'mailto:'].includes(url.protocol)) shell.openExternal(url.href);
}

function isGoogleSignIn(url) {
  return Boolean(url && GOOGLE_SIGN_IN_HOST.test(url.hostname));
}

let signInNoticeOpen = false;

function showGoogleSignInNotice(win) {
  if (signInNoticeOpen) return;
  signInNoticeOpen = true;
  dialog
    .showMessageBox(win, {
      type: 'info',
      title: 'Google sign-in',
      message: "Google sign-in isn't available in Ligma",
      detail:
        "Google doesn't allow signing in from apps that embed a web browser.\n\n" +
        'Sign in with your Figma email and password instead. If your account was created with Google, ' +
        "use \"Forgot password?\" on Figma's login page to set a password for it.",
      buttons: ['OK', 'Open Figma in Browser'],
      defaultId: 0,
      cancelId: 0,
    })
    .then(({ response }) => {
      if (response === 1) shell.openExternal('https://www.figma.com/login');
    })
    .finally(() => {
      signInNoticeOpen = false;
    });
}

// Stops top-level navigations to Google sign-in in `wc` and explains why instead.
function blockGoogleSignIn(wc, win, onBlocked = () => {}) {
  const guard = (event, raw) => {
    if (!isGoogleSignIn(parseUrl(raw))) return;
    event.preventDefault();
    showGoogleSignInNotice(win);
    onBlocked();
  };
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);
}

function cleanTitle(title) {
  return (title || '').replace(/\s+[–|-]\s+Figma$/, '').trim();
}

// --- Windows and tabs ----------------------------------------------------------
// Each LigmaWindow: { win, titlebar, tabs: [{ id, view, home, title, pending }], activeId }
// `pending` holds the URL of a restored tab that hasn't been loaded yet.
const windows = new Set();
let nextTabId = 1;

function ligmaWindowFor(webContents) {
  for (const lw of windows) {
    if (lw.titlebar.webContents === webContents) return lw;
    if (lw.tabs.some((t) => t.view.webContents === webContents)) return lw;
  }
  return null;
}

function activeTab(lw) {
  return lw.tabs.find((t) => t.id === lw.activeId);
}

function focusedLigmaWindow() {
  for (const lw of windows) if (lw.win.isFocused()) return lw;
  return windows.values().next().value || null;
}

function layout(lw) {
  const { width, height } = lw.win.getContentBounds();
  const top = lw.win.isFullScreen() ? 0 : TITLEBAR_HEIGHT;
  lw.titlebar.setVisible(top > 0);
  lw.titlebar.setBounds({ x: 0, y: 0, width, height: TITLEBAR_HEIGHT });
  for (const tab of lw.tabs) {
    tab.view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }
}

function sendState(lw) {
  if (lw.titlebar.webContents.isDestroyed()) return;
  const active = activeTab(lw);
  const nav = active && !active.view.webContents.isDestroyed() ? active.view.webContents.navigationHistory : null;
  lw.titlebar.webContents.send('ligma:state', {
    tabs: lw.tabs.map((t) => ({
      id: t.id,
      title: t.home ? 'Home' : t.title || 'Loading…',
      home: t.home,
      loading: !t.pending && !t.view.webContents.isDestroyed() && t.view.webContents.isLoading(),
    })),
    activeId: lw.activeId,
    canGoBack: Boolean(nav && nav.canGoBack()),
    canGoForward: Boolean(nav && nav.canGoForward()),
    maximized: lw.win.isMaximized(),
  });
  const title = active && !active.home && active.title ? `${active.title} – Ligma` : 'Ligma';
  lw.win.setTitle(title);
}

function activateTab(lw, id) {
  const tab = lw.tabs.find((t) => t.id === id);
  if (!tab) return;
  lw.activeId = id;
  if (tab.pending) {
    tab.view.webContents.loadURL(tab.pending);
    tab.pending = null;
  }
  for (const t of lw.tabs) t.view.setVisible(t.id === id);
  tab.view.webContents.focus();
  sendState(lw);
}

function closeTab(lw, id) {
  const index = lw.tabs.findIndex((t) => t.id === id);
  const tab = lw.tabs[index];
  if (!tab || tab.home) return;
  lw.tabs.splice(index, 1);
  if (lw.activeId === id) {
    const next = lw.tabs[index] || lw.tabs[index - 1];
    activateTab(lw, next.id);
  }
  lw.win.contentView.removeChildView(tab.view);
  tab.view.webContents.close();
  sendState(lw);
}

function cycleTab(lw, step) {
  const index = lw.tabs.findIndex((t) => t.id === lw.activeId);
  const next = lw.tabs[(index + step + lw.tabs.length) % lw.tabs.length];
  activateTab(lw, next.id);
}

// Opens a Figma document in a tab, reusing the tab if that file is already open.
function openDoc(lw, url) {
  const key = docKey(url);
  const existing = lw.tabs.find((t) => {
    if (t.home) return false;
    const u = parseUrl(t.pending || t.view.webContents.getURL());
    return isDocUrl(u) && docKey(u) === key;
  });
  if (existing) {
    activateTab(lw, existing.id);
    return existing;
  }
  return createTab(lw, url.href, { activate: true });
}

function showHome(lw, url) {
  const home = lw.tabs.find((t) => t.home);
  if (url && url !== home.view.webContents.getURL()) home.view.webContents.loadURL(url);
  activateTab(lw, home.id);
}

// Ligma shortcuts, handled before Figma sees the key. Returns true if handled.
function handleShortcut(lw, input) {
  if (input.type !== 'keyDown') return false;
  const ctrl = input.control || input.meta;
  const key = input.key.toLowerCase();
  const tab = activeTab(lw);
  if (ctrl && key === 'tab') cycleTab(lw, input.shift ? -1 : 1);
  else if (ctrl && !input.shift && key === 'pageup') cycleTab(lw, -1);
  else if (ctrl && !input.shift && key === 'pagedown') cycleTab(lw, 1);
  else if (ctrl && !input.shift && key === 't') createTab(lw, START_URL, { activate: true });
  else if (ctrl && !input.shift && key === 'w') closeTab(lw, lw.activeId);
  else if (input.key === 'F5' || (ctrl && !input.shift && key === 'r')) tab.view.webContents.reload();
  else if (input.key === 'F12' || (ctrl && input.shift && key === 'i')) tab.view.webContents.toggleDevTools();
  else if (input.key === 'F11') lw.win.setFullScreen(!lw.win.isFullScreen());
  else return false;
  return true;
}

function createTab(lw, url, { home = false, activate = false, lazy = false, title = '' } = {}) {
  const view = new WebContentsView({
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      sandbox: true,
    },
  });
  const tab = { id: nextTabId++, view, home, title, pending: lazy ? url : null };
  const wc = view.webContents;
  lw.tabs.push(tab);
  // Keep the title bar on top of every tab view.
  lw.win.contentView.addChildView(view, lw.win.contentView.children.indexOf(lw.titlebar));
  view.setVisible(false);
  layout(lw);

  wc.on('page-title-updated', (_e, title) => {
    tab.title = cleanTitle(title);
    sendState(lw);
  });
  for (const ev of ['did-start-loading', 'did-stop-loading']) wc.on(ev, () => sendState(lw));

  // Figma is a single-page app, so moving between the file browser and a file is usually in-page.
  let wasDoc = isDocUrl(parseUrl(url));
  const onNavigate = (_e, raw) => {
    const u = parseUrl(raw);
    const doc = isDocUrl(u);
    if (tab.home && doc) {
      // The home tab always stays on the file browser; files get their own tab.
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else wc.loadURL(START_URL);
      openDoc(lw, u);
    } else if (!tab.home && wasDoc && isFigmaUrl(u) && u.pathname.startsWith('/files')) {
      // "Back to files" from inside a file: return to the home tab instead.
      showHome(lw, u.href);
      setImmediate(() => closeTab(lw, tab.id));
      return;
    }
    wasDoc = doc;
    sendState(lw);
  };
  wc.on('did-navigate', onNavigate);
  wc.on('did-navigate-in-page', onNavigate);

  wc.setWindowOpenHandler(({ url: raw }) => {
    const u = parseUrl(raw);
    if (isDocUrl(u)) {
      openDoc(lw, u);
      return { action: 'deny' };
    }
    if (isFigmaUrl(u) && u.pathname.startsWith('/files')) {
      showHome(lw, u.href);
      return { action: 'deny' };
    }
    if (isGoogleSignIn(u)) {
      showGoogleSignInNotice(lw.win);
      return { action: 'deny' };
    }
    if (u && u.protocol === 'https:' && POPUP_HOSTS.some((re) => re.test(u.hostname))) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#ffffff' },
      };
    }
    openExternal(raw);
    return { action: 'deny' };
  });
  // Sign-in popups (e.g. a figma.com page that redirects on to Google) get the same guard.
  wc.on('did-create-window', (child) => {
    blockGoogleSignIn(child.webContents, lw.win, () => child.close());
  });
  blockGoogleSignIn(wc, lw.win);
  wc.on('will-navigate', (event, raw) => {
    const u = parseUrl(raw);
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
      event.preventDefault();
      openExternal(raw);
    }
  });
  wc.on('before-input-event', (event, input) => {
    if (handleShortcut(lw, input)) event.preventDefault();
  });

  if (!lazy) wc.loadURL(url);
  if (activate) activateTab(lw, tab.id);
  else sendState(lw);
  return tab;
}

function createWindow({ restoredTabs = [], activeIndex = -1, restoreState = false } = {}) {
  const state = restoreState ? loadState() : { width: 1440, height: 900 };
  const win = new BaseWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 640,
    minHeight: 400,
    frame: false,
    backgroundColor: '#2c2c2c',
    title: 'Ligma',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
  });
  if (state.maximized) win.maximize();

  const titlebar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.contentView.addChildView(titlebar);
  const lw = { win, titlebar, tabs: [], activeId: null };
  windows.add(lw);

  titlebar.webContents.on('did-finish-load', () => sendState(lw));
  titlebar.webContents.on('before-input-event', (event, input) => {
    if (handleShortcut(lw, input)) event.preventDefault();
  });
  titlebar.webContents.loadFile(path.join(__dirname, 'titlebar.html'));

  const home = createTab(lw, START_URL, { home: true });
  const fileTabs = restoredTabs.map((t) => createTab(lw, t.url, { lazy: true, title: t.title }));
  activateTab(lw, ((activeIndex >= 0 && fileTabs[activeIndex]) || home).id);

  win.on('resize', () => layout(lw));
  for (const ev of ['maximize', 'unmaximize']) win.on(ev, () => sendState(lw));
  for (const ev of ['enter-full-screen', 'leave-full-screen']) win.on(ev, () => layout(lw));

  win.on('close', () => {
    if (windows.size === 1) saveState(lw);
  });
  win.on('closed', () => {
    windows.delete(lw);
    titlebar.webContents.close();
    for (const t of lw.tabs) t.view.webContents.close();
  });
  return lw;
}

// --- IPC from the title bar ----------------------------------------------------
ipcMain.on('ligma:command', (event, command, arg) => {
  const lw = ligmaWindowFor(event.sender);
  if (!lw || event.sender !== lw.titlebar.webContents) return;
  const { win } = lw;
  const wc = activeTab(lw).view.webContents;
  switch (command) {
    case 'back':
      if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      break;
    case 'forward':
      if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      break;
    case 'reload':
      wc.reload();
      break;
    case 'new-tab':
      createTab(lw, START_URL, { activate: true });
      break;
    case 'activate-tab':
      activateTab(lw, Number(arg));
      break;
    case 'close-tab':
      closeTab(lw, Number(arg));
      break;
    case 'minimize':
      win.minimize();
      break;
    case 'maximize':
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case 'close':
      win.close();
      break;
  }
});

// --- Session -----------------------------------------------------------------
function setupSession() {
  const ses = session.fromPartition(PARTITION);

  const allowed = (origin, permission) => {
    const url = parseUrl(origin || '');
    return Boolean(url && url.origin === FIGMA_ORIGIN && GRANTED_PERMISSIONS.has(permission));
  };
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(allowed(details.requestingUrl || wc.getURL(), permission));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => allowed(requestingOrigin, permission));
}

// Opens a figma.com URL passed on the command line: documents as tabs, anything else in the home tab.
function openFromArgs(lw, argv) {
  const target = argv.map(parseUrl).find(isFigmaUrl);
  if (!target) return false;
  if (isDocUrl(target)) openDoc(lw, target);
  else showHome(lw, target.href);
  return true;
}

// --- App lifecycle -----------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const lw = focusedLigmaWindow();
    if (!lw) return;
    openFromArgs(lw, argv);
    if (lw.win.isMinimized()) lw.win.restore();
    lw.win.focus();
  });

  app.whenReady().then(async () => {
    await startFontAgent();
    setupSession();
    const state = loadState();
    const lw = createWindow({
      restoredTabs: (Array.isArray(state.tabs) ? state.tabs : []).filter((t) => isFigmaUrl(parseUrl(t && t.url))),
      activeIndex: state.activeTab ?? -1,
      restoreState: true,
    });
    openFromArgs(lw, process.argv);

    if (process.argv.includes('--gpu-debug')) {
      const gpu = new BrowserWindow({ width: 1000, height: 800, title: 'Ligma GPU info' });
      gpu.loadURL('chrome://gpu');
    }
  });

  app.on('window-all-closed', () => app.quit());
}
