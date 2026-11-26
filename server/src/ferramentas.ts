import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Escritorio } from "./db.js";
import { ARQ_MCP_ANTIGRAVITY, lerJsonTolerante, localizar } from "./equipe/detectar.js";
import { liberarNoSettings } from "./equipe/instalar.js";
import { rodar } from "./equipe/processo.js";
import { carregarRegistro, type ConfigCli } from "./equipe/registro.js";

/**
 * Ferramentas extras: servidores MCP (navegador etc.) que o escritório liga em TODAS as IAs de uma vez,
 * com o navegador que você escolher.
 */
export interface Ferramenta {
  nome: string;
  descricao: string;
  comando: string;
  args: string[];
  navegadores: Record<string, string[]>;
  preparar?: Record<string, { comando: string; args: string[]; descricao: string }>;
  padrao: string;
}

export interface EstadoFerramenta {
  ligada: boolean;
  navegador: string;
  /** Liberar as ações dessa ferramenta sem aviso de permissão. */
  semPerguntar: boolean;
}

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARQ = process.env.KTN_FERRAMENTAS ?? path.join(RAIZ, "agents", "ferramentas.json");

export function catalogoFerramentas(): Record<string, Ferramenta> {
  const bruto = JSON.parse(readFileSync(ARQ, "utf8")) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(bruto).filter(([k]) => !k.startsWith("_"))) as Record<string, Ferramenta>;
}

/** Onde cada navegador costuma ficar instalado. */
function candidatos(): Record<string, string[]> {
  const pf = process.env.ProgramFiles ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  if (process.platform === "win32") {
    return {
      brave: [path.join(pf, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), path.join(local, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")],
      firefox: [path.join(pf, "Mozilla Firefox", "firefox.exe"), path.join(pf86, "Mozilla Firefox", "firefox.exe")],
      chrome: [path.join(pf, "Google", "Chrome", "Application", "chrome.exe"), path.join(local, "Google", "Chrome", "Application", "chrome.exe")],
      edge: [path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe")],
    };
  }
  if (process.platform === "darwin") {
    return {
      brave: ["/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"],
      firefox: ["/Applications/Firefox.app/Contents/MacOS/firefox"],
      chrome: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
      edge: ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"],
    };
  }
  return {
    brave: ["/usr/bin/brave-browser", "/usr/bin/brave", "/snap/bin/brave"],
    firefox: ["/usr/bin/firefox", "/snap/bin/firefox"],
    chrome: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"],
    edge: ["/usr/bin/microsoft-edge"],
  };
}

/** Navegadores instalados neste PC (nome → caminho). */
export function navegadoresInstalados(): Record<string, string> {
  const extra = process.env.KTN_NAVEGADORES ? (JSON.parse(process.env.KTN_NAVEGADORES) as Record<string, string>) : {};
  const achados: Record<string, string> = {};
  for (const [nome, lista] of Object.entries(candidatos())) {
    const p = lista.find((c) => existsSync(c));
    if (p) achados[nome] = p;
  }
  return { ...achados, ...extra };
}

export function estadoFerramentas(esc: Escritorio): Record<string, EstadoFerramenta> {
  const salvo = esc.lerConfig<Record<string, Partial<EstadoFerramenta>>>("ferramentas", {});
  return Object.fromEntries(
    Object.entries(catalogoFerramentas()).map(([id, f]) => [
      id,
      { ligada: false, navegador: f.padrao, semPerguntar: false, ...salvo[id] },
    ]),
  );
}

/** Argumentos finais do servidor MCP para o navegador escolhido. */
export function argsFerramenta(f: Ferramenta, navegador: string, instalados = navegadoresInstalados()): string[] {
  const extra = f.navegadores[navegador];
  if (!extra) throw new Error(`${f.nome} não funciona com ${navegador}. Opções: ${Object.keys(f.navegadores).join(", ")}`);
  if (extra.some((a) => a.includes("{caminho}")) && !instalados[navegador]) {
    throw new Error(`Não achei o ${navegador} instalado neste PC.`);
  }
  return [...f.args, ...extra.map((a) => a.replace("{caminho}", instalados[navegador] ?? ""))];
}

/** Prefixo das ferramentas no Claude / regra no Antigravity, para o "usar sem perguntar". */
const regraClaude = (id: string) => `mcp__${id}`;
const regraAgy = (id: string) => `mcp(${id}/*)`;

function editarJsonMcp(arq: string, id: string, entrada: Record<string, unknown> | null) {
  mkdirSync(path.dirname(arq), { recursive: true });
  const dados = existsSync(arq) ? lerJsonTolerante(arq) : {};
  if (existsSync(arq)) writeFileSync(arq + ".bak", readFileSync(arq));
  const servidores = { ...(dados.mcpServers ?? {}) };
  if (entrada) servidores[id] = entrada;
  else delete servidores[id];
  dados.mcpServers = servidores;
  writeFileSync(arq, JSON.stringify(dados, null, 2) + "\n");
}

/** Liga (ou desliga, se args = null) a ferramenta em uma IA. */
async function aplicarEmUma(cliId: string, cfg: ConfigCli, ferramentaId: string, comando: string, args: string[] | null): Promise<string> {
  const caminho = localizar(cfg);
  if (!caminho) return `${cfg.nome}: não instalado, pulei.`;
  switch (cfg.conexaoOffice) {
    case "claude-mcp": {
      await rodar(caminho, ["mcp", "remove", ferramentaId, "--scope", "user"], { timeoutMs: 20_000 });
      if (!args) return `${cfg.nome}: removido.`;
      const r = await rodar(caminho, ["mcp", "add", "--scope", "user", ferramentaId, "--", comando, ...args], { timeoutMs: 20_000 });
      if (r.codigo !== 0) throw new Error(`${cfg.nome}: ${r.stderr || r.stdout}`);
      return `${cfg.nome}: ligado.`;
    }
    case "codex-mcp": {
      await rodar(caminho, ["mcp", "remove", ferramentaId], { timeoutMs: 20_000 });
      if (!args) return `${cfg.nome}: removido.`;
      const r = await rodar(caminho, ["mcp", "add", ferramentaId, "--", comando, ...args], { timeoutMs: 20_000 });
      if (r.codigo !== 0) throw new Error(`${cfg.nome}: ${r.stderr || r.stdout}`);
      return `${cfg.nome}: ligado.`;
    }
    case "antigravity-mcp":
      editarJsonMcp(ARQ_MCP_ANTIGRAVITY(), ferramentaId, args ? { command: comando, args } : null);
      return `${cfg.nome}: ${args ? "ligado" : "removido"}.`;
    case "gemini-settings":
      editarJsonMcp(path.join(os.homedir(), ".gemini", "settings.json"), ferramentaId, args ? { command: comando, args } : null);
      return `${cfg.nome}: ${args ? "ligado" : "removido"}.`;
    default:
      return `${cfg.nome}: conexão manual (adicione o servidor MCP "${ferramentaId}": ${comando} ${(args ?? []).join(" ")}).`;
  }
}

/**
 * Aplica a configuração da ferramenta em todas as IAs instaladas: liga/desliga o servidor MCP,
 * troca o navegador e ajusta o "usar sem perguntar".
 */
export async function aplicarFerramenta(esc: Escritorio, id: string, mudanca: Partial<EstadoFerramenta>): Promise<string[]> {
  const f = catalogoFerramentas()[id];
  if (!f) throw new Error(`Ferramenta "${id}" não existe.`);
  const atual = { ...estadoFerramentas(esc)[id], ...mudanca };
  const args = atual.ligada ? argsFerramenta(f, atual.navegador) : null; // valida antes de mexer em qualquer IA
  const msgs: string[] = [];
  for (const [cliId, cfg] of Object.entries(carregarRegistro())) {
    if (cfg.ativo === false || !localizar(cfg)) continue;
    msgs.push(await aplicarEmUma(cliId, cfg, id, f.comando, args).catch((e) => `⚠️ ${e instanceof Error ? e.message : e}`));
  }
  // Usar sem perguntar: IAs tipo Claude ganham a ferramenta na lista "sempre"; Antigravity ganha a regra de permissão.
  const liberar = atual.ligada && atual.semPerguntar;
  for (const [cliId, cfg] of Object.entries(carregarRegistro())) {
    if (cfg.conexaoOffice === "claude-mcp") {
      const outras = esc.sempreDe(cliId).filter((t) => t !== regraClaude(id));
      esc.definirSempre(cliId, liberar ? [...outras, regraClaude(id)] : outras);
    } else if (cfg.conexaoOffice === "antigravity-mcp" && liberar && localizar(cfg)) {
      liberarNoSettings(path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json"), regraAgy(id));
    }
  }
  esc.gravarConfig("ferramentas", { ...esc.lerConfig<Record<string, unknown>>("ferramentas", {}), [id]: atual });
  esc.registrarEvento(null, "config", `${f.nome}: ${atual.ligada ? `ligado com ${atual.navegador}` : "desligado"}${liberar ? ", sem perguntar" : ""}.`);
  return msgs;
}

/** Passo extra de alguns navegadores (ex.: Firefox do Playwright). */
export async function prepararNavegador(id: string, navegador: string) {
  const passo = catalogoFerramentas()[id]?.preparar?.[navegador];
  if (!passo) return "Nada a preparar.";
  const r = await rodar(passo.comando, passo.args, { timeoutMs: 10 * 60_000 });
  if (r.codigo !== 0) throw new Error(`Falhou ao preparar ${navegador}: ${(r.stderr || r.stdout).slice(0, 300)}`);
  return `${navegador} pronto para o ${catalogoFerramentas()[id].nome}.`;
}
