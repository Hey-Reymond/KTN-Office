import { localizarGh } from "../github.js";
import { localizar } from "./detectar.js";
import {
  conectarAoOffice,
  executarInstalacao,
  InstalacaoCancelada,
  liberarFerramentasOffice,
  planejarInstalacao,
  planejarInstalacaoGh,
  type PlanoInstalacao,
} from "./instalar.js";
import { rodar } from "./processo.js";
import { carregarRegistro } from "./registro.js";

export type StatusInstalacao = "preparando" | "instalando" | "conectando" | "concluido" | "cancelado" | "erro";

export interface EstadoInstalacao {
  id: string;
  nome: string;
  status: StatusInstalacao;
  /** 0 a 100. */
  progresso: number;
  etapa: string;
  comando: string;
  log: string;
  mensagem?: string;
  depois?: string;
  erro?: string;
  iniciadoEm: number;
  terminadoEm?: number;
}

interface TrabalhoInterno {
  estado: EstadoInstalacao;
  abort: AbortController;
  pulso?: ReturnType<typeof setInterval>;
}

const MAX_LOG = 8_000;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\r/g;

function limparLog(s: string): string {
  return s.replace(ANSI, "");
}

function etapaPorSaida(trecho: string): string | null {
  const t = trecho.toLowerCase();
  if (/baixando|downloading|fetching|getting/.test(t)) return "Baixando pacotes…";
  if (/extract|extraindo|unpack|descompact/.test(t)) return "Extraindo arquivos…";
  if (/added \d+ package|reify|installing|instalando/.test(t)) return "Instalando arquivos…";
  return null;
}

function percentualNaSaida(trecho: string): number | null {
  const m = trecho.match(/\b(\d{1,3})(?:\.\d+)?%/);
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 0 && n <= 100 ? n : null;
}

export interface OpcoesGerenciador {
  aoTerminar?: (id: string, estado: EstadoInstalacao) => Promise<void> | void;
  obterPlano?: (id: string) => { nome: string; plano: PlanoInstalacao } | null;
  executar?: (plano: PlanoInstalacao, aoReceber: (t: string) => void, signal: AbortSignal) => Promise<void>;
  posInstalar?: (id: string) => Promise<string | undefined>;
}

/**
 * Gerencia instalações rápidas de CLIs (IAs e GitHub CLI `gh`) acionadas pela interface,
 * com progresso ao vivo e cancelamento imediato (botão X).
 */
export class GerenciadorInstalacoes {
  private trabalhos = new Map<string, TrabalhoInterno>();

  constructor(private opcoes: OpcoesGerenciador = {}) {}

  planoDe(id: string): { nome: string; plano: PlanoInstalacao } | null {
    if (this.opcoes.obterPlano) return this.opcoes.obterPlano(id);
    if (id === "gh") return { nome: "GitHub CLI (gh)", plano: planejarInstalacaoGh() };
    const cfg = carregarRegistro()[id];
    if (!cfg) return null;
    return { nome: cfg.nome, plano: planejarInstalacao(cfg) };
  }

  /** Inicia a instalação em segundo plano e devolve o estado inicial imediatamente. */
  iniciar(id: string): EstadoInstalacao {
    const existente = this.trabalhos.get(id);
    if (existente && (existente.estado.status === "preparando" || existente.estado.status === "instalando" || existente.estado.status === "conectando")) {
      return { ...existente.estado };
    }
    const alvo = this.planoDe(id);
    if (!alvo) throw new Error(`CLI desconhecido: ${id}`);
    if (!alvo.plano.possivel) throw new Error(alvo.plano.descricao);

    const abort = new AbortController();
    const estado: EstadoInstalacao = {
      id,
      nome: alvo.nome,
      status: "preparando",
      progresso: 8,
      etapa: "Preparando instalação…",
      comando: alvo.plano.descricao,
      log: `$ ${alvo.plano.descricao}\n`,
      depois: alvo.plano.depois,
      iniciadoEm: Date.now(),
    };
    const trabalho: TrabalhoInterno = { estado, abort };
    this.trabalhos.set(id, trabalho);
    void this.rodarTrabalho(trabalho, alvo.plano);
    return { ...estado };
  }

  private async rodarTrabalho(trabalho: TrabalhoInterno, plano: PlanoInstalacao) {
    const { estado, abort } = trabalho;
    const pararPulso = () => {
      if (trabalho.pulso) {
        clearInterval(trabalho.pulso);
        trabalho.pulso = undefined;
      }
    };

    try {
      estado.status = "instalando";
      estado.progresso = 18;
      estado.etapa = "Baixando e instalando…";

      // Pulso suave pra barra avançar mesmo quando o instalador fica em silêncio (ex.: npm/winget).
      trabalho.pulso = setInterval(() => {
        if (estado.status === "instalando" && estado.progresso < 82) {
          estado.progresso = Math.min(82, estado.progresso + Math.max(1, Math.round((82 - estado.progresso) * 0.08)));
        }
      }, 1200);
      trabalho.pulso.unref();

      const aoReceber = (bruto: string) => {
        const limpo = limparLog(bruto);
        if (!limpo) return;
        estado.log = (estado.log + limpo).slice(-MAX_LOG);
        const pct = percentualNaSaida(limpo);
        if (pct !== null) {
          const mapeado = Math.round(18 + (pct / 100) * 64);
          if (mapeado > estado.progresso) estado.progresso = Math.min(82, mapeado);
        } else if (estado.progresso < 80) {
          estado.progresso = Math.min(80, estado.progresso + 2);
        }
        const novaEtapa = etapaPorSaida(limpo);
        if (novaEtapa) estado.etapa = novaEtapa;
      };

      const runner = this.opcoes.executar ?? executarInstalacao;
      await runner(plano, aoReceber, abort.signal);
      pararPulso();

      if (abort.signal.aborted) throw new InstalacaoCancelada();

      estado.status = "conectando";
      estado.progresso = 88;
      estado.etapa = estado.id === "gh" ? "Verificando GitHub CLI…" : "Conferindo instalação e conectando ao escritório…";

      const msgPos = this.opcoes.posInstalar ? await this.opcoes.posInstalar(estado.id) : await this.posInstalarPadrao(estado.id);

      if (abort.signal.aborted) throw new InstalacaoCancelada();

      estado.status = "concluido";
      estado.progresso = 100;
      estado.etapa = "Instalado com sucesso!";
      estado.mensagem = msgPos || `${estado.nome} instalado.`;
      estado.terminadoEm = Date.now();
    } catch (e) {
      pararPulso();
      if (e instanceof InstalacaoCancelada || abort.signal.aborted) {
        estado.status = "cancelado";
        estado.etapa = "Instalação cancelada.";
        estado.terminadoEm = Date.now();
      } else {
        estado.status = "erro";
        estado.etapa = "Falha na instalação";
        estado.erro = e instanceof Error ? e.message : String(e);
        estado.terminadoEm = Date.now();
      }
    } finally {
      pararPulso();
      try {
        await this.opcoes.aoTerminar?.(estado.id, { ...estado });
      } catch { /* não derruba */ }
    }
  }

  private async posInstalarPadrao(id: string): Promise<string | undefined> {
    if (id === "gh") {
      const caminho = localizarGh();
      return caminho ? `GitHub CLI encontrado em ${caminho}.` : "Instalado. Se o sistema ainda não reconhecer o gh, reinicie o KTN Office.";
    }
    const cfg = carregarRegistro()[id];
    if (!cfg) return undefined;
    const caminho = localizar(cfg);
    if (!caminho) {
      return `${cfg.nome} instalado. Se ainda aparecer como ausente, reinicie o KTN Office para recarregar o PATH.`;
    }
    const msgs: string[] = [];
    try {
      msgs.push(await conectarAoOffice(id, cfg, caminho));
      const lib = liberarFerramentasOffice(cfg);
      if (lib) msgs.push(lib);
    } catch (e) {
      msgs.push(`Instalado, mas não consegui conectar automaticamente: ${e instanceof Error ? e.message : e}`);
    }
    return msgs.join(" ");
  }

  /** Cancela uma instalação em andamento matando a árvore de processos. */
  cancelar(id: string): EstadoInstalacao {
    const t = this.trabalhos.get(id);
    if (!t) throw new Error(`Nenhuma instalação encontrada para ${id}.`);
    if (t.estado.status === "preparando" || t.estado.status === "instalando" || t.estado.status === "conectando") {
      t.estado.status = "cancelado";
      t.estado.etapa = "Cancelando instalação…";
      t.estado.terminadoEm = Date.now();
      t.abort.abort();
    }
    return { ...t.estado };
  }

  /** Remove o card de progresso depois de concluído, cancelado ou com erro. */
  limpar(id: string) {
    const t = this.trabalhos.get(id);
    if (!t) return;
    if (t.estado.status === "preparando" || t.estado.status === "instalando" || t.estado.status === "conectando") {
      t.abort.abort();
    }
    if (t.pulso) clearInterval(t.pulso);
    this.trabalhos.delete(id);
  }

  estadoDe(id: string): EstadoInstalacao | null {
    const t = this.trabalhos.get(id);
    return t ? { ...t.estado } : null;
  }

  listar(): Record<string, EstadoInstalacao> {
    const out: Record<string, EstadoInstalacao> = {};
    for (const [id, t] of this.trabalhos) out[id] = { ...t.estado };
    return out;
  }

  ativo(): boolean {
    for (const t of this.trabalhos.values()) {
      if (t.estado.status === "preparando" || t.estado.status === "instalando" || t.estado.status === "conectando") return true;
    }
    return false;
  }
}

export interface EstadoLoginGh {
  status: "ocioso" | "aguardando" | "concluido" | "cancelado" | "erro";
  codigo?: string;
  url?: string;
  log: string;
  erro?: string;
}

/**
 * Roda `gh auth login --web` sem terminal: captura o código de 8 caracteres
 * e mostra na interface para o usuário autorizar no navegador.
 */
export class GerenciadorLoginGh {
  private atual: EstadoLoginGh = { status: "ocioso", log: "" };
  private abort: AbortController | null = null;

  constructor(private aoConcluir?: () => Promise<void> | void) {}

  estado(): EstadoLoginGh {
    return { ...this.atual };
  }

  iniciar(): EstadoLoginGh {
    if (this.atual.status === "aguardando") return this.estado();
    const bin = localizarGh();
    if (!bin) throw new Error("Instale o GitHub CLI (gh) antes de fazer login.");

    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.atual = { status: "aguardando", url: "https://github.com/login/device", log: "" };

    void (async () => {
      const r = await rodar(
        bin,
        ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"],
        {
          timeoutMs: 5 * 60_000,
          entrada: "\n",
          signal,
          env: { ...process.env, BROWSER: "false", GH_BROWSER: "false" },
          aoReceber: (bruto) => {
            const limpo = limparLog(bruto);
            this.atual.log = (this.atual.log + limpo).slice(-4_000);
            const mCod = this.atual.log.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
            if (mCod) this.atual.codigo = mCod[1];
            const mUrl = this.atual.log.match(/https:\/\/github\.com\/login\/device\S*/);
            if (mUrl) this.atual.url = mUrl[0];
          },
        },
      );
      if (r.cancelado || signal.aborted) {
        this.atual.status = "cancelado";
        return;
      }
      if (r.codigo === 0) {
        this.atual.status = "concluido";
        await this.aoConcluir?.();
      } else {
        this.atual.status = "erro";
        this.atual.erro = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `gh auth login falhou (código ${r.codigo}).`;
      }
    })();

    return this.estado();
  }

  cancelar(): EstadoLoginGh {
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    this.atual = { status: "cancelado", log: this.atual.log };
    return this.estado();
  }
}
