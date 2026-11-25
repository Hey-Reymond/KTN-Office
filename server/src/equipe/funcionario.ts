import { localizar } from "./detectar.js";
import { rodar } from "./processo.js";
import { resolverModelo, type ConfigCli } from "./registro.js";

export interface OpcoesTrabalho {
  modelo?: string;
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
    const j = JSON.parse(stdout);
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

  montarArgs(prompt: string, modelo?: string): string[] {
    const m = resolverModelo(this.cfg, modelo);
    const args: string[] = [];
    if (m && this.cfg.modelo) args.push(...substituir(this.cfg.modelo, { modelo: m }));
    if (this.cfg.saidaJson) args.push(...this.cfg.saidaJson);
    args.push(...substituir(this.cfg.prompt, { prompt }));
    return args;
  }

  async trabalhar(prompt: string, opcoes: OpcoesTrabalho = {}): Promise<ResultadoTrabalho> {
    const caminho = localizar(this.cfg);
    if (!caminho) return { ok: false, texto: "", erro: `${this.cfg.nome} não está instalado.` };

    const r = await rodar(caminho, this.montarArgs(prompt, opcoes.modelo), {
      cwd: opcoes.cwd,
      timeoutMs: opcoes.timeoutMs ?? 30 * 60_000,
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
