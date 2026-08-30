'use strict';
// FleetView 데스크톱 껍데기.
// 서버를 같은 프로세스 안에서 띄우고, 그 화면을 창으로 보여준다.
// 웹 대시보드로 쓰던 것과 완전히 같은 UI다.

const { app, BrowserWindow, Tray, Menu, globalShortcut, shell, nativeImage } = require('electron');
const path = require('path');

const PORT = Number(process.env.FLEET_PORT || 7777);
const URL = 'http://localhost:' + PORT;

let win = null;
let tray = null;

// 서버를 인프로세스로 기동 (server/index.js 는 require 시 스스로 listen 한다)
require(path.join(__dirname, '..', 'server', 'index.js'));

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    backgroundColor: '#0e1116',
    title: 'FleetView',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(URL);

  // 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL)) { shell.openExternal(url); return { action: 'deny' }; }
    return { action: 'allow' };
  });

  // 닫기는 트레이로 숨기기 (완전 종료는 트레이 메뉴에서)
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
}

function toggleWindow() {
  if (!win) return createWindow();
  if (win.isVisible() && win.isFocused()) win.hide();
  else { win.show(); win.focus(); }
}

// 트레이 아이콘: 외부 파일 없이 코드로 만든다
function trayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = x >= 2 && x <= 13 && y >= 2 && y <= 13;
      const bar = inside && (x === 4 || x === 7 || x === 10);
      buf[i] = bar ? 255 : 76;       // B
      buf[i + 1] = bar ? 255 : 141;  // G
      buf[i + 2] = bar ? 255 : 255;  // R
      buf[i + 3] = inside ? 255 : 0; // A
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

app.whenReady().then(() => {
  createWindow();

  tray = new Tray(trayIcon());
  tray.setToolTip('FleetView');
  const menu = Menu.buildFromTemplate([
    { label: '대시보드 열기', click: () => { win.show(); win.focus(); } },
    {
      label: '항상 위에 고정',
      type: 'checkbox',
      click: (item) => win.setAlwaysOnTop(item.checked),
    },
    { label: '브라우저에서 열기', click: () => shell.openExternal(URL) },
    { type: 'separator' },
    { label: '종료', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', toggleWindow);

  // Ctrl+Shift+Space 로 어디서든 소환
  globalShortcut.register('Control+Shift+Space', toggleWindow);
});

app.on('window-all-closed', () => { /* 트레이에 남는다 */ });
app.on('activate', () => { if (!win) createWindow(); else win.show(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
