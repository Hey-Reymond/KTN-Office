// KTN Office — app de desktop (Electron).
// Liga o servidor do escritório dentro do app (ou usa um que já esteja rodando, ex.: npm start)
// e mostra a interface numa janela própria, com ícone na bandeja e opção de iniciar com o Windows.
const { app, BrowserWindow, Menu, Tray, nativeImage, nativeTheme, shell, dialog } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PORTA = Number(process.env.KTN_PORT || 7777);
const URL_APP = `http://127.0.0.1:${PORTA}/`;
const RAIZ = app.isPackaged ? path.join(process.resourcesPath, "app") : path.resolve(__dirname, "..");
const ICONE = path.join(__dirname, "build", "icon.png");

let janela = null;
let bandeja = null;
let saindo = false;
const iniciouOculto = process.argv.includes("--oculto");

if (!app.requestSingleInstanceLock()) app.quit(); // só uma janela do Office
app.on("second-instance", () => mostrar());

async function servidorNoAr() {
  try {
    const r = await fetch(`${URL_APP}status`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ligarServidor() {
  if (await servidorNoAr()) return "externo"; // já tem um rodando (npm start): só abre a janela
  if (!app.isPackaged) {
    // Desenvolvimento: roda o servidor com o Node do sistema (os módulos nativos do server/ são compilados para ele).
    const { spawn } = require("node:child_process");
    const filho = spawn("npm", ["start"], { cwd: path.join(RAIZ, "server"), shell: true, stdio: "inherit", env: { ...process.env, KTN_PORT: String(PORTA) } });
    app.on("will-quit", () => filho.kill());
    for (let i = 0; i < 100; i++) {
      if (await servidorNoAr()) return "dev";
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("O servidor (npm start na pasta server) não respondeu.");
  }
  // Dados graváveis ficam fora da pasta do app (que pode ser só leitura).
  const dados = path.join(app.getPath("home"), "KTN-Office-dados");
  process.env.KTN_DADOS ||= dados;
  process.env.KTN_CLIS_CUSTOM ||= path.join(dados, "clis.custom.json");
  process.env.KTN_PORT = String(PORTA);
  await import(pathToFileURL(path.join(RAIZ, "server", "dist", "index.js")).href);
  for (let i = 0; i < 50; i++) {
    if (await servidorNoAr()) return "interno";
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("O servidor do escritório não respondeu.");
}

function criarJanela() {
  janela = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "KTN Office",
    icon: ICONE,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#14161c" : "#f6f7f9",
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  janela.loadURL(URL_APP);
  janela.once("ready-to-show", () => { if (!iniciouOculto) janela.show(); });
  // Links externos abrem no seu navegador, não dentro do app.
  janela.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url) && !url.startsWith(URL_APP)) shell.openExternal(url);
    return { action: "deny" };
  });
  janela.webContents.on("will-navigate", (ev, url) => {
    if (!url.startsWith(URL_APP)) { ev.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
  // Fechar a janela só esconde: o expediente continua na bandeja.
  janela.on("close", (ev) => {
    if (saindo) return;
    ev.preventDefault();
    janela.hide();
  });
}

function mostrar() {
  if (!janela) return;
  if (janela.isMinimized()) janela.restore();
  janela.show();
  janela.focus();
}

function iniciaComWindows() {
  return app.getLoginItemSettings().openAtLogin;
}

function montarBandeja() {
  const img = nativeImage.createFromPath(path.join(__dirname, "build", process.platform === "win32" ? "tray16.png" : "tray.png"));
  bandeja = new Tray(img);
  bandeja.setToolTip("KTN Office");
  const atualizarMenu = () =>
    bandeja.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Abrir o KTN Office", click: mostrar },
        { type: "separator" },
        {
          label: "Iniciar com o Windows",
          type: "checkbox",
          checked: iniciaComWindows(),
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked, args: ["--oculto"] });
            atualizarMenu();
          },
        },
        { type: "separator" },
        { label: "Sair (para o expediente)", click: () => { saindo = true; app.quit(); } },
      ]),
    );
  atualizarMenu();
  bandeja.on("click", mostrar);
}

app.whenReady().then(async () => {
  nativeTheme.themeSource = "system"; // a interface segue o tema do Windows
  if (process.platform === "win32") app.setAppUserModelId("dev.ktn.office"); // notificações com o nome certo
  try {
    await ligarServidor();
  } catch (e) {
    dialog.showErrorBox("KTN Office", `Não consegui ligar o escritório.\n\n${e && e.message ? e.message : e}\n\nSe a porta ${PORTA} estiver ocupada, feche o outro programa e abra de novo.`);
    app.exit(1);
    return;
  }
  Menu.setApplicationMenu(null);
  criarJanela();
  montarBandeja();
});

app.on("before-quit", () => { saindo = true; });
app.on("window-all-closed", (ev) => ev.preventDefault()); // continua na bandeja
app.on("activate", mostrar);
