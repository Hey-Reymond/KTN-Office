import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { rodar } from "./processo.js";
import { carregarRegistro, expandirHome, type ConfigCli } from "./registro.js";

export const URL_OFFICE = (agente: string) =>
  `http://127.0.0.1:${process.env.KTN_PORT ?? 7777}/mcp?agent=${agente}`;

export interface Deteccao {
  id: string;
  nome: string;
  instalado: boolean;
  caminho: string | null;
  versao: string | null;
  /** "provavel" = pasta de config existe (não lemos credenciais). */
  login: "provavel" | "nao" | "desconhecido";
  office: "conectado" | "nao" | "manual" | "desconhecido";
  podeInstalar: boolean;
  dicaLogin?: string;
  problemas: string[];
}

const ehWindows = process.platform === "win32";

function executavel(arquivo: string) {
  try {
    if (!statSync(arquivo).isFile()) return false;
    if (!ehWindows) accessSync(arquivo, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Procura o comando no PATH (no Windows testa .exe, .cmd, .bat… como o próprio sistema faz). */
export function acharNoPath(comando: string, pastasExtras: string[] = []): string | null {
  if (path.isAbsolute(comando) || comando.includes("/") || comando.includes("\\")) {
    return executavel(comando) ? comando : null;
  }
  const extensoes = ehWindows
    ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())]
    : [""];
  const pastas = [...(process.env.PATH ?? "").split(path.delimiter), ...pastasExtras.map(expandirHome)];
  for (const pasta of pastas.filter(Boolean)) {
    for (const ext of extensoes) {
      const candidato = path.join(pasta, comando + ext);
      if (executavel(candidato)) return candidato;
    }
  }
  return null;
}

/** Acha o executável de um CLI: PATH + pastas onde o instalador costuma colocar. */
export const localizar = (cfg: ConfigCli) => acharNoPath(cfg.executavel, cfg.instalar?.caminhosExtras);

/** Arquivo global de MCP do Antigravity (compartilhado entre CLI, IDE e Antigravity 2.0). */
export const ARQ_MCP_ANTIGRAVITY = () => path.join(os.homedir(), ".gemini", "config", "mcp_config.json");

/** Lê JSON aceitando arquivo vazio e o BOM que editores do Windows colocam no início. */
export function lerJsonTolerante(arq: string): Record<string, any> {
  const texto = readFileSync(arq, "utf8").replace(/^\uFEFF/, "").trim();
  return texto ? JSON.parse(texto) : {};
}

function urlNoArquivo(arq: string, campo: "httpUrl" | "serverUrl"): string | null {
  if (!existsSync(arq)) return null;
  const bruto = lerJsonTolerante(arq);
  const url = bruto?.mcpServers?.office?.[campo];
  return typeof url === "string" ? url : null;
}

async function conexaoOffice(id: string, cfg: ConfigCli, caminho: string): Promise<Deteccao["office"]> {
  switch (cfg.conexaoOffice) {
    case "claude-mcp": {
      const r = await rodar(caminho, ["mcp", "get", "office"], { timeoutMs: 20_000 });
      if (r.estourouTempo) return "desconhecido";
      return r.codigo === 0 && r.stdout.includes(`agent=${id}`) ? "conectado" : "nao";
    }
    case "codex-mcp": {
      const r = await rodar(caminho, ["mcp", "get", "office", "--json"], { timeoutMs: 20_000 });
      if (r.estourouTempo) return "desconhecido";
      return r.codigo === 0 && r.stdout.includes(`agent=${id}`) ? "conectado" : "nao";
    }
    case "gemini-settings":
    case "antigravity-mcp": {
      const [arq, campo] =
        cfg.conexaoOffice === "gemini-settings"
          ? [path.join(os.homedir(), ".gemini", "settings.json"), "httpUrl" as const]
          : [ARQ_MCP_ANTIGRAVITY(), "serverUrl" as const];
      try {
        return urlNoArquivo(arq, campo)?.includes(`agent=${id}`) ? "conectado" : "nao";
      } catch {
        return "desconhecido";
      }
    }
    default:
      return "manual";
  }
}

export async function detectarUm(id: string, cfg: ConfigCli): Promise<Deteccao> {
  const d: Deteccao = {
    id,
    nome: cfg.nome,
    instalado: false,
    caminho: null,
    versao: null,
    login: "desconhecido",
    office: "desconhecido",
    podeInstalar: !!(cfg.instalar?.npm || cfg.instalar?.windows || cfg.instalar?.unix),
    dicaLogin: cfg.login,
    problemas: [],
  };

  d.caminho = localizar(cfg);
  if (!d.caminho) {
    if (path.isAbsolute(cfg.executavel)) d.problemas.push(`Executável não encontrado em ${cfg.executavel}`);
    return d;
  }
  d.instalado = true;

  const v = await rodar(d.caminho, cfg.versao, { timeoutMs: 15_000 });
  if (v.codigo === 0) d.versao = (v.stdout || v.stderr).trim().split("\n")[0].slice(0, 80);
  else d.problemas.push(v.estourouTempo ? "Demorou demais pra responder a versão" : "Não respondeu a versão");

  if (cfg.pastaConfig) d.login = existsSync(expandirHome(cfg.pastaConfig)) ? "provavel" : "nao";

  d.office = await conexaoOffice(id, cfg, d.caminho);
  return d;
}

/** Detecta todos os CLIs ativos do registro, em paralelo. */
export async function detectarEquipe(): Promise<Deteccao[]> {
  const registro = carregarRegistro();
  return Promise.all(
    Object.entries(registro)
      .filter(([, cfg]) => cfg.ativo !== false)
      .map(([id, cfg]) => detectarUm(id, cfg)),
  );
}

/**
 * Quem está na equipe agora: CLIs ativos, instalados e que você não tirou da equipe na interface.
 * É por esse número que a coordenadora divide o projeto (contando ela mesma).
 */
export function equipeAtiva(foraDaEquipe: string[] = []): string[] {
  return Object.entries(carregarRegistro())
    .filter(([id, cfg]) => cfg.ativo !== false && !foraDaEquipe.includes(id) && !!localizar(cfg))
    .map(([id]) => id);
}
