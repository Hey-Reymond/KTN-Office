/**
 * IAs por API (chave própria ou modelo local): OpenAI-compatível (Ollama, LM Studio, OpenRouter, OpenAI,
 * Gemini, DeepSeek, Groq, Mistral…) e Anthropic. Elas usam as mesmas ferramentas do escritório (MCP)
 * e ganham ferramentas de arquivo limitadas à pasta do trabalho.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { pastaDados } from "../memoria.js";
import { URL_OFFICE } from "./detectar.js";
import { CliAgent, type Funcionario, type OpcoesTrabalho, type ResultadoTrabalho } from "./funcionario.js";
import { resolverModelo, type ConfigCli } from "./registro.js";

export type TipoProvedor = "openai" | "anthropic";

export interface Provedor {
  nome: string;
  tipo: TipoProvedor;
  baseUrl: string;
  precisaChave: boolean;
  /** Onde pegar a chave / instalar. */
  dica: string;
  local?: boolean;
}

export const PROVEDORES: Record<string, Provedor> = {
  ollama: { nome: "Ollama (local)", tipo: "openai", baseUrl: "http://127.0.0.1:11434/v1", precisaChave: false, local: true, dica: "Instale em ollama.com e baixe um modelo: ollama pull qwen3" },
  lmstudio: { nome: "LM Studio (local)", tipo: "openai", baseUrl: "http://127.0.0.1:1234/v1", precisaChave: false, local: true, dica: "Abra o LM Studio e ligue o servidor local (Developer → Start server)." },
  openrouter: { nome: "OpenRouter", tipo: "openai", baseUrl: "https://openrouter.ai/api/v1", precisaChave: true, dica: "Chave em openrouter.ai/keys. Tem modelos grátis (terminam em :free)." },
  openai: { nome: "OpenAI", tipo: "openai", baseUrl: "https://api.openai.com/v1", precisaChave: true, dica: "Chave em platform.openai.com/api-keys (cobrado por uso, separado do ChatGPT Plus)." },
  gemini: { nome: "Gemini API", tipo: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", precisaChave: true, dica: "Chave em aistudio.google.com/apikey (tem cota grátis)." },
  anthropic: { nome: "Anthropic API", tipo: "anthropic", baseUrl: "https://api.anthropic.com", precisaChave: true, dica: "Chave em console.anthropic.com (cobrado por uso, separado do plano do Claude)." },
  deepseek: { nome: "DeepSeek", tipo: "openai", baseUrl: "https://api.deepseek.com/v1", precisaChave: true, dica: "Chave em platform.deepseek.com." },
  groq: { nome: "Groq", tipo: "openai", baseUrl: "https://api.groq.com/openai/v1", precisaChave: true, dica: "Chave em console.groq.com (tem cota grátis)." },
  mistral: { nome: "Mistral", tipo: "openai", baseUrl: "https://api.mistral.ai/v1", precisaChave: true, dica: "Chave em console.mistral.ai." },
  outro: { nome: "Outro (compatível com OpenAI)", tipo: "openai", baseUrl: "", precisaChave: false, dica: "Qualquer servidor com /v1/chat/completions." },
};

// ---------- Chaves: ficam só no seu PC, fora da pasta do projeto ----------

const arquivoChaves = () => path.join(pastaDados(), "chaves-api.json");

function lerChaves(): Record<string, string> {
  try { return JSON.parse(readFileSync(arquivoChaves(), "utf8")); } catch { return {}; }
}
export function chaveDe(id: string): string | undefined {
  return lerChaves()[id] || undefined;
}
export function salvarChave(id: string, chave: string | null) {
  const c = lerChaves();
  if (chave) c[id] = chave; else delete c[id];
  mkdirSync(pastaDados(), { recursive: true });
  writeFileSync(arquivoChaves(), JSON.stringify(c, null, 2), { mode: 0o600 });
}

// ---------- HTTP ----------

const semBarra = (u: string) => u.replace(/\/+$/, "");

async function pedir(url: string, corpo: unknown, headers: Record<string, string>, sinal?: AbortSignal) {
  const r = await fetch(url, { method: corpo === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", ...headers }, body: corpo === undefined ? undefined : JSON.stringify(corpo), signal: sinal });
  const texto = await r.text();
  let json: any = null;
  try { json = JSON.parse(texto); } catch { /* não é JSON */ }
  if (!r.ok) {
    const msg = json?.error?.message ?? json?.error ?? json?.message ?? texto.slice(0, 300);
    throw new Error(`${r.status} ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  return json;
}

function cabecalhos(tipo: TipoProvedor, chave?: string): Record<string, string> {
  if (tipo === "anthropic") return { "x-api-key": chave ?? "", "anthropic-version": "2023-06-01" };
  return {
    ...(chave ? { Authorization: `Bearer ${chave}` } : {}),
    "HTTP-Referer": "https://github.com/reireymond/KTN-Office", // OpenRouter mostra o app; os outros ignoram
    "X-Title": "KTN Office",
  };
}

/** Lista os modelos que o provedor libera para essa chave (detecção automática). */
export async function listarModelosApi(tipo: TipoProvedor, baseUrl: string, chave?: string): Promise<string[]> {
  const base = semBarra(baseUrl);
  const url = tipo === "anthropic" ? `${base}/v1/models?limit=100` : `${base}/models`;
  const j = await pedir(url, undefined, cabecalhos(tipo, chave), AbortSignal.timeout(15_000));
  const lista: any[] = j?.data ?? j?.models ?? [];
  return lista.map((m) => String(m.id ?? m.name ?? "").replace(/^models\//, "")).filter(Boolean).sort();
}

// ---------- Ferramentas locais (arquivos), sempre presas à pasta de trabalho ----------

interface Ferramenta {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  executar: (args: any) => Promise<string> | string;
}

function dentro(raiz: string, rel: string): string {
  const alvo = path.resolve(raiz, String(rel || "."));
  const r = path.resolve(raiz);
  if (alvo !== r && !alvo.startsWith(r + path.sep)) throw new Error("Fora da pasta de trabalho.");
  if (alvo.split(path.sep).includes(".git")) throw new Error("A pasta .git não pode ser acessada.");
  return alvo;
}

export function ferramentasDeArquivo(raiz: string, podeEscrever: boolean): Ferramenta[] {
  const fs: Ferramenta[] = [
    {
      name: "listar_pasta",
      description: "Lista arquivos e pastas (caminho relativo à pasta de trabalho).",
      inputSchema: { type: "object", properties: { caminho: { type: "string" } } },
      executar: ({ caminho }) => {
        const p = dentro(raiz, caminho);
        return readdirSync(p).filter((n) => n !== ".git").slice(0, 300)
          .map((n) => (statSync(path.join(p, n)).isDirectory() ? n + "/" : n)).join("\n") || "(vazia)";
      },
    },
    {
      name: "ler_arquivo",
      description: "Lê um arquivo de texto (caminho relativo à pasta de trabalho). Arquivos grandes vêm cortados.",
      inputSchema: { type: "object", properties: { caminho: { type: "string" } }, required: ["caminho"] },
      executar: ({ caminho }) => {
        const t = readFileSync(dentro(raiz, caminho), "utf8");
        return t.length > 60_000 ? t.slice(0, 60_000) + `\n…(cortado, ${t.length} caracteres)` : t;
      },
    },
  ];
  if (podeEscrever) {
    fs.push({
      name: "escrever_arquivo",
      description: "Cria ou substitui um arquivo de texto (caminho relativo à pasta de trabalho).",
      inputSchema: { type: "object", properties: { caminho: { type: "string" }, conteudo: { type: "string" } }, required: ["caminho", "conteudo"] },
      executar: ({ caminho, conteudo }) => {
        const p = dentro(raiz, caminho);
        mkdirSync(path.dirname(p), { recursive: true });
        writeFileSync(p, String(conteudo ?? ""));
        return `Gravado: ${caminho}`;
      },
    });
  }
  return fs;
}

// ---------- Conversa com ferramentas (tool loop) ----------

/** Ferramentas MCP que não servem para IAs por API (são do fluxo de permissão do Claude Code). */
const MCP_FORA = new Set(["pedir_permissao"]);

function limparSchema(s: any): any {
  if (!s || typeof s !== "object") return s;
  if (Array.isArray(s)) return s.map(limparSchema);
  const { $schema, ...resto } = s; // alguns provedores (Gemini) recusam $schema
  return Object.fromEntries(Object.entries(resto).map(([k, v]) => [k, limparSchema(v)]));
}

export class ApiAgent implements Funcionario {
  readonly tipo = "api" as const;
  readonly especialidades: string[];
  constructor(
    readonly id: string,
    private cfg: ConfigCli,
    private urlOffice = URL_OFFICE(id),
  ) {
    this.especialidades = cfg.especialidades ?? [];
  }

  async trabalhar(prompt: string, opcoes: OpcoesTrabalho = {}): Promise<ResultadoTrabalho> {
    const api = this.cfg.api;
    if (!api?.baseUrl) return { ok: false, texto: "", erro: `${this.cfg.nome}: falta o endereço da API.` };
    const chave = chaveDe(this.id);
    const prov = PROVEDORES[api.provedor ?? ""];
    if (prov?.precisaChave && !chave) return { ok: false, texto: "", erro: `${this.cfg.nome}: falta a chave da API (Configurações → Equipe).` };
    const modelo = resolverModelo(this.cfg, opcoes.modelo);
    if (!modelo) return { ok: false, texto: "", erro: `${this.cfg.nome}: nenhum modelo escolhido.` };

    const controle = new AbortController();
    const timer = setTimeout(() => controle.abort(), opcoes.timeoutMs ?? 20 * 60_000);
    const cliente = new Client({ name: `ktn-${this.id}`, version: "1.0.0" });
    const tokens = { entrada: 0, saida: 0 };
    try {
      // Ferramentas: as do escritório (MCP) + arquivos na pasta de trabalho.
      let mcp: Ferramenta[] = [];
      try {
        await cliente.connect(new StreamableHTTPClientTransport(new URL(this.urlOffice)));
        const { tools } = await cliente.listTools();
        mcp = tools.filter((t) => !MCP_FORA.has(t.name)).map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: limparSchema(t.inputSchema),
          executar: async (args) => {
            const r = await cliente.callTool({ name: t.name, arguments: args ?? {} });
            const partes = (r.content as { type: string; text?: string }[] | undefined) ?? [];
            return partes.map((p) => p.text ?? `[${p.type}]`).join("\n") || "(vazio)";
          },
        }));
      } catch (e) {
        return { ok: false, texto: "", erro: `Não consegui falar com o servidor do escritório: ${e instanceof Error ? e.message : e}` };
      }
      const nivel = opcoes.nivel ?? "leitura";
      const arquivos = opcoes.cwd && existsSync(opcoes.cwd) ? ferramentasDeArquivo(opcoes.cwd, nivel !== "leitura") : [];
      const ferramentas = [...mcp, ...arquivos];
      const porNome = new Map(ferramentas.map((f) => [f.name, f]));
      const sistema = [
        `Você é "${this.id}" no KTN Office, um escritório de IAs. Use as ferramentas para trabalhar; não invente resultados.`,
        arquivos.length ? `Pasta de trabalho: ${opcoes.cwd} (as ferramentas de arquivo usam caminhos relativos a ela${nivel === "leitura" ? "; você só pode ler" : ""}).` : "",
        `Você não roda comandos no terminal. Responda em português.`,
      ].filter(Boolean).join("\n");

      const executar = async (nome: string, args: unknown) => {
        const f = porNome.get(nome);
        if (!f) return `Ferramenta "${nome}" não existe.`;
        opcoes.aoProgredir?.(`usando ${nome}`);
        try { return await f.executar(args); } catch (e) { return `Erro: ${e instanceof Error ? e.message : e}`; }
      };
      const texto =
        api.tipo === "anthropic"
          ? await this.loopAnthropic(api.baseUrl, chave, modelo, sistema, prompt, ferramentas, executar, tokens, controle.signal)
          : await this.loopOpenAI(api.baseUrl, chave, modelo, sistema, prompt, ferramentas, executar, tokens, controle.signal);
      return { ok: true, texto: texto.trim(), tokens };
    } catch (e) {
      const erro = controle.signal.aborted ? "Tempo esgotado." : e instanceof Error ? e.message : String(e);
      return { ok: false, texto: "", erro, tokens, semCota: /\b429\b|quota|rate.?limit|insufficient/i.test(erro) };
    } finally {
      clearTimeout(timer);
      await cliente.close().catch(() => {});
    }
  }

  private async loopOpenAI(base: string, chave: string | undefined, modelo: string, sistema: string, prompt: string, ferramentas: Ferramenta[],
    executar: (n: string, a: unknown) => Promise<string>, tokens: { entrada: number; saida: number }, sinal: AbortSignal): Promise<string> {
    const msgs: any[] = [{ role: "system", content: sistema }, { role: "user", content: prompt }];
    const tools = ferramentas.map((f) => ({ type: "function", function: { name: f.name, description: f.description.slice(0, 1000), parameters: f.inputSchema } }));
    for (let passo = 0; passo < 40; passo++) {
      const j = await pedir(`${semBarra(base)}/chat/completions`, { model: modelo, messages: msgs, tools, tool_choice: "auto" }, cabecalhos("openai", chave), sinal);
      tokens.entrada += j?.usage?.prompt_tokens ?? 0;
      tokens.saida += j?.usage?.completion_tokens ?? 0;
      const m = j?.choices?.[0]?.message;
      if (!m) throw new Error("Resposta vazia da API.");
      msgs.push({ role: "assistant", content: m.content ?? "", ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) });
      if (!m.tool_calls?.length) return String(m.content ?? "");
      for (const c of m.tool_calls) {
        let args: unknown = {};
        try { args = JSON.parse(c.function?.arguments || "{}"); } catch { /* argumentos inválidos */ }
        msgs.push({ role: "tool", tool_call_id: c.id, content: await executar(c.function?.name, args) });
      }
    }
    return "Parei depois de 40 passos de ferramenta.";
  }

  private async loopAnthropic(base: string, chave: string | undefined, modelo: string, sistema: string, prompt: string, ferramentas: Ferramenta[],
    executar: (n: string, a: unknown) => Promise<string>, tokens: { entrada: number; saida: number }, sinal: AbortSignal): Promise<string> {
    const msgs: any[] = [{ role: "user", content: prompt }];
    const tools = ferramentas.map((f) => ({ name: f.name, description: f.description.slice(0, 1000), input_schema: f.inputSchema }));
    for (let passo = 0; passo < 40; passo++) {
      const j = await pedir(`${semBarra(base)}/v1/messages`, { model: modelo, max_tokens: 8192, system: sistema, messages: msgs, tools }, cabecalhos("anthropic", chave), sinal);
      tokens.entrada += j?.usage?.input_tokens ?? 0;
      tokens.saida += j?.usage?.output_tokens ?? 0;
      const blocos: any[] = j?.content ?? [];
      msgs.push({ role: "assistant", content: blocos });
      const usos = blocos.filter((b) => b.type === "tool_use");
      if (!usos.length) return blocos.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const resultados = [];
      for (const u of usos) resultados.push({ type: "tool_result", tool_use_id: u.id, content: await executar(u.name, u.input) });
      msgs.push({ role: "user", content: resultados });
    }
    return "Parei depois de 40 passos de ferramenta.";
  }
}

/** Cria o funcionário certo: programa instalado (CLI) ou API. */
export function criarFuncionario(id: string, cfg: ConfigCli): Funcionario {
  return cfg.tipo === "api" ? new ApiAgent(id, cfg) : new CliAgent(id, cfg);
}
