'use strict';
const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, Notification, shell, screen, powerMonitor } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { DEFAULT_ENDPOINT, INTERVAL_MS, probe, summarize, normalizeEndpoint } = require('./monitor.cjs');
let win, tray, timer, configFile, config, state, inFlight, generation = 0, failures = 0, notifiedDown = false;

function persist() { try { fs.writeFileSync(configFile, JSON.stringify(config, null, 2)); } catch { /* Monitoring works even if preferences cannot be saved. */ } }
function publicState() { return { ...state, settings: { endpoint: config.endpoint, monitorLocal: config.monitorLocal, pinned: config.pinned, notifications: config.notifications } }; }
function publish() {
  if (win && !win.isDestroyed()) win.webContents.send('status', publicState());
  if (tray) {
    tray.setImage(nativeImage.createFromPath(path.join(__dirname, 'assets', `${state.summary.level}.png`)).resize({ width: 18, height: 18 }));
    tray.setToolTip(`GOP Status — ${state.summary.title}`);
  }
}
function show() { win.show(); win.focus(); }
async function check() {
  if (inFlight) return inFlight;
  clearTimeout(timer);
  const current = generation;
  state.checking = true; publish();
  inFlight = (async () => {
    const [remote, local] = await Promise.all([
      probe(config.endpoint), config.monitorLocal ? probe('http://127.0.0.1:5002/health') : Promise.resolve(null),
    ]);
    if (current !== generation) return;
    failures = remote.ok ? 0 : failures + 1;
    state = { ...state, remote, local, checking: false, checkedAt: Date.now(), nextCheckAt: Date.now() + INTERVAL_MS,
      summary: summarize(remote, local, failures), history: [...state.history, { ok: remote.ok, at: Date.now() }].slice(-30) };
    if (failures >= 2 && !notifiedDown) {
      notifiedDown = true;
      if (config.notifications && Notification.isSupported()) new Notification({ title: 'GOP connection lost', body: state.summary.detail }).show();
    } else if (remote.ok && notifiedDown) {
      notifiedDown = false;
      if (config.notifications && Notification.isSupported()) new Notification({ title: 'GOP connection restored', body: 'The public server is responding again.' }).show();
    }
    publish();
  })().finally(() => { inFlight = null; timer = setTimeout(check, INTERVAL_MS); });
  return inFlight;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) show(); });
  app.whenReady().then(async () => {
    app.setAppUserModelId('app.gardenofpapers.status');
    configFile = path.join(app.getPath('userData'), 'settings.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch {}
    let endpoint = DEFAULT_ENDPOINT;
    try { endpoint = normalizeEndpoint(saved.endpoint || DEFAULT_ENDPOINT); } catch {}
    config = { endpoint, pinned: saved.pinned !== false, notifications: saved.notifications === true,
      monitorLocal: typeof saved.monitorLocal === 'boolean' ? saved.monitorLocal : (await probe('http://127.0.0.1:5002/health')).ok,
      position: saved.position };
    state = { checking: false, checkedAt: null, nextCheckAt: null, remote: null, local: null, history: [],
      summary: { level: 'checking', title: 'Checking connection', detail: 'Contacting your Garden of Papers server…' } };
    const area = screen.getPrimaryDisplay().workArea;
    const position = config.position;
    const validPosition = position && Number.isFinite(position.x) && Number.isFinite(position.y) && screen.getAllDisplays().some(({ workArea: a }) => position.x >= a.x && position.y >= a.y && position.x + 260 <= a.x + a.width && position.y + 128 <= a.y + a.height);
    win = new BrowserWindow({ width: 260, height: 128, resizable: false, frame: false, show: false,
      x: validPosition ? position.x : area.x + area.width - 280, y: validPosition ? position.y : area.y + 30,
      transparent: true, vibrancy: process.platform === 'darwin' ? 'under-window' : undefined, visualEffectState: 'active', backgroundColor: '#00000000', title: 'GOP Status', alwaysOnTop: config.pinned,
      webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('moved', () => { const { x, y } = win.getBounds(); config.position = { x, y }; persist(); });
    win.on('close', event => { event.preventDefault(); win.hide(); });
    win.once('ready-to-show', () => win.show());
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'checking.png')).resize({ width: 18, height: 18 }));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show GOP Status', click: show }, { label: 'Check now', click: check },
      { label: 'Open Garden of Papers', click: () => shell.openExternal('https://gardenofpapers.app/') },
      { type: 'separator' }, { label: 'Quit', click: () => app.quit() },
    ]));
    tray.on('click', show);
    ipcMain.handle('state', () => publicState());
    ipcMain.handle('refresh', async () => { await check(); return publicState(); });
    ipcMain.handle('settings', async (_, value) => {
      let endpoint;
      try { endpoint = normalizeEndpoint(value?.endpoint); } catch (error) { return { error: error.message }; }
      generation += 1;
      config = { ...config, endpoint, monitorLocal: value.monitorLocal === true, notifications: value.notifications === true };
      persist();
      if (inFlight) await inFlight;
      failures = 0; notifiedDown = false;
      state = { ...state, remote: null, local: null, checkedAt: null, history: [], summary: { level: 'checking', title: 'Checking connection', detail: 'Contacting your server…' } };
      await check(); return { ok: true };
    });
    ipcMain.handle('action', (_, action) => {
      if (action === 'pin') { config.pinned = !config.pinned; win.setAlwaysOnTop(config.pinned); persist(); publish(); }
      if (action === 'settings') win.setSize(360, 405);
      if (action === 'compact') win.setSize(260, 128);
      if (action === 'hide') win.hide();
      if (action === 'quit') app.quit();
      if (action === 'open') shell.openExternal('https://gardenofpapers.app/');
    });
    powerMonitor.on('resume', () => { state.checkedAt = null; failures = 0; publish(); if (inFlight) inFlight.finally(check); else check(); });
    powerMonitor.on('suspend', () => { clearTimeout(timer); state.checkedAt = null; publish(); });
    app.on('activate', show);
    persist();
    await win.loadFile(path.join(__dirname, 'ui', 'index.html'));
    check();
  });
}
app.on('before-quit', () => { clearTimeout(timer); if (win) win.removeAllListeners('close'); });
