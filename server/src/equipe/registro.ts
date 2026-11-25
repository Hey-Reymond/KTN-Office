import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Como o KTN Office liga um CLI ao servidor do escritório. */
export type ConexaoOffice = "claude-mcp" | "gemini-settings" | "antigravity-mcp" | "manual";

/** Descrição de um CLI de IA. Vem de agents/clis.json + agents/clis.custom.json. */
export interface ConfigCli {
  nome: string;
  /** Nome do comando no PATH (ex.: "claude") ou caminho absoluto do executável. */
  executavel: string;
  versao: string[];
  /** Argumentos pra rodar um prompt sem interação. Use {prompt}. */
  prompt: string[];
  /** Argumentos pra escolher o modelo. Use {modelo}. */
  modelo?: string[];
  modeloPadrao?: string;
  /** Catálogo de modelos que o plano libera. A chave é o apelido (ex.: "carbon"). */
  modelos?: Record<string, InfoModelo>;
  /** Argumentos extras pra saída estruturada (ex.: JSON com uso de tokens). */
  saidaJson?: string[];
  leitorSaida?: "texto" | "claude-json";
  pastaConfig?: string;
  instalar?: {
    /** Pacote npm global. */
    npm?: string;
    /** Comando de instalação oficial (PowerShell no Windows, bash no Linux/Mac). */
    windows?: string;
    unix?: string;
    /** Pastas onde o instalador costuma colocar o executável (quando o PATH ainda não foi atualizado). */
    caminhosExtras?: string[];
  };
  login?: string;
  conexaoOffice?: ConexaoOffice;
  especialidades?: string[];
  /** false = ignorado na detecção. */
  ativo?: boolean;
}

export interface InfoModelo {
  /** Nome que o CLI entende em -m/--model. */
  id: string;
  nivel?: string;
  custo?: string;
  velocidade?: string;
  quando?: string;
}

export type Registro = Record<string, ConfigCli>;

/** Converte apelido ("carbon") no id do CLI ("gemini-4-carbon"). Id desconhecido passa direto. */
export function resolverModelo(cfg: ConfigCli, modelo?: string): string | undefined {
  const m = modelo ?? cfg.modeloPadrao;
  if (!m) return undefined;
  return cfg.modelos?.[m]?.id ?? m;
}

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const ARQ_PADRAO = process.env.KTN_CLIS ?? path.join(RAIZ, "agents", "clis.json");
export const ARQ_CUSTOM = process.env.KTN_CLIS_CUSTOM ?? path.join(RAIZ, "agents", "clis.custom.json");

function lerJson(arquivo: string): Record<string, unknown> {
  if (!existsSync(arquivo)) return {};
  return JSON.parse(readFileSync(arquivo, "utf8"));
}

const semComentarios = (obj: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(obj).filter(([k]) => !k.startsWith("_")));

/** Junta os CLIs padrão com os do usuário. O custom sobrescreve campo a campo. */
export function carregarRegistro(): Registro {
  const padrao = semComentarios(lerJson(ARQ_PADRAO)) as Record<string, ConfigCli>;
  const custom = semComentarios(lerJson(ARQ_CUSTOM)) as Record<string, Partial<ConfigCli>>;
  const registro: Registro = {};
  for (const id of new Set([...Object.keys(padrao), ...Object.keys(custom)])) {
    const cfg = { ...padrao[id], ...custom[id] } as ConfigCli;
    if (!cfg.executavel || !cfg.prompt) continue; // entrada incompleta
    registro[id] = { ...cfg, versao: cfg.versao ?? ["--version"], ativo: cfg.ativo ?? true };
  }
  return registro;
}

/** Salva (ou atualiza) um CLI no arquivo do usuário, sem tocar no padrão versionado. */
export function salvarCustom(id: string, cfg: Partial<ConfigCli>) {
  if (!/^[a-z0-9_-]{1,32}$/.test(id)) throw new Error("id inválido: use letras minúsculas, números, - ou _");
  const atual = lerJson(ARQ_CUSTOM);
  atual[id] = { ...(atual[id] as object | undefined), ...cfg };
  writeFileSync(ARQ_CUSTOM, JSON.stringify(atual, null, 2) + "\n");
}

export function expandirHome(p: string) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
