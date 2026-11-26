import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acharNoPath, ARQ_MCP_ANTIGRAVITY, lerJsonTolerante, URL_OFFICE } from "./detectar.js";
import { rodar } from "./processo.js";
import { expandirHome, type ConfigCli } from "./registro.js";

export interface PlanoInstalacao {
  possivel: boolean;
  comando?: string;
  args?: string[];
  /** Texto exato mostrado ao usuário antes de confirmar. */
  descricao: string;
  depois?: string;
}

export class InstalacaoCancelada extends Error {
  constructor() {
    super("Instalação cancelada.");
    this.name = "InstalacaoCancelada";
  }
}

/** Script de fallback para instalar o GitHub CLI (gh) sem precisar de admin/sudo. */
const SCRIPT_GH_LINUX = [
  'set -e',
  'ARCH=$(uname -m); case "$ARCH" in x86_64|amd64) ARCH=amd64;; aarch64|arm64) ARCH=arm64;; *) echo "Arquitetura não suportada: $ARCH" >&2; exit 1;; esac',
  'VER=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n \'s/.*"tag_name": *"v\\([^"]*\\)".*/\\1/p\' | head -n1)',
  '[ -n "$VER" ] || { echo "Não consegui descobrir a última versão do gh." >&2; exit 1; }',
  'TMP=$(mktemp -d); trap \'rm -rf "$TMP"\' EXIT',
  'echo "Baixando GitHub CLI v$VER (linux/$ARCH)..."',
  'curl -fL "https://github.com/cli/cli/releases/download/v${VER}/gh_${VER}_linux_${ARCH}.tar.gz" -o "$TMP/gh.tgz"',
  'tar -xzf "$TMP/gh.tgz" -C "$TMP"',
  'mkdir -p "$HOME/.local/bin"',
  'cp "$TMP/gh_${VER}_linux_${ARCH}/bin/gh" "$HOME/.local/bin/gh"',
  'chmod +x "$HOME/.local/bin/gh"',
  'echo "GitHub CLI v$VER instalado em $HOME/.local/bin/gh"',
].join("; ");

const SCRIPT_GH_MACOS = [
  'set -e',
  'ARCH=$(uname -m); case "$ARCH" in x86_64) ARCH=amd64;; arm64) ARCH=arm64;; *) echo "Arquitetura não suportada: $ARCH" >&2; exit 1;; esac',
  'VER=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | sed -n \'s/.*"tag_name": *"v\\([^"]*\\)".*/\\1/p\' | head -n1)',
  '[ -n "$VER" ] || { echo "Não consegui descobrir a última versão do gh." >&2; exit 1; }',
  'TMP=$(mktemp -d); trap \'rm -rf "$TMP"\' EXIT',
  'echo "Baixando GitHub CLI v$VER (macOS/$ARCH)..."',
  'curl -fL "https://github.com/cli/cli/releases/download/v${VER}/gh_${VER}_macOS_${ARCH}.zip" -o "$TMP/gh.zip"',
  'unzip -q "$TMP/gh.zip" -d "$TMP"',
  'mkdir -p "$HOME/.local/bin"',
  'cp "$TMP/gh_${VER}_macOS_${ARCH}/bin/gh" "$HOME/.local/bin/gh"',
  'chmod +x "$HOME/.local/bin/gh"',
  'echo "GitHub CLI v$VER instalado em $HOME/.local/bin/gh"',
].join("; ");

const SCRIPT_GH_WINDOWS = [
  '$ErrorActionPreference = "Stop"',
  '$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "amd64" }',
  '$rel = Invoke-RestMethod "https://api.github.com/repos/cli/cli/releases/latest"',
  '$ver = $rel.tag_name.TrimStart("v")',
  '$url = "https://github.com/cli/cli/releases/download/v$ver/gh_${ver}_windows_${arch}.zip"',
  '$tmp = Join-Path $env:TEMP ("ktn-gh-" + [guid]::NewGuid().ToString("N"))',
  'New-Item -ItemType Directory -Force -Path $tmp | Out-Null',
  'Write-Output "Baixando GitHub CLI v$ver (windows/$arch)..."',
  'Invoke-WebRequest -Uri $url -OutFile "$tmp\\gh.zip"',
  'Expand-Archive -Path "$tmp\\gh.zip" -DestinationPath $tmp -Force',
  '$dest = Join-Path $env:LOCALAPPDATA "ktn-office\\bin"',
  'New-Item -ItemType Directory -Force -Path $dest | Out-Null',
  'Copy-Item "$tmp\\bin\\gh.exe" "$dest\\gh.exe" -Force',
  'Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue',
  '$userPath = [Environment]::GetEnvironmentVariable("Path", "User")',
  'if ($userPath -notlike "*$dest*") { [Environment]::SetEnvironmentVariable("Path", "$userPath;$dest", "User") }',
  'Write-Output "GitHub CLI v$ver instalado em $dest\\gh.exe"',
].join("; ");

/** Monta o plano de instalação do GitHub CLI (gh) para Windows, Ubuntu/Linux e macOS. */
export function planejarInstalacaoGh(
  plataforma: NodeJS.Platform = process.platform,
  temComando: (cmd: string) => string | null = (c) => acharNoPath(c),
): PlanoInstalacao {
  const depois = 'Depois clique em "Entrar no GitHub" (ou rode gh auth login) para conectar sua conta.';
  if (plataforma === "win32") {
    if (temComando("winget")) {
      return {
        possivel: true,
        comando: "winget",
        args: ["install", "--id", "GitHub.cli", "-e", "--accept-source-agreements", "--accept-package-agreements", "--silent"],
        descricao: "winget install --id GitHub.cli -e",
        depois,
      };
    }
    return {
      possivel: true,
      comando: "powershell",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT_GH_WINDOWS],
      descricao: "Baixar binário oficial do GitHub CLI (gh) em %LOCALAPPDATA%\\ktn-office\\bin",
      depois,
    };
  }
  if (plataforma === "darwin") {
    if (temComando("brew")) {
      return {
        possivel: true,
        comando: "brew",
        args: ["install", "gh"],
        descricao: "brew install gh",
        depois,
      };
    }
    if (!temComando("curl") || !temComando("unzip")) {
      return {
        possivel: false,
        descricao: "Precisa do Homebrew (brew) ou de curl + unzip para instalar o gh no macOS.",
      };
    }
    return {
      possivel: true,
      comando: "bash",
      args: ["-c", SCRIPT_GH_MACOS],
      descricao: "Baixar binário oficial do GitHub CLI (gh) em ~/.local/bin/gh",
      depois,
    };
  }
  if (!temComando("curl") || !temComando("tar")) {
    return {
      possivel: false,
      descricao: "Precisa de curl e tar para instalar o gh no Linux (Ubuntu).",
    };
  }
  return {
    possivel: true,
    comando: "bash",
    args: ["-c", SCRIPT_GH_LINUX],
    descricao: "Baixar binário oficial do GitHub CLI (gh) em ~/.local/bin/gh (sem precisar de sudo)",
    depois,
  };
}

/** Monta o plano. Não executa nada: quem chama mostra ao usuário e pede confirmação. */
export function planejarInstalacao(
  cfg: ConfigCli,
  plataforma: NodeJS.Platform = process.platform,
  temComando: (cmd: string) => string | null = (c) => acharNoPath(c),
): PlanoInstalacao {
  const inst = cfg.instalar ?? {};
  const ehWin = plataforma === "win32";
  const script = ehWin
    ? inst.windows
    : plataforma === "darwin"
      ? (inst.macos ?? inst.unix)
      : (inst.linux ?? inst.unix);

  // Instalador oficial do fabricante tem prioridade sobre npm.
  if (script) {
    return {
      possivel: true,
      comando: ehWin ? "powershell" : "bash",
      args: ehWin ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script] : ["-c", script],
      descricao: script,
      depois: `${cfg.login ?? ""} Se o comando não for encontrado, abra um terminal novo (o PATH muda só em janelas novas).`.trim(),
    };
  }
  if (!inst.npm) return { possivel: false, descricao: `${cfg.nome} não tem instalação automática. Adicione manualmente.` };
  if (!temComando("npm")) {
    return {
      possivel: false,
      descricao: "Precisa do Node.js (com npm) pra instalar. Baixe em https://nodejs.org e rode a detecção de novo.",
    };
  }
  return {
    possivel: true,
    comando: "npm",
    args: ["install", "-g", inst.npm],
    descricao: `npm install -g ${inst.npm}`,
    depois: cfg.login,
  };
}

export async function executarInstalacao(
  plano: PlanoInstalacao,
  aoReceber?: (t: string) => void,
  signal?: AbortSignal,
) {
  if (!plano.possivel || !plano.comando) throw new Error(plano.descricao);
  const r = await rodar(plano.comando, plano.args ?? [], { timeoutMs: 10 * 60_000, aoReceber, signal });
  if (r.cancelado || signal?.aborted) throw new InstalacaoCancelada();
  if (r.estourouTempo) throw new Error("A instalação demorou mais de 10 minutos e foi interrompida.");
  if (r.codigo !== 0) throw new Error(`Instalação falhou (código ${r.codigo}). Veja o log acima.`);
}

/** Coloca o servidor "office" num arquivo JSON de MCP, preservando o resto e fazendo backup. */
function gravarOfficeNoJson(arq: string, entrada: Record<string, unknown>, chave = "mcpServers") {
  mkdirSync(path.dirname(arq), { recursive: true });
  let dados: Record<string, any> = {};
  if (existsSync(arq)) {
    const bruto = readFileSync(arq, "utf8");
    try {
      dados = lerJsonTolerante(arq);
    } catch {
      throw new Error(`${arq} não é um JSON válido. Corrija o arquivo antes de conectar.`);
    }
    writeFileSync(arq + ".bak", bruto); // backup antes de mexer
  }
  dados[chave] = { ...dados[chave], office: entrada };
  writeFileSync(arq, JSON.stringify(dados, null, 2) + "\n");
}

/** Adiciona uma regra em permissions.allow de um settings.json (sem duplicar, com backup). */
export function liberarNoSettings(arq: string, regra: string): boolean {
  mkdirSync(path.dirname(arq), { recursive: true });
  let dados: Record<string, any> = {};
  if (existsSync(arq)) {
    const bruto = readFileSync(arq, "utf8");
    try {
      dados = lerJsonTolerante(arq);
    } catch {
      throw new Error(`${arq} não é um JSON válido. Corrija o arquivo antes de liberar as ferramentas.`);
    }
    writeFileSync(arq + ".bak", bruto);
  }
  const permissoes = (dados.permissions ??= {});
  const allow: string[] = Array.isArray(permissoes.allow) ? permissoes.allow : [];
  if (allow.includes(regra)) return false;
  permissoes.allow = [...allow, regra];
  writeFileSync(arq, JSON.stringify(dados, null, 2) + "\n");
  return true;
}

/**
 * Libera todas as ferramentas do "office" no CLI, pra ele não pedir confirmação a cada chamada.
 * Só afeta o servidor local do escritório; o resto das permissões continua como estava.
 */
export function liberarFerramentasOffice(cfg: ConfigCli): string | null {
  switch (cfg.conexaoOffice) {
    case "claude-mcp": {
      const arq = path.join(os.homedir(), ".claude", "settings.json");
      liberarNoSettings(arq, "mcp__office");
      return `Ferramentas do office liberadas no Claude (${arq})`;
    }
    case "antigravity-mcp": {
      const arq = path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json");
      liberarNoSettings(arq, "mcp(office/*)");
      return `Ferramentas do office liberadas no Antigravity (${arq})`;
    }
    default:
      return null;
  }
}

/** Liga o CLI ao servidor do escritório. */
export async function conectarAoOffice(id: string, cfg: ConfigCli, caminho: string): Promise<string> {
  const url = URL_OFFICE(id);
  switch (cfg.conexaoOffice) {
    case "claude-mcp": {
      await rodar(caminho, ["mcp", "remove", "office", "--scope", "user"], { timeoutMs: 20_000 }); // se existir
      const r = await rodar(caminho, ["mcp", "add", "--scope", "user", "--transport", "http", "office", url], {
        timeoutMs: 20_000,
      });
      if (r.codigo !== 0) throw new Error(`Falhou ao conectar: ${r.stderr || r.stdout}`);
      return `Conectado (claude mcp add office ${url})`;
    }
    case "codex-mcp": {
      await rodar(caminho, ["mcp", "remove", "office"], { timeoutMs: 20_000 }); // se existir
      const r = await rodar(caminho, ["mcp", "add", "office", "--url", url], { timeoutMs: 20_000 });
      if (r.codigo !== 0) throw new Error(`Falhou ao conectar: ${r.stderr || r.stdout}`);
      return `Conectado (codex mcp add office --url ${url})`;
    }
    case "gemini-settings": {
      const arq = path.join(os.homedir(), ".gemini", "settings.json");
      gravarOfficeNoJson(arq, { httpUrl: url });
      return `Conectado (${arq})`;
    }
    case "antigravity-mcp": {
      const arq = ARQ_MCP_ANTIGRAVITY();
      gravarOfficeNoJson(arq, { serverUrl: url });
      return `Conectado (${arq}). Reinicie o agy pra ele carregar o servidor.`;
    }
    case "json-mcp": {
      if (!cfg.mcpJson) break;
      const arq = expandirHome(cfg.mcpJson.arquivo);
      gravarOfficeNoJson(arq, trocarUrl(cfg.mcpJson.entrada, url), cfg.mcpJson.chave);
      return `Conectado (${arq}).`;
    }
  }
  return `Conexão manual: configure um servidor MCP HTTP chamado "office" com a URL ${url}`;
}

/** Troca "{url}" pelo endereço do escritório em qualquer campo da entrada. */
export function trocarUrl(v: unknown, url: string): any {
  if (typeof v === "string") return v.replace("{url}", url);
  if (Array.isArray(v)) return v.map((x) => trocarUrl(x, url));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trocarUrl(x, url)]));
  return v;
}

