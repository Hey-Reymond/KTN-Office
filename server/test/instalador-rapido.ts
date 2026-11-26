/** Instalador rápido: planos multiplataforma (Windows/Ubuntu/macOS), gh CLI, progresso ao vivo e cancelamento (X). */
import assert from "node:assert/strict";
import { planejarInstalacao, planejarInstalacaoGh } from "../src/equipe/instalar.js";
import { GerenciadorInstalacoes } from "../src/equipe/instalador-rapido.js";
import type { ConfigCli } from "../src/equipe/registro.js";

const espera = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 1. Planos multiplataforma para CLI de IA
const cliTeste: ConfigCli = {
  nome: "Demo CLI",
  executavel: "demo",
  versao: ["--version"],
  prompt: ["{prompt}"],
  instalar: {
    windows: "irm https://example.com/win.ps1 | iex",
    linux: "curl -fsSL https://example.com/linux.sh | bash",
    macos: "brew install demo",
    npm: "@demo/cli",
  },
};

const pWin = planejarInstalacao(cliTeste, "win32", () => "/bin/npm");
assert.equal(pWin.possivel, true);
assert.equal(pWin.comando, "powershell");
assert.match(pWin.descricao, /win\.ps1/);

const pLin = planejarInstalacao(cliTeste, "linux", () => "/bin/npm");
assert.equal(pLin.possivel, true);
assert.equal(pLin.comando, "bash");
assert.match(pLin.descricao, /linux\.sh/);

const pMac = planejarInstalacao(cliTeste, "darwin", () => "/bin/npm");
assert.equal(pMac.possivel, true);
assert.equal(pMac.comando, "bash");
assert.match(pMac.descricao, /brew install demo/);

const cliNpm: ConfigCli = {
  nome: "Npm CLI",
  executavel: "npmcli",
  versao: ["-v"],
  prompt: ["{prompt}"],
  instalar: { npm: "@demo/npmcli" },
};
assert.equal(planejarInstalacao(cliNpm, "linux", () => null).possivel, false);
assert.equal(planejarInstalacao(cliNpm, "linux", (c) => (c === "npm" ? "/usr/bin/npm" : null)).comando, "npm");

// 2. Planos multiplataforma para GitHub CLI (gh)
const ghWinWinget = planejarInstalacaoGh("win32", (c) => (c === "winget" ? "winget.exe" : null));
assert.equal(ghWinWinget.possivel, true);
assert.equal(ghWinWinget.comando, "winget");

const ghWinPs = planejarInstalacaoGh("win32", () => null);
assert.equal(ghWinPs.possivel, true);
assert.equal(ghWinPs.comando, "powershell");

const ghUbuntu = planejarInstalacaoGh("linux", (c) => (c === "curl" || c === "tar" ? `/usr/bin/${c}` : null));
assert.equal(ghUbuntu.possivel, true);
assert.equal(ghUbuntu.comando, "bash");
assert.match(ghUbuntu.descricao, /\.local\/bin\/gh/);

const ghUbuntuSemCurl = planejarInstalacaoGh("linux", () => null);
assert.equal(ghUbuntuSemCurl.possivel, false);

const ghMacBrew = planejarInstalacaoGh("darwin", (c) => (c === "brew" ? "/opt/homebrew/bin/brew" : null));
assert.equal(ghMacBrew.possivel, true);
assert.equal(ghMacBrew.comando, "brew");

const ghMacFallback = planejarInstalacaoGh("darwin", (c) => (c === "curl" || c === "unzip" ? `/usr/bin/${c}` : null));
assert.equal(ghMacFallback.possivel, true);
assert.equal(ghMacFallback.comando, "bash");

// 3. Fluxo completo: progresso, log ao vivo e conclusão
let concluiu = "";
const ger = new GerenciadorInstalacoes({
  aoTerminar: (id, st) => {
    if (st.status === "concluido") concluiu = id;
  },
  obterPlano: (id) => {
    if (id === "ok-cli") {
      return {
        nome: "OK CLI",
        plano: {
          possivel: true,
          comando: process.execPath,
          args: ["-e", 'console.log("Baixando 50%"); setTimeout(() => { console.log("Instalado 100%"); }, 80);'],
          descricao: "simular instalacao ok",
          depois: "Rode ok-cli login.",
        },
      };
    }
    if (id === "lento-cli") {
      return {
        nome: "Lento CLI",
        plano: {
          possivel: true,
          comando: process.execPath,
          args: ["-e", 'console.log("Baixando..."); setTimeout(() => {}, 30000);'],
          descricao: "simular instalacao demorada",
        },
      };
    }
    if (id === "falha-cli") {
      return {
        nome: "Falha CLI",
        plano: {
          possivel: true,
          comando: process.execPath,
          args: ["-e", 'console.error("erro simulado"); process.exit(2);'],
          descricao: "simular falha",
        },
      };
    }
    return null;
  },
  posInstalar: async (id) => `${id} pronto`,
});

const stInicio = ger.iniciar("ok-cli");
assert.equal(stInicio.id, "ok-cli");
assert.ok(stInicio.progresso >= 8);

for (let i = 0; i < 40 && ger.estadoDe("ok-cli")?.status !== "concluido"; i++) await espera(50);
const stOk = ger.estadoDe("ok-cli")!;
assert.equal(stOk.status, "concluido");
assert.equal(stOk.progresso, 100);
assert.equal(concluiu, "ok-cli");
assert.match(stOk.log, /Baixando 50%/);
assert.equal(stOk.mensagem, "ok-cli pronto");

// 4. Cancelamento real (botão X) encerrando processo filho
ger.iniciar("lento-cli");
await espera(120);
assert.equal(ger.ativo(), true);
const t0 = Date.now();
const stCancel = ger.cancelar("lento-cli");
assert.equal(stCancel.status, "cancelado");
for (let i = 0; i < 40 && ger.ativo(); i++) await espera(50);
assert.equal(ger.ativo(), false);
assert.ok(Date.now() - t0 < 4000, "cancelamento deve encerrar o processo rapidamente");
assert.equal(ger.estadoDe("lento-cli")?.status, "cancelado");

// 5. Falha com código diferente de zero + limpeza
ger.iniciar("falha-cli");
for (let i = 0; i < 40 && ger.estadoDe("falha-cli")?.status !== "erro"; i++) await espera(50);
const stErro = ger.estadoDe("falha-cli")!;
assert.equal(stErro.status, "erro");
assert.match(stErro.erro || "", /código 2/);
assert.match(stErro.log, /erro simulado/);

ger.limpar("falha-cli");
assert.equal(ger.estadoDe("falha-cli"), null);

console.log("OK: instalador rápido (planos Windows/Ubuntu/macOS, gh CLI, progresso ao vivo e cancelamento X).");
