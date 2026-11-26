import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Escritorio, Tarefa } from "./db.js";
import { localizar } from "./equipe/detectar.js";
import { CliAgent, type Funcionario, type ResultadoTrabalho } from "./equipe/funcionario.js";
import { carregarRegistro, modeloDisponivel, resolverModelo, type ConfigCli } from "./equipe/registro.js";

export interface ConfigRunner {
  ligado: boolean;
  /** Quem conversa com você e distribui o trabalho. */
  coordenadora: string;
  /** Pasta onde as IAs trabalham (arquivos do projeto). */
  pastaTrabalho: string;
  intervaloSeg: number;
  /** Trava contra loop: máximo de execuções por IA por hora. */
  maxPorHora: number;
  /** Tentativas antes de desistir de uma tarefa e avisar você. */
  maxTentativas: number;
  timeoutMin: number;
}

export const CONFIG_PADRAO: ConfigRunner = {
  ligado: false,
  coordenadora: "claude",
  pastaTrabalho: path.join(os.homedir(), "KTN-Office-trabalho"),
  intervaloSeg: 5,
  maxPorHora: 20,
  maxTentativas: 2,
  timeoutMin: 20,
};

type Fabrica = (id: string, cfg: ConfigCli) => Funcionario;

/**
 * O "expediente" do escritório: de tempos em tempos acorda, sem você, cada IA que tem
 * tarefa aberta ou mensagem não lida, roda o CLI dela e registra o que aconteceu.
 */
export class Runner {
  private trabalhando = new Map<string, { desde: number; oque: string }>();
  private execucoes = new Map<string, number[]>();
  private tentativas = new Map<number, number>();
  private timer?: NodeJS.Timeout;
  private emCurso = new Set<Promise<void>>();

  constructor(
    private escritorio: Escritorio,
    private fabrica: Fabrica = (id, cfg) => new CliAgent(id, cfg),
  ) {}

  get config(): ConfigRunner {
    return { ...CONFIG_PADRAO, ...this.escritorio.lerConfig<Partial<ConfigRunner>>("runner", {}) };
  }

  atualizarConfig(parcial: Partial<ConfigRunner>) {
    const nova = { ...this.config, ...parcial };
    this.escritorio.gravarConfig("runner", nova);
    this.escritorio.registrarEvento(null, "config", `Configuração do expediente atualizada.`);
    this.agendar();
    return nova;
  }

  estado() {
    return {
      ...this.config,
      trabalhando: Object.fromEntries(this.trabalhando),
    };
  }

  iniciar() {
    this.agendar();
  }

  parar() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private agendar() {
    this.parar();
    this.timer = setTimeout(() => {
      this.ciclo()
        .catch((e) => this.escritorio.registrarEvento(null, "erro", `Erro no expediente: ${e}`))
        .finally(() => this.agendar());
    }, this.config.intervaloSeg * 1000);
    this.timer.unref?.();
  }

  /** Espera todo mundo que está trabalhando terminar (usado em testes e ao desligar). */
  async aguardarOcioso() {
    while (this.emCurso.size) await Promise.all([...this.emCurso]);
  }

  /**
   * Uma volta pelo escritório: acorda quem tem trabalho e NÃO espera terminar.
   * Assim cada IA trabalha no seu ritmo, em paralelo; quem termina antes pega a próxima.
   */
  async ciclo(): Promise<void> {
    const cfg = this.config;
    if (!cfg.ligado) return;
    const registro = carregarRegistro();
    const fora = this.escritorio.lerConfig<string[]>("foraDaEquipe", []);
    for (const [id, cli] of Object.entries(registro)) {
      if (cli.ativo === false || fora.includes(id) || this.trabalhando.has(id)) continue;
      if (!localizar(cli)) continue;
      const trabalho = this.proximoTrabalho(id, cli);
      if (!trabalho) continue;
      if (!this.dentroDoLimite(id, cfg.maxPorHora)) continue;
      const p: Promise<void> = this.executar(id, cli, trabalho, cfg)
        .catch((e) => this.escritorio.registrarEvento(id, "erro", `Erro inesperado: ${e}`))
        .finally(() => this.emCurso.delete(p));
      this.emCurso.add(p);
    }
  }

  private proximoTrabalho(id: string, cli: ConfigCli): { prompt: string; modelo?: string; tarefa?: Tarefa; oque: string } | null {
    const tarefa = this.escritorio.tarefasAbertasPara(id)[0];
    if (tarefa) {
      const modelo = tarefa.modelo && modeloDisponivel(cli, tarefa.modelo) ? tarefa.modelo : undefined;
      return {
        tarefa,
        modelo,
        oque: `tarefa #${tarefa.id}`,
        prompt: [
          `Você é "${id}" no KTN Office. Use as ferramentas do servidor MCP "office".`,
          `1. pegar_tarefa com id ${tarefa.id}.`,
          `2. Faça o trabalho: "${tarefa.titulo}".`,
          `3. entregar_tarefa com um resultado completo (o que fez, arquivos, pendências).`,
          `4. registrar_uso com uma estimativa dos tokens gastos.`,
          `Se precisar de ajuda de outra IA, crie uma tarefa para ela e entregue a sua dizendo o que ficou pendente.`,
        ].join("\n"),
      };
    }
    if (this.escritorio.temNaoLidas(id) > 0) {
      return {
        oque: "caixa de entrada",
        prompt: [
          `Você é "${id}" no KTN Office. Use as ferramentas do servidor MCP "office".`,
          `Leia sua caixa (ler_caixa) e dê continuidade:`,
          ...(id === this.config.coordenadora
            ? [
                `- Você é a COORDENADORA. Pedido do humano que dá pra dividir: criar_projeto, depois distribuir_projeto com`,
                `  uma parte para CADA IA da equipe (inclusive você), cada uma na parte em que é melhor, com o modelo certo.`,
                `  Pergunta simples: responda direto ao humano, sem projeto.`,
                `- Aviso de que todas as partes de um projeto terminaram: status_projeto, junte tudo com a sua parte (merge),`,
                `  revise a qualidade e finalize com concluir_projeto (o resultado vai para o humano).`,
              ]
            : [`- Pedido do humano: resolva ou responda; se precisar de outra IA, crie uma tarefa para ela.`]),
          `- Entrega de outra IA (tarefa avulsa): use o resultado para concluir o trabalho.`,
          `- Responda o humano com mandar_mensagem para "humano" quando tiver algo para ele.`,
          `Não fique esperando: o escritório te acorda de novo quando chegar algo.`,
        ].join("\n"),
      };
    }
    return null;
  }

  private dentroDoLimite(id: string, maxPorHora: number) {
    const umaHora = Date.now() - 3_600_000;
    const lista = (this.execucoes.get(id) ?? []).filter((t) => t > umaHora);
    this.execucoes.set(id, lista);
    if (lista.length < maxPorHora) return true;
    if (lista.length === maxPorHora) {
      lista.push(Date.now()); // avisa uma vez só
      this.escritorio.registrarEvento(id, "limite", `${id} atingiu ${maxPorHora} execuções na última hora; pausado.`);
      this.escritorio.enviarMensagem("escritorio", "humano", `${id} foi pausado: atingiu o limite de ${maxPorHora} execuções/hora.`);
    }
    return false;
  }

  private async executar(
    id: string,
    cli: ConfigCli,
    trabalho: { prompt: string; modelo?: string; tarefa?: Tarefa; oque: string },
    cfg: ConfigRunner,
  ) {
    this.trabalhando.set(id, { desde: Date.now(), oque: trabalho.oque });
    this.execucoes.get(id)?.push(Date.now()) ?? this.execucoes.set(id, [Date.now()]);
    const modeloReal = resolverModelo(cli, trabalho.modelo);
    this.escritorio.registrarEvento(id, "inicio", `Começou ${trabalho.oque}${modeloReal ? ` (modelo ${modeloReal})` : ""}.`);
    let r: ResultadoTrabalho;
    try {
      mkdirSync(cfg.pastaTrabalho, { recursive: true });
      r = await this.fabrica(id, cli).trabalhar(trabalho.prompt, {
        modelo: trabalho.modelo,
        cwd: cfg.pastaTrabalho,
        timeoutMs: cfg.timeoutMin * 60_000,
      });
    } catch (e) {
      r = { ok: false, texto: "", erro: String(e) };
    } finally {
      this.trabalhando.delete(id);
    }

    if (r.tokens) this.escritorio.registrarUso(id, r.tokens.entrada + r.tokens.saida);
    if (r.ok) this.escritorio.registrarEvento(id, "fim", `Terminou ${trabalho.oque}. ${r.texto.slice(0, 300)}`);
    else this.escritorio.registrarEvento(id, "erro", `Falhou em ${trabalho.oque}: ${r.erro}`);

    // Tarefa que continua aberta = a IA não pegou. Conta tentativa e desiste depois do limite.
    if (trabalho.tarefa && this.escritorio.tarefa(trabalho.tarefa.id)?.status === "aberta") {
      const n = (this.tentativas.get(trabalho.tarefa.id) ?? 0) + 1;
      this.tentativas.set(trabalho.tarefa.id, n);
      if (n >= cfg.maxTentativas) {
        const motivo = `Cancelada após ${n} tentativas sem ${id} assumir. Último erro: ${r.erro ?? "nenhum"}`;
        this.escritorio.cancelarTarefa(trabalho.tarefa.id, motivo);
        this.escritorio.enviarMensagem("escritorio", "humano", `Tarefa #${trabalho.tarefa.id}: ${motivo}`, trabalho.tarefa.id);
        this.escritorio.registrarEvento(id, "erro", motivo);
      }
    }
  }
}
