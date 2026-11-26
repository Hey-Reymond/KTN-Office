import { ERRO_COTA, lerCotaDaSaida, type LeituraCota } from "../cota.js";
import { localizar } from "./detectar.js";
import { rodar } from "./processo.js";
import { resolverModelo, type ConfigCli } from "./registro.js";

export interface OpcoesTrabalho {
  modelo?: string;
  /** Nível de permissão desta execução (padrão: leitura). */
  nivel?: "leitura" | "edicao" | "comandos";
  /** Ferramentas extras liberadas ("sempre permitir"). */
  ferramentas?: string[];
  /** Recebe frases curtas de progresso enquanto a IA trabalha ("usando ferramenta X", trecho do texto…). */
  aoProgredir?: (frase: string) => void;
  /** Pasta onde a IA trabalha (arquivos do projeto). */
  cwd?: string;
  timeoutMs?: number;
}

export interface ResultadoTrabalho {
  ok: boolean;
  texto: string;
  /** Tokens gastos, quando o CLI/API informa. */
  tokens?: { entrada: number; saida: number };
  /** Cota que o CLI informou na saída (percentual usado, quando renova). */
  cota?: LeituraCota;
  /** Bateu no limite de uso do plano. */
  semCota?: boolean;
  erro?: string;
}

/**
 * Um "funcionário" do escritório. O gerente e o runner só conhecem esta interface,
 * então tanto faz se por trás é um CLI (assinatura) ou uma API (chave).
 */
export interface Funcionario {
  readonly id: string;
  readonly tipo: "cli" | "api";
  readonly especialidades: string[];
  trabalhar(prompt: string, opcoes?: OpcoesTrabalho): Promise<ResultadoTrabalho>;
}

const substituir = (args: string[], vars: Record<string, string>) =>
  args.map((a) => a.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? ""));

/** Lê a saída JSON do `claude -p --output-format json`. Se o formato mudar, cai pro texto puro. */
function lerClaudeJson(stdout: string): Pick<ResultadoTrabalho, "texto" | "tokens"> {
  try {
    // stream-json: uma linha por evento; o resultado final é o evento type=result.
    const linhas = stdout.trim().split("\n");
    const final =
      [...linhas].reverse().find((l) => l.includes('"type":"result"')) ??
      [...linhas].reverse().find((l) => l.includes('"result"')) ??
      stdout;
    const j = JSON.parse(final);
    const u = j.usage ?? {};
    const entrada =
      (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    return {
      texto: typeof j.result === "string" ? j.result : stdout,
      tokens: u.output_tokens !== undefined ? { entrada, saida: u.output_tokens } : undefined,
    };
  } catch {
    return { texto: stdout };
  }
}

/** Transforma uma linha de saída do CLI numa frase curta de progresso (ou null se não interessa). */
export function resumirProgresso(linha: string): string | null {
  const t = linha.trim();
  if (!t) return null;
  try {
    const j = JSON.parse(t);
    const conteudo = j.message?.content ?? j.content;
    if (Array.isArray(conteudo)) {
      for (const c of conteudo) {
        if (c.type === "tool_use") return `🔧 usando ${String(c.name).replace(/^mcp__office__/, "office/")}`;
        if (c.type === "text" && c.text?.trim()) return `💬 ${c.text.trim().slice(0, 160)}`;
      }
    }
    const item = j.item ?? j.msg ?? j;
    if (item.type === "command_execution" || item.command) return `⚙️ ${String(item.command ?? "").slice(0, 120)}`;
    if (item.type === "mcp_tool_call" || item.tool) return `🔧 usando ${item.server ? item.server + "/" : ""}${item.tool ?? item.name ?? ""}`;
    const texto = item.text ?? item.message ?? item.delta;
    if (typeof texto === "string" && texto.trim()) return `💬 ${texto.trim().slice(0, 160)}`;
    if (j.type === "system" && j.subtype === "init") return "🟢 iniciou";
    return null;
  } catch {
    return t.length > 3 ? t.slice(0, 160) : null;
  }
}

/** Monta uma mensagem de erro útil: ignora avisos inofensivos e procura o erro real também no stdout (JSON). */
export function explicarErro(stderr: string, stdout: string, codigo: number | null): string {
  const ruido = /^(Reading additional input from stdin|Warning:|npm notice)/i;
  const partes = stderr.split("\n").map((l) => l.trim()).filter((l) => l && !ruido.test(l));
  for (const l of stdout.trim().split("\n").reverse().slice(0, 15)) {
    try {
      const j = JSON.parse(l);
      const msg = j.error?.message ?? j.error ?? j.msg?.message ?? (j.type?.includes?.("error") ? j.message : undefined);
      if (typeof msg === "string" && msg.trim()) { partes.unshift(msg.trim()); break; }
    } catch {
      /* linha não é JSON */
    }
  }
  return partes.join(" | ").slice(0, 600) || `Saiu com código ${codigo} sem mensagem de erro.`;
}

/** Lê saídas JSON de outros CLIs (agy, codex…): procura o texto e o objeto usage nos campos mais comuns. */
function lerJsonGenerico(stdout: string): Pick<ResultadoTrabalho, "texto" | "tokens"> {
  // Saída em array de mensagens (ex.: qwen --output-format json): usa a mensagem "result" ou a última com texto.
  try {
    const arr = JSON.parse(stdout.trim());
    if (Array.isArray(arr)) {
      const fim = [...arr].reverse().find((m) => m?.type === "result" || typeof m?.result === "string");
      if (fim) return lerJsonGenerico(JSON.stringify(fim));
    }
  } catch { /* não é um array único */ }
  // Eventos NDJSON com pedaços de texto (ex.: opencode run --format json): junta os textos da resposta.
  const eventos = stdout.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (eventos.length > 1 && eventos.every((e: any) => typeof e === "object") && !eventos.some((e: any) => typeof e.result === "string" || typeof e.response === "string")) {
    const textos = eventos
      .filter((e: any) => /text/i.test(String(e.type ?? "")) )
      .map((e: any) => e.part?.text ?? e.text ?? e.content ?? "")
      .filter((t: unknown) => typeof t === "string" && t);
    let entrada = 0, saida = 0, temUso = false;
    for (const e of eventos as any[]) {
      const t = e.part?.tokens ?? e.tokens ?? e.usage;
      if (t && typeof t === "object") { temUso = true; entrada += t.input ?? t.input_tokens ?? 0; saida += t.output ?? t.output_tokens ?? 0; }
    }
    if (textos.length) return { texto: textos.join(""), tokens: temUso ? { entrada, saida } : undefined };
  }
  const linhas = stdout.trim().split("\n").reverse();
  for (const linha of [stdout.trim(), ...linhas]) {
    try {
      const j = JSON.parse(linha);
      const texto = [j.result, j.response, j.text, j.output, j.content].find((v) => typeof v === "string");
      const u = j.usage ?? j.stats ?? {};
      const entrada = (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      const saida = (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0);
      return { texto: texto ?? stdout, tokens: u.output_tokens !== undefined ? { entrada, saida } : undefined };
    } catch {
      /* tenta a próxima */
    }
  }
  return { texto: stdout };
}

/** Funcionário que trabalha através de um CLI instalado no PC (usa a assinatura do usuário). */
export class CliAgent implements Funcionario {
  readonly tipo = "cli" as const;
  readonly especialidades: string[];

  constructor(
    readonly id: string,
    private cfg: ConfigCli,
  ) {
    this.especialidades = cfg.especialidades ?? [];
  }

  /**
   * Monta os argumentos. Por padrão: [modelo] [saída json] [prompt].
   * Se o template do prompt tiver "{modeloArgs}", o modelo vai exatamente ali
   * (ex.: codex precisa de "exec ... -m X <prompt>", com o modelo depois do subcomando).
   */
  montarArgs(prompt: string, modelo?: string, opcoes: Pick<OpcoesTrabalho, "nivel" | "ferramentas"> = {}): string[] {
    const m = resolverModelo(this.cfg, modelo);
    const argsModelo = m && this.cfg.modelo ? substituir(this.cfg.modelo, { modelo: m }) : [];
    const extras = [...(this.cfg.argsExtras ?? []), ...(this.cfg.niveis?.[opcoes.nivel ?? "leitura"] ?? [])];
    if (opcoes.ferramentas?.length && this.cfg.permitirFerramentas) {
      extras.push(...substituir(this.cfg.permitirFerramentas, { ferramentas: opcoes.ferramentas.join(",") }));
    }
    const template = this.cfg.prompt;
    const args: string[] = [];
    if (!template.includes("{modeloArgs}")) args.push(...argsModelo);
    if (!template.includes("{extras}")) args.push(...extras);
    if (this.cfg.saidaJson) args.push(...this.cfg.saidaJson);
    for (const parte of template) {
      if (parte === "{modeloArgs}") args.push(...argsModelo);
      else if (parte === "{extras}") args.push(...extras);
      else args.push(...substituir([parte], { prompt }));
    }
    return args;
  }

  async trabalhar(prompt: string, opcoes: OpcoesTrabalho = {}): Promise<ResultadoTrabalho> {
    const caminho = localizar(this.cfg);
    if (!caminho) return { ok: false, texto: "", erro: `${this.cfg.nome} não está instalado.` };

    let resto = "";
    const r = await rodar(caminho, this.montarArgs(prompt, opcoes.modelo, opcoes), {
      cwd: opcoes.cwd,
      timeoutMs: opcoes.timeoutMs ?? 30 * 60_000,
      aoReceber: opcoes.aoProgredir
        ? (trecho) => {
            const linhas = (resto + trecho).split("\n");
            resto = linhas.pop() ?? "";
            for (const l of linhas) {
              const frase = resumirProgresso(l);
              if (frase) opcoes.aoProgredir!(frase);
            }
          }
        : undefined,
    });
    if (r.estourouTempo) return { ok: false, texto: r.stdout, erro: "Tempo esgotado." };
    const cota = lerCotaDaSaida(r.stdout);
    if (r.codigo !== 0) {
      const erro = explicarErro(r.stderr, r.stdout, r.codigo);
      return { ok: false, texto: r.stdout, erro, cota, semCota: ERRO_COTA.test(erro) || ERRO_COTA.test(r.stderr) };
    }

    const lido =
      this.cfg.leitorSaida === "claude-json"
        ? lerClaudeJson(r.stdout)
        : this.cfg.leitorSaida === "json"
          ? lerJsonGenerico(r.stdout)
          : { texto: r.stdout };
    return { ok: true, texto: lido.texto.trim(), tokens: "tokens" in lido ? lido.tokens : undefined, cota };
  }
}
