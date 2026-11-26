import { mkdirSync } from "node:fs";
import type { Escritorio, Tarefa } from "./db.js";
import { localizar } from "./equipe/detectar.js";
import { criarFuncionario } from "./equipe/apis.js";
import { esperaDoErro } from "./cota.js";
import { dispararVencidos } from "./agenda.js";
import { PASTA_PADRAO, pastaDaTarefa, pastaDoChat, processarIntegracoes } from "./integracao.js";
import { CliAgent, type Funcionario, type ResultadoTrabalho } from "./equipe/funcionario.js";
import { carregarRegistro, modeloDisponivel, modelosDisponiveis, resolverModelo, salvarDeteccaoModelo, type ConfigCli } from "./equipe/registro.js";

/** Erros que querem dizer "esse modelo não está no seu plano" (não é falha da IA). */
export const ERRO_MODELO = /model.{0,80}(not supported|not available|does not exist|not found|unavailable|no access)|unknown model|invalid model|modelo .{0,40}(indispon|não (está )?dispon)/i;

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
  /** Minutos de pausa depois de 3 falhas seguidas da mesma IA. */
  pausaAposFalhasMin: number;
}

export const CONFIG_PADRAO: ConfigRunner = {
  ligado: false,
  coordenadora: "claude",
  pastaTrabalho: PASTA_PADRAO,
  intervaloSeg: 5,
  maxPorHora: 20,
  maxTentativas: 2,
  timeoutMin: 20,
  pausaAposFalhasMin: 10,
};

type Fabrica = (id: string, cfg: ConfigCli) => Funcionario;

/**
 * O "expediente" do escritório: de tempos em tempos acorda, sem você, cada IA que tem
 * tarefa aberta ou mensagem não lida, roda o CLI dela e registra o que aconteceu.
 */
export class Runner {
  private trabalhando = new Map<
    string,
    { desde: number; oque: string; modelo?: string; ultimoSinal: number; progresso: { quando: number; frase: string }[] }
  >();
  private execucoes = new Map<string, number[]>();
  private tentativas = new Map<number, number>();
  private timer?: NodeJS.Timeout;
  private emCurso = new Set<Promise<void>>();
  /** Falhas seguidas por IA: depois de 3, ela fica de molho por um tempo (evita loop de erro). */
  private falhas = new Map<string, { seguidas: number; pausadaAte: number }>();

  constructor(
    private escritorio: Escritorio,
    private fabrica: Fabrica = criarFuncionario,
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
    const agora = Date.now();
    return {
      ...this.config,
      trabalhando: Object.fromEntries(this.trabalhando),
      pausadas: Object.fromEntries(
        [...this.falhas].filter(([, f]) => f.pausadaAte > agora).map(([id, f]) => [id, f.pausadaAte]),
      ),
    };
  }

  /** Tira a pausa de uma IA (botão na interface). */
  retomar(id: string) {
    this.falhas.delete(id);
    this.escritorio.registrarEvento(id, "config", `${id} foi liberada para voltar a trabalhar.`);
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
    dispararVencidos(this.escritorio, cfg.coordenadora);
    const registro = carregarRegistro();
    const fora = this.escritorio.lerConfig<string[]>("foraDaEquipe", []);
    for (const [id, cli] of Object.entries(registro)) {
      if (cli.ativo === false || fora.includes(id) || this.trabalhando.has(id)) continue;
      if ((this.falhas.get(id)?.pausadaAte ?? 0) > Date.now()) continue;
      if (this.escritorio.semCotaAte(id)) continue; // esperando a cota renovar
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

  private proximoTrabalho(id: string, cli: ConfigCli): { prompt: string; modelo?: string; tarefa?: Tarefa; oque: string; pasta: string } | null {
    const tarefa = this.escritorio.tarefasAbertasPara(id)[0];
    if (tarefa) {
      const modelo = tarefa.modelo && modeloDisponivel(cli, tarefa.modelo) ? tarefa.modelo : undefined;
      return {
        tarefa,
        modelo,
        oque: `tarefa #${tarefa.id}`,
        pasta: pastaDaTarefa(this.escritorio, tarefa),
        prompt: [
          `Você é "${id}" no KTN Office. Use as ferramentas do servidor MCP "office".`,
          `1. pegar_tarefa com id ${tarefa.id}.`,
          `2. Faça o trabalho: "${tarefa.titulo}".`,
          `3. entregar_tarefa com um resultado completo (o que fez, arquivos, pendências).`,
          `4. registrar_uso com uma estimativa dos tokens gastos.`,
          `Se precisar de ajuda de outra IA, crie uma tarefa para ela e entregue a sua dizendo o que ficou pendente.`,
          `Se uma ação for bloqueada por falta de permissão (editar arquivos, rodar comandos), chame solicitar_permissao`,
          `explicando o que e por quê, NÃO entregue a tarefa e encerre: você será acordado com a resposta do humano.`,
          ...(tarefa.conversa_id
            ? [`Contexto: este trabalho é do chat #${tarefa.conversa_id}. Se precisar, use ler_memoria e historico_conversa com conversa_id ${tarefa.conversa_id}.`]
            : []),
          ...(tarefa.revisa
            ? [`Esta é uma REVISÃO CRUZADA: leia a descrição da tarefa, revise com cuidado e comece a entrega com APROVADO ou PRECISA AJUSTE.`]
            : []),
          ...(tarefa.branch
            ? [`Você está numa CÓPIA PRÓPRIA do projeto (git worktree, branch ${tarefa.branch}). Edite os arquivos aqui à vontade:`,
               `outras IAs trabalham em cópias separadas. Não precisa fazer commit; o escritório salva quando você entregar.`]
            : []),
        ].join("\n"),
      };
    }
    if (this.escritorio.temNaoLidas(id) > 0) {
      return {
        oque: "caixa de entrada",
        pasta: this.pastaDaCaixa(id),
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
                `- Cota: veja "cota" no status_equipe. Quem está "baixa" recebe partes menores/modelos mais baratos;`,
                `  quem está "sem_cota" fica fora da divisão até renovar.`,
              ]
            : [`- Pedido do humano: resolva ou responda; se precisar de outra IA, crie uma tarefa para ela.`]),
          `- Entrega de outra IA (tarefa avulsa): use o resultado para concluir o trabalho.`,
          `- Mensagem de "agenda" é um pedido que o humano agendou: trate como pedido dele e responda ao humano no mesmo chat.`,
          `- Se o humano pedir algo recorrente ("todo dia", "toda segunda", "daqui a 2h"), use agendar.`,
          `- Cada mensagem do humano tem conversa_id (o chat). Antes de agir, leia ler_memoria (e historico_conversa se precisar)`,
          `  desse chat. Responda com mandar_mensagem para "humano" passando o mesmo conversa_id, e use esse conversa_id em criar_projeto.`,
          `- Anote com escrever_memoria o que vale lembrar nas próximas vezes (decisões, preferências, caminhos de arquivos).`,
          `Não fique esperando: o escritório te acorda de novo quando chegar algo.`,
        ].join("\n"),
      };
    }
    return null;
  }

  /** Pasta para ler a caixa: a cópia final do projeto em fechamento, ou a pasta do chat da mensagem mais recente. */
  private pastaDaCaixa(id: string): string {
    const conversa = this.escritorio.conversaDaProximaMensagem(id);
    const fechando = this.escritorio.projetosEm("consolidando").find((p) => p.coordenadora === id && p.pasta_final && (!conversa || p.conversa_id === conversa));
    return fechando?.pasta_final ?? pastaDoChat(this.escritorio, conversa);
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
    trabalho: { prompt: string; modelo?: string; tarefa?: Tarefa; oque: string; pasta: string },
    cfg: ConfigRunner,
  ) {
    const modeloReal = resolverModelo(cli, trabalho.modelo);
    const estado = { desde: Date.now(), oque: trabalho.oque, modelo: modeloReal, ultimoSinal: Date.now(), progresso: [] as { quando: number; frase: string }[] };
    this.trabalhando.set(id, estado);
    this.execucoes.get(id)?.push(Date.now()) ?? this.execucoes.set(id, [Date.now()]);
    this.escritorio.registrarEvento(id, "inicio", `Começou ${trabalho.oque}${modeloReal ? ` (modelo ${modeloReal})` : ""}.`);
    let r: ResultadoTrabalho;
    try {
      mkdirSync(trabalho.pasta, { recursive: true });
      const nivel = this.escritorio.tomarUmaVez(id) ?? this.escritorio.nivelDe(id);
      const progredir = (frase: string) => {
        estado.ultimoSinal = Date.now();
        if (estado.progresso.at(-1)?.frase === frase) return;
        estado.progresso.push({ quando: Date.now(), frase });
        if (estado.progresso.length > 12) estado.progresso.shift();
      };
      r = await this.fabrica(id, cli).trabalhar(trabalho.prompt, {
        modelo: trabalho.modelo,
        nivel,
        ferramentas: this.escritorio.sempreDe(id),
        cwd: trabalho.pasta,
        timeoutMs: cfg.timeoutMin * 60_000,
        aoProgredir: progredir,
      });
      // Modelo recusado pelo plano: aprende (marca indisponível) e tenta o próximo modelo liberado.
      // Também cobre o caso em que o PRÓPRIO padrão do CLI não está no plano (o erro cita o id do modelo).
      const tentados = new Set<string>();
      let atual = trabalho.modelo;
      for (let i = 0; i < 5 && !r.ok && ERRO_MODELO.test(r.erro ?? ""); i++) {
        const motivo = (r.erro ?? "").slice(0, 200);
        const cfgAtual = carregarRegistro()[id] ?? cli;
        const recusado =
          atual ?? Object.entries(cfgAtual.modelos ?? {}).find(([k, m]) => (r.erro ?? "").includes(m.id ?? k))?.[0];
        if (recusado) {
          salvarDeteccaoModelo(id, recusado, motivo);
          tentados.add(recusado);
        }
        const proximo = Object.keys(modelosDisponiveis(carregarRegistro()[id] ?? cli)).find((k) => !tentados.has(k));
        if (!proximo && atual === undefined) break; // já tentou o padrão do CLI e não sobrou nada
        this.escritorio.registrarEvento(id, "config", `Modelo ${recusado ?? "padrão"} não está no seu plano; marcado como indisponível. Tentando ${proximo ?? "o modelo padrão do CLI"}.`);
        estado.progresso.push({ quando: Date.now(), frase: `🔁 ${recusado ?? "padrão"} não está no plano; tentando ${proximo ?? "o padrão"}` });
        atual = proximo;
        estado.modelo = proximo;
        r = await this.fabrica(id, carregarRegistro()[id] ?? cli).trabalhar(trabalho.prompt, {
          modelo: proximo,
          nivel,
          ferramentas: this.escritorio.sempreDe(id),
          cwd: trabalho.pasta,
          timeoutMs: cfg.timeoutMin * 60_000,
          aoProgredir: progredir,
        });
      }
    } catch (e) {
      r = { ok: false, texto: "", erro: String(e) };
    } finally {
      this.trabalhando.delete(id);
    }

    if (r.tokens) this.escritorio.registrarUso(id, r.tokens.entrada + r.tokens.saida);
    else this.escritorio.registrarUso(id, 0); // conta a execução mesmo sem tokens informados
    if (r.cota) this.escritorio.atualizarCota(id, r.cota.percentual, r.cota.renovaEm);
    const erroCurto = (r.erro ?? "").split("\n").slice(0, 3).join(" ").slice(0, 300);
    if (!r.ok && r.semCota) {
      // Limite do plano: não é falha da IA. Espera renovar e avisa; a coordenadora redistribui.
      const ate = esperaDoErro(r.erro ?? "");
      this.escritorio.marcarSemCota(id, ate);
      const hora = new Date(ate).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      this.escritorio.registrarEvento(id, "limite", `${id} atingiu o limite do plano; volta por volta das ${hora}.`);
      this.escritorio.enviarMensagem("escritorio", "humano", `⏳ ${id} atingiu o limite de uso do plano e volta por volta das ${hora}. As tarefas dela esperam (ou a coordenadora repassa).`);
      if (id !== this.config.coordenadora) {
        this.escritorio.enviarMensagem("escritorio", this.config.coordenadora, `${id} está sem cota até ${hora}. Se tiver tarefa urgente dela, repasse para outra IA (criar_tarefa).`);
      }
      return;
    }
    if (r.ok) {
      this.falhas.delete(id);
      this.escritorio.registrarEvento(id, "fim", `Terminou ${trabalho.oque}. ${r.texto.slice(0, 300)}`);
    } else {
      this.escritorio.registrarEvento(id, "erro", `Falhou em ${trabalho.oque}: ${erroCurto}`);
      const f = this.falhas.get(id) ?? { seguidas: 0, pausadaAte: 0 };
      f.seguidas++;
      if (f.seguidas >= 3) {
        f.pausadaAte = Date.now() + cfg.pausaAposFalhasMin * 60_000;
        f.seguidas = 0;
        this.escritorio.registrarEvento(id, "limite", `${id} falhou 3 vezes seguidas; pausada por ${cfg.pausaAposFalhasMin} min.`);
        this.escritorio.enviarMensagem(
          "escritorio",
          "humano",
          `⚠️ ${id} falhou 3 vezes seguidas e foi pausada por ${cfg.pausaAposFalhasMin} min. Último erro: ${erroCurto}`,
        );
      }
      this.falhas.set(id, f);
    }

    await processarIntegracoes(this.escritorio).catch(() => {});
    // Tarefa que continua aberta = a IA não pegou. Conta tentativa e desiste depois do limite.
    if (trabalho.tarefa && this.escritorio.tarefa(trabalho.tarefa.id)?.status === "aberta") {
      const n = (this.tentativas.get(trabalho.tarefa.id) ?? 0) + 1;
      this.tentativas.set(trabalho.tarefa.id, n);
      if (n >= cfg.maxTentativas) {
        const motivo = `Cancelada após ${n} tentativas sem ${id} assumir. Último erro: ${erroCurto || "nenhum"}`;
        this.escritorio.cancelarTarefa(trabalho.tarefa.id, motivo);
        this.escritorio.enviarMensagem("escritorio", "humano", `Tarefa #${trabalho.tarefa.id}: ${motivo}`, trabalho.tarefa.id);
        this.escritorio.registrarEvento(id, "erro", motivo);
        await processarIntegracoes(this.escritorio).catch(() => {});
      }
    }
  }
}
