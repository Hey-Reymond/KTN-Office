import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Como o KTN Office liga um CLI ao servidor do escritório. */
export type ConexaoOffice = "claude-mcp" | "codex-mcp" | "gemini-settings" | "antigravity-mcp" | "json-mcp" | "manual";

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
  /** Ajustes do usuário (clis.custom.json): modelos opcionais ligados / modelos desligados. */
  modelosLigados?: string[];
  modelosDesligados?: string[];
  /** Resultado do teste automático: true = respondeu, string = motivo da falha. */
  modelosDetectados?: Record<string, true | string>;
  /** Argumentos fixos extras. */
  argsExtras?: string[];
  /** Argumentos por nível de permissão (leitura, edicao, comandos). */
  niveis?: Partial<Record<"leitura" | "edicao" | "comandos", string[]>>;
  /** Como liberar ferramentas específicas que você "sempre permitiu". Use {ferramentas}. */
  permitirFerramentas?: string[];
  /** Argumentos extras pra saída estruturada (ex.: JSON com uso de tokens). */
  saidaJson?: string[];
  leitorSaida?: "texto" | "claude-json" | "json";
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
  /** Para conexaoOffice "json-mcp": em que arquivo e formato o servidor "office" é gravado. {url} vira o endereço. */
  mcpJson?: { arquivo: string; chave: string; entrada: Record<string, unknown> };
  /** Ainda não testado com uso real (a interface mostra um selo "experimental"). */
  experimental?: boolean;
  /** Aviso mostrado na interface (ex.: CLI que aprova tudo sozinho no modo sem interação). */
  aviso?: string;
  especialidades?: string[];
  /** false = ignorado na detecção. */
  ativo?: boolean;
  /** "api" = IA por chave/servidor local (não é um programa instalado). */
  tipo?: "cli" | "api";
  api?: { provedor?: string; tipo: "openai" | "anthropic"; baseUrl: string };
}

export interface InfoModelo {
  /** Nome que o CLI entende em -m/--model. */
  id: string;
  nivel?: string;
  custo?: string;
  velocidade?: string;
  quando?: string;
  /** true = fica desligado até o usuário ligar (ex.: precisa de plano específico). */
  opcional?: boolean;
  requer?: string;
}

export type Registro = Record<string, ConfigCli>;

export type EstadoModelo =
  | "ligado" // vai ser usado
  | "desligado_usuario" // você desmarcou
  | "indisponivel" // o teste falhou: seu plano/CLI não tem
  | "nao_testado"; // opcional ainda não testado nem ligado

/**
 * Regra: o que o teste encontrou fica ligado por padrão; você desmarca o que não quiser.
 * Sem teste, modelos normais ficam ligados e os opcionais (ex.: fable) desligados.
 */
export function estadoModelo(cfg: ConfigCli, apelido: string): EstadoModelo {
  const info = cfg.modelos?.[apelido];
  if (!info) return "indisponivel";
  if (cfg.modelosDesligados?.includes(apelido)) return "desligado_usuario";
  if (cfg.modelosLigados?.includes(apelido)) return "ligado";
  const teste = cfg.modelosDetectados?.[apelido];
  if (teste === true) return "ligado";
  if (typeof teste === "string") return "indisponivel";
  return info.opcional ? "nao_testado" : "ligado";
}

export const modeloDisponivel = (cfg: ConfigCli, apelido: string) => estadoModelo(cfg, apelido) === "ligado";

/** Guarda o resultado do teste automático de um modelo. */
export function salvarDeteccaoModelo(id: string, apelido: string, resultado: true | string) {
  const cfg = carregarRegistro()[id];
  salvarCustom(id, { modelosDetectados: { ...cfg?.modelosDetectados, [apelido]: resultado } });
}

export function modelosDisponiveis(cfg: ConfigCli): Record<string, InfoModelo> {
  return Object.fromEntries(Object.entries(cfg.modelos ?? {}).filter(([k]) => modeloDisponivel(cfg, k)));
}

/** Marca/desmarca a caixinha de um modelo (grava em clis.custom.json). */
export function definirModelo(id: string, apelido: string, ligado: boolean) {
  const cfg = carregarRegistro()[id];
  if (!cfg) throw new Error(`CLI "${id}" não está no registro.`);
  if (!cfg.modelos?.[apelido]) {
    throw new Error(`Modelo "${apelido}" não existe em ${id}. Opções: ${Object.keys(cfg.modelos ?? {}).join(", ")}`);
  }
  const tira = (l: string[] | undefined) => (l ?? []).filter((m) => m !== apelido);
  salvarCustom(id, {
    modelosLigados: ligado ? [...tira(cfg.modelosLigados), apelido] : tira(cfg.modelosLigados),
    modelosDesligados: ligado ? tira(cfg.modelosDesligados) : [...tira(cfg.modelosDesligados), apelido],
  });
}

/** Converte apelido ("carbon") no id do CLI ("gemini-4-carbon"). Id desconhecido passa direto. */
export function resolverModelo(cfg: ConfigCli, modelo?: string): string | undefined {
  // Sem modelo pedido: usa o padrão do catálogo só se ele estiver liberado no seu plano;
  // senão não passa -m e o próprio CLI escolhe o modelo da sua conta.
  const padrao = cfg.modeloPadrao && (!cfg.modelos?.[cfg.modeloPadrao] || modeloDisponivel(cfg, cfg.modeloPadrao)) ? cfg.modeloPadrao : undefined;
  const m = modelo ?? padrao;
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
    if (cfg.tipo === "api" ? !cfg.api?.baseUrl : !cfg.executavel || !cfg.prompt) continue; // entrada incompleta
    registro[id] = { ...cfg, versao: cfg.versao ?? ["--version"], prompt: cfg.prompt ?? [], executavel: cfg.executavel ?? "", ativo: cfg.ativo ?? true };
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
