import { localizar } from "./detectar.js";
import { rodar } from "./processo.js";
import { resolverModelo, type ConfigCli } from "./registro.js";

export interface OpcoesTrabalho {
  modelo?: string;
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

/** Lê saídas JSON de outros CLIs (agy, codex…): procura o texto e o objeto usage nos campos mais comuns. */
function lerJsonGenerico(stdout: string): Pick<ResultadoTrabalho, "texto" | "tokens"> {
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
  montarArgs(prompt: string, modelo?: string): string[] {
    const m = resolverModelo(this.cfg, modelo);
    const argsModelo = m && this.cfg.modelo ? substituir(this.cfg.modelo, { modelo: m }) : [];
    const template = this.cfg.prompt;
    const noLugar = template.includes("{modeloArgs}");
    const args: string[] = [];
    if (!noLugar) args.push(...argsModelo);
    if (this.cfg.saidaJson) args.push(...this.cfg.saidaJson);
    for (const parte of template) {
      if (parte === "{modeloArgs}") args.push(...argsModelo);
      else args.push(...substituir([parte], { prompt }));
    }
    return args;
  }

  async trabalhar(prompt: string, opcoes: OpcoesTrabalho = {}): Promise<ResultadoTrabalho> {
    const caminho = localizar(this.cfg);
    if (!caminho) return { ok: false, texto: "", erro: `${this.cfg.nome} não está instalado.` };

    let resto = "";
    const r = await rodar(caminho, this.montarArgs(prompt, opcoes.modelo), {
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
    if (r.codigo !== 0) return { ok: false, texto: r.stdout, erro: r.stderr.trim() || `Saiu com código ${r.codigo}` };

    const lido =
      this.cfg.leitorSaida === "claude-json"
        ? lerClaudeJson(r.stdout)
        : this.cfg.leitorSaida === "json"
          ? lerJsonGenerico(r.stdout)
          : { texto: r.stdout };
    return { ok: true, texto: lido.texto.trim(), tokens: "tokens" in lido ? lido.tokens : undefined };
  }
}

/** Reservado pra fase com chaves de API. Mesma interface, outro "contrato de trabalho". */
export class ApiAgent implements Funcionario {
  readonly tipo = "api" as const;
  constructor(
    readonly id: string,
    readonly especialidades: string[] = [],
  ) {}
  async trabalhar(): Promise<ResultadoTrabalho> {
    return { ok: false, texto: "", erro: "Funcionários via API ainda não foram implementados." };
  }
}
