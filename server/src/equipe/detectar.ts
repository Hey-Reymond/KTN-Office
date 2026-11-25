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
export function acharNoPath(comando: string): string | null {
  if (path.isAbsolute(comando) || comando.includes("/") || comando.includes("\\")) {
    return executavel(comando) ? comando : null;
  }
  const extensoes = ehWindows
    ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())]
    : [""];
  for (const pasta of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const ext of extensoes) {
      const candidato = path.join(pasta, comando + ext);
      if (executavel(candidato)) return candidato;
    }
  }
  return null;
}

async function conexaoOffice(id: string, cfg: ConfigCli, caminho: string): Promise<Deteccao["office"]> {
  switch (cfg.conexaoOffice) {
    case "claude-mcp": {
      const r = await rodar(caminho, ["mcp", "get", "office"], { timeoutMs: 20_000 });
      if (r.estourouTempo) return "desconhecido";
      return r.codigo === 0 && r.stdout.includes(`agent=${id}`) ? "conectado" : "nao";
    }
    case "gemini-settings": {
      const arq = path.join(os.homedir(), ".gemini", "settings.json");
      if (!existsSync(arq)) return "nao";
      try {
        const url = JSON.parse(readFileSync(arq, "utf8"))?.mcpServers?.office?.httpUrl;
        return typeof url === "string" && url.includes(`agent=${id}`) ? "conectado" : "nao";
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
    podeInstalar: !!cfg.instalar?.npm,
    dicaLogin: cfg.login,
    problemas: [],
  };

  d.caminho = acharNoPath(cfg.executavel);
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
