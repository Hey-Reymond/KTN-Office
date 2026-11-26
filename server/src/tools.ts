import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { descrever, type NovoAgendamento } from "./agenda.js";
import { clonarGithub, conferirRepo, descreverAcao, executarAcao, lerConfigGithub, lerGithub, reposDaConta, type AcaoGithub } from "./github.js";
import { pastaDoChat } from "./integracao.js";
import type { Escritorio } from "./db.js";
import { carregarRegistro, modeloDisponivel, modelosDisponiveis } from "./equipe/registro.js";
import { equipeAtiva } from "./equipe/detectar.js";
import { arquivoMemoria, escreverMemoria, lerMemoria } from "./memoria.js";
import { escolherRevisor, fecharIntegracao, prepararPartes, processarIntegracoes, salvarEntrega } from "./integracao.js";

const json = (dados: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(dados, null, 2) }],
});

const erro = (e: unknown) => ({
  isError: true,
  content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }],
});

/** Executa a ação e transforma exceção em erro legível pra IA (em vez de derrubar a chamada). */
const seguro =
  <A>(fn: (args: A) => unknown) =>
  async (args: A) => {
    try {
      return json(await fn(args));
    } catch (e) {
      return erro(e);
    }
  };

export const ESPERA_PERMISSAO_MS = Number(process.env.KTN_ESPERA_PERMISSAO_MS ?? 5 * 60_000);

/** Frase curta do que a IA quer fazer, pro pop-up: o comando, o arquivo ou o endereço. */
function resumirEntrada(ferramenta: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const alvo = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? i.query;
  if (typeof alvo === "string") return alvo.slice(0, 500);
  try {
    return JSON.stringify(input).slice(0, 500);
  } catch {
    return ferramenta;
  }
}

const INSTRUCOES = `Você é um funcionário do KTN Office, um escritório onde várias IAs trabalham juntas.
- Comece lendo sua caixa (ler_caixa) e o status da equipe (status_equipe).
- Para pedir algo a outra IA, use criar_tarefa com "para" = nome dela; depois acompanhe pela caixa.
- Ao terminar uma tarefa, use entregar_tarefa com um resultado completo e objetivo.
- Guarde decisões e contexto útil em escrever_nota, para ninguém gastar tokens repetindo trabalho.
- Se você tiver ferramentas de navegador (playwright, chrome-devtools), use para abrir sites, pesquisar navegando e testar páginas.
- Cada pedido do humano vem de um chat (conversa_id). Para contexto, use historico_conversa e ler_memoria desse chat;
  ao responder o humano, passe o conversa_id; anote o que vale lembrar com escrever_memoria.
- Prefira delegar a quem tem a especialidade certa e mais folga de uso.
- Pedidos grandes do humano viram PROJETO: criar_projeto, depois distribuir_projeto com UMA parte para CADA IA da equipe
  (inclusive você), dando a cada uma a parte em que ela é melhor. No fim, junte tudo (merge) e use concluir_projeto.
- Ao delegar, escolha o modelo (modelos_equipe). Padrão: neon (antigravity), opus (claude), sol (codex). Topo (carbon, astra, fable) só no difícil; hydrogen/haiku/luna só no muito básico.`;

/** Valida o modelo contra o catálogo do agente. Agente sem catálogo aceita qualquer nome. */
function validarModelo(para: string | null, modelo?: string): string | null {
  if (!modelo) return null;
  const cfg = para ? carregarRegistro()[para] : undefined;
  if (!cfg?.modelos) return modelo; // agente sem catálogo aceita qualquer nome
  const apelido = modelo in cfg.modelos ? modelo : Object.keys(cfg.modelos).find((k) => cfg.modelos![k].id === modelo);
  if (!apelido || !modeloDisponivel(cfg, apelido)) {
    const opcoes = Object.keys(modelosDisponiveis(cfg)).join(", ");
    throw new Error(`Modelo "${modelo}" não está disponível para ${para}. Opções: ${opcoes}`);
  }
  return apelido;
}

export function criarServidor(escritorio: Escritorio, agente: string) {
  const server = new McpServer({ name: "ktn-office", version: "0.1.0" }, { instructions: INSTRUCOES });

  server.registerTool(
    "quem_sou_eu",
    { description: "Mostra com qual nome você está registrado no escritório." },
    seguro(() => ({ agente })),
  );

  server.registerTool(
    "criar_tarefa",
    {
      description:
        "Cria uma tarefa no quadro. Use 'para' com o nome de uma IA (ex.: claude, gemini, codex) para delegar; deixe vazio para qualquer uma pegar.",
      inputSchema: {
        titulo: z.string().min(1).describe("Resumo curto da tarefa"),
        descricao: z.string().default("").describe("O que precisa ser feito, contexto e critério de pronto"),
        para: z.string().optional().describe("Nome da IA que deve fazer (opcional)"),
        modelo: z
          .string()
          .optional()
          .describe("Modelo que a IA deve usar (ex.: carbon, neon, hydrogen, opus, sonnet, haiku). Veja modelos_equipe."),
      },
    },
    seguro(({ titulo, descricao, para, modelo }: { titulo: string; descricao: string; para?: string; modelo?: string }) => {
      const destino = para?.trim().toLowerCase() || null;
      return escritorio.criarTarefa(agente, titulo, descricao, destino, validarModelo(destino, modelo?.trim()));
    }),
  );

  // Quem está sem cota fica fora da divisão até renovar (mas a própria IA que chama sempre conta).
  const equipe = () => equipeAtiva(escritorio.lerConfig<string[]>("foraDaEquipe", [])).filter((a) => a === agente || !escritorio.semCotaAte(a));
  const perfilEquipe = () => {
    const reg = carregarRegistro();
    return equipe().map((id) => ({
      ia: id,
      especialidades: reg[id]?.especialidades ?? [],
      modelos: Object.fromEntries(Object.entries(modelosDisponiveis(reg[id])).map(([k, m]) => [k, `${m.nivel ?? ""} · ${m.quando ?? ""}`])),
      padrao: reg[id]?.modeloPadrao ?? null,
    }));
  };

  server.registerTool(
    "criar_projeto",
    {
      description:
        "Abre um projeto para um pedido grande. Devolve a equipe disponível (com especialidades e modelos). " +
        "Depois chame distribuir_projeto com uma parte para CADA IA da equipe, incluindo você.",
      inputSchema: {
        titulo: z.string().min(1),
        pedido: z.string().default("").describe("O pedido original do humano, completo"),
        conversa_id: z.number().int().optional().describe("Chat de onde veio o pedido (está na mensagem do humano)"),
      },
    },
    seguro(({ titulo, pedido, conversa_id }: { titulo: string; pedido: string; conversa_id?: number }) => {
      const projeto = escritorio.criarProjeto(agente, titulo, pedido, conversa_id ?? null);
      const time = perfilEquipe();
      return {
        projeto,
        equipe: time,
        instrucoes:
          `Divida em ${time.length} partes (uma por IA: ${time.map((t) => t.ia).join(", ")}). ` +
          `Dê a cada IA a parte em que ela tem mais competência. A sua parte (${agente}) também entra. ` +
          `Partes devem ser independentes o bastante para rodar em paralelo e fáceis de juntar no final.`,
      };
    }),
  );

  server.registerTool(
    "distribuir_projeto",
    {
      description: "Cria as partes do projeto: exatamente uma (ou mais) para cada IA da equipe, inclusive você.",
      inputSchema: {
        projeto_id: z.number().int(),
        partes: z
          .array(
            z.object({
              para: z.string().min(1),
              titulo: z.string().min(1),
              descricao: z.string().default("").describe("O que fazer, contexto e critério de pronto"),
              modelo: z.string().optional(),
            }),
          )
          .min(1),
      },
    },
    seguro(async ({ projeto_id, partes }: { projeto_id: number; partes: { para: string; titulo: string; descricao: string; modelo?: string }[] }) => {
      const normalizadas = partes.map((x) => {
        const para = x.para.trim().toLowerCase();
        return { ...x, para, modelo: validarModelo(para, x.modelo?.trim()) };
      });
      // Valida antes de criar cópias no disco (mesmas regras do distribuirProjeto).
      const time = equipe();
      const fora = normalizadas.filter((x) => !time.includes(x.para)).map((x) => x.para);
      if (fora.length) throw new Error(`Não estão na equipe: ${[...new Set(fora)].join(", ")}. Equipe: ${time.join(", ")}`);
      const p = escritorio.projeto(projeto_id);
      if (p && p.coordenadora === agente && p.status === "dividindo" && time.every((a) => normalizadas.some((x) => x.para === a))) {
        const { partes: prontas } = await prepararPartes(escritorio, projeto_id, normalizadas);
        return escritorio.distribuirProjeto(agente, projeto_id, prontas, time);
      }
      return escritorio.distribuirProjeto(agente, projeto_id, normalizadas, time);
    }),
  );

  server.registerTool(
    "status_projeto",
    {
      description: "Mostra o projeto e cada parte com o resultado entregue. Use para fazer o merge no final.",
      inputSchema: { projeto_id: z.number().int() },
    },
    seguro(({ projeto_id }: { projeto_id: number }) => {
      const projeto = escritorio.projeto(projeto_id);
      if (!projeto) throw new Error(`Projeto #${projeto_id} não existe.`);
      return { projeto, partes: escritorio.partesDoProjeto(projeto_id) };
    }),
  );

  server.registerTool(
    "concluir_projeto",
    {
      description:
        "Finaliza o projeto com o resultado consolidado (o merge de todas as partes, inclusive a sua). O resultado vai para o humano.",
      inputSchema: {
        projeto_id: z.number().int(),
        resultado: z.string().min(1).describe("Resultado final consolidado, pronto para o humano"),
      },
    },
    seguro(async ({ projeto_id, resultado }: { projeto_id: number; resultado: string }) => {
      const p = escritorio.projeto(projeto_id);
      if (!p) throw new Error(`Projeto #${projeto_id} não existe.`);
      if (p.coordenadora !== agente) throw new Error(`Só ${p.coordenadora} conclui o projeto #${projeto_id}.`);
      const rodape = await fecharIntegracao(escritorio, projeto_id);
      return escritorio.concluirProjeto(agente, projeto_id, resultado + rodape);
    }),
  );

  // Usada pelo Claude Code via --permission-prompt-tool: a IA fica esperando você responder no pop-up.
  server.registerTool(
    "pedir_permissao",
    {
      description:
        "Uso interno do escritório: pede ao humano permissão para usar uma ferramenta e espera a resposta (até 5 min).",
      inputSchema: {
        tool_name: z.string(),
        input: z.any().optional(),
        tool_use_id: z.string().optional(),
      },
    },
    async ({ tool_name, input }: { tool_name: string; input?: unknown; tool_use_id?: string }) => {
      const detalhe = resumirEntrada(tool_name, input);
      const pedido = escritorio.pedirPermissao(agente, tool_name, detalhe, "espera");
      const limite = Date.now() + ESPERA_PERMISSAO_MS;
      while (Date.now() < limite) {
        const atual = escritorio.pedido(pedido.id);
        if (atual && atual.status !== "pendente") {
          const resposta =
            atual.status === "permitido"
              ? { behavior: "allow", updatedInput: input ?? {} }
              : { behavior: "deny", message: "O humano negou essa permissão. Continue sem ela ou explique o que ficou faltando." };
          return { content: [{ type: "text" as const, text: JSON.stringify(resposta) }] };
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      escritorio.expirarPedido(pedido.id);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ behavior: "deny", message: "O humano não respondeu a tempo. Use solicitar_permissao, explique o que precisa e encerre." }),
        }],
      };
    },
  );

  server.registerTool(
    "solicitar_permissao",
    {
      description:
        "Pede ao humano um nível maior de permissão quando algo foi bloqueado: 'edicao' (criar/alterar arquivos na pasta de trabalho) " +
        "ou 'comandos' (rodar comandos). Depois de pedir, NÃO entregue a tarefa: encerre. Você será acordado com a resposta.",
      inputSchema: {
        nivel: z.enum(["edicao", "comandos"]),
        motivo: z.string().min(1).describe("O que você quer fazer e por quê (arquivo, comando)"),
        tarefa_id: z.number().int().optional(),
      },
    },
    seguro(({ nivel, motivo, tarefa_id }: { nivel: "edicao" | "comandos"; motivo: string; tarefa_id?: number }) => {
      const p = escritorio.pedirPermissao(agente, nivel, motivo, "recado", tarefa_id ?? null);
      return { pedido: p.id, aviso: "Pedido enviado ao humano. Encerre agora; o escritório te acorda com a resposta." };
    }),
  );

  server.registerTool(
    "historico_conversa",
    {
      description:
        "Lê as últimas mensagens entre o humano e a equipe num chat. Use quando precisar de contexto do que já foi conversado.",
      inputSchema: { conversa_id: z.number().int(), limite: z.number().int().min(1).max(200).default(30) },
    },
    seguro(({ conversa_id, limite }: { conversa_id: number; limite: number }) => {
      const c = escritorio.conversa(conversa_id);
      if (!c) throw new Error(`Chat #${conversa_id} não existe.`);
      return { conversa: c, mensagens: escritorio.historicoConversa(conversa_id, limite).map(({ de, para, texto, criada_em }) => ({ de, para, texto, criada_em })) };
    }),
  );

  server.registerTool(
    "ler_memoria",
    {
      description:
        "Lê a memória de um chat: decisões, preferências e fatos importantes anotados antes. Leia antes de trabalhar num pedido desse chat.",
      inputSchema: { conversa_id: z.number().int() },
    },
    seguro(({ conversa_id }: { conversa_id: number }) => {
      if (!escritorio.conversa(conversa_id)) throw new Error(`Chat #${conversa_id} não existe.`);
      return { arquivo: arquivoMemoria(conversa_id), memoria: lerMemoria(conversa_id) || "(vazia)" };
    }),
  );

  server.registerTool(
    "escrever_memoria",
    {
      description:
        "Anota na memória do chat algo que vale lembrar nas próximas vezes (decisão, preferência do humano, caminho de arquivo, resultado). Curto e objetivo.",
      inputSchema: {
        conversa_id: z.number().int(),
        texto: z.string().min(1),
        substituir: z.boolean().default(false).describe("true reescreve a memória inteira (use para resumir/limpar)"),
      },
    },
    seguro(({ conversa_id, texto, substituir }: { conversa_id: number; texto: string; substituir: boolean }) => {
      const c = escritorio.conversa(conversa_id);
      if (!c) throw new Error(`Chat #${conversa_id} não existe.`);
      escreverMemoria(conversa_id, c.titulo, substituir ? texto : `- ${texto.replace(/^- /, "")} (${agente})`, substituir);
      return { ok: true, arquivo: arquivoMemoria(conversa_id) };
    }),
  );

  server.registerTool(
    "modelos_equipe",
    {
      description:
        "Mostra os modelos que cada IA da equipe pode usar (nível, custo, velocidade, quando usar) e as especialidades. Use antes de delegar.",
    },
    seguro(() =>
      Object.fromEntries(
        Object.entries(carregarRegistro())
          .filter(([, c]) => c.ativo !== false)
          .map(([id, c]) => [
            id,
            { especialidades: c.especialidades ?? [], padrao: c.modeloPadrao ?? null, modelos: modelosDisponiveis(c) },
          ]),
      ),
    ),
  );

  server.registerTool(
    "listar_tarefas",
    {
      description: "Lista tarefas do quadro, com filtro opcional por status.",
      inputSchema: {
        status: z.enum(["aberta", "em_andamento", "entregue", "cancelada"]).optional(),
        so_minhas: z.boolean().default(false).describe("Só as destinadas a você (ou sem destinatário)"),
      },
    },
    seguro(({ status, so_minhas }: { status?: "aberta" | "em_andamento" | "entregue" | "cancelada"; so_minhas: boolean }) =>
      escritorio.listarTarefas({ status, para: so_minhas ? agente : undefined }),
    ),
  );

  server.registerTool(
    "pegar_tarefa",
    {
      description: "Assume uma tarefa aberta. Sem id, pega a próxima destinada a você.",
      inputSchema: { id: z.number().int().optional() },
    },
    seguro(({ id }: { id?: number }) => escritorio.pegarTarefa(agente, id)),
  );

  server.registerTool(
    "entregar_tarefa",
    {
      description: "Entrega uma tarefa que está com você. O resultado é enviado para quem criou a tarefa.",
      inputSchema: {
        id: z.number().int(),
        resultado: z.string().min(1).describe("Resultado completo: resposta, arquivos alterados, próximos passos"),
      },
    },
    seguro(async ({ id, resultado }: { id: number; resultado: string }) => {
      const t = escritorio.tarefa(id);
      if (!t) throw new Error(`Tarefa #${id} não existe.`);
      if (t.status !== "em_andamento" || t.responsavel !== agente) return escritorio.entregarTarefa(agente, id, resultado); // mensagem de erro padrão
      const salvo = await salvarEntrega(escritorio, t, agente);
      // Revisão cruzada: parte de projeto que mudou arquivos é revisada por outra IA antes de fechar o projeto.
      if (t.projeto_id && !t.revisa && escritorio.lerConfig("revisaoCruzada", true) && (salvo.mudou || !t.branch)) {
        const reg = carregarRegistro();
        const revisor = escolherRevisor(agente, equipe(), Object.fromEntries(Object.entries(reg).map(([k, c]) => [k, c.especialidades ?? []])));
        if (revisor) escritorio.criarRevisao({ ...t, responsavel: agente }, revisor);
      }
      const entregue = escritorio.entregarTarefa(agente, id, resultado + salvo.texto);
      if (t.revisa) escritorio.anexarAoResultado(t.revisa, `\n\n---\nRevisão de ${agente}:\n${resultado}${salvo.texto}`);
      await processarIntegracoes(escritorio);
      return entregue;
    }),
  );

  server.registerTool(
    "mandar_mensagem",
    {
      description: "Manda uma mensagem direta para outra IA (ou para 'humano').",
      inputSchema: {
        para: z.string().min(1),
        texto: z.string().min(1),
        tarefa_id: z.number().int().optional(),
        conversa_id: z.number().int().optional().describe("Chat do humano a que isso pertence (veja ler_caixa). Use ao responder o humano."),
      },
    },
    seguro(({ para, texto, tarefa_id, conversa_id }: { para: string; texto: string; tarefa_id?: number; conversa_id?: number }) =>
      escritorio.enviarMensagem(agente, para, texto, tarefa_id ?? null, conversa_id ?? null),
    ),
  );

  server.registerTool(
    "ler_caixa",
    { description: "Lê suas mensagens não lidas (e marca como lidas)." },
    seguro(() => {
      const msgs = escritorio.lerCaixa(agente);
      return msgs.length ? msgs : { aviso: "Caixa vazia." };
    }),
  );

  server.registerTool(
    "status_equipe",
    {
      description:
        "Mostra cada IA do escritório: livre/ocupada, tarefas pendentes, mensagens não lidas e a cota (situacao ok/baixa/sem_cota, percentual usado, quando renova, tokens nas últimas 5h). Use antes de delegar e poupe quem está com cota baixa.",
    },
    seguro(() => escritorio.statusEquipe()),
  );

  server.registerTool(
    "registrar_uso",
    {
      description:
        "Informa quantos tokens você gastou (estimativa) e, se souber, o limite do seu plano. Ajuda a equipe a economizar.",
      inputSchema: {
        tokens: z.number().int().nonnegative(),
        limite: z.number().int().positive().optional(),
        observacao: z.string().optional().describe("Ex.: 'perto do limite', 'rate limit até 15h'"),
      },
    },
    seguro(({ tokens, limite, observacao }: { tokens: number; limite?: number; observacao?: string }) => {
      escritorio.registrarUso(agente, tokens, limite, observacao);
      return { ok: true };
    }),
  );

  server.registerTool(
    "escrever_nota",
    {
      description: "Salva ou atualiza uma nota compartilhada (memória da equipe).",
      inputSchema: { chave: z.string().min(1), conteudo: z.string().min(1) },
    },
    seguro(({ chave, conteudo }: { chave: string; conteudo: string }) => {
      escritorio.escreverNota(agente, chave, conteudo);
      return { ok: true };
    }),
  );

  server.registerTool(
    "ler_notas",
    {
      description: "Sem chave: lista as notas com resumo. Com chave: lê a nota completa.",
      inputSchema: { chave: z.string().optional() },
    },
    seguro(({ chave }: { chave?: string }) => escritorio.lerNotas(chave)),
  );

  // ---------- GitHub (pelo gh logado no PC do humano; só repositórios liberados) ----------

  /** Espera o humano responder um pedido de permissão (popup na interface). */
  const esperarResposta = async (ferramenta: string, detalhe: string): Promise<boolean> => {
    if (escritorio.sempreDe(agente).includes(ferramenta)) return true;
    const pedido = escritorio.pedirPermissao(agente, ferramenta, detalhe, "espera");
    const limite = Date.now() + ESPERA_PERMISSAO_MS;
    while (Date.now() < limite) {
      const atual = escritorio.pedido(pedido.id);
      if (atual && atual.status !== "pendente") return atual.status === "permitido";
      await new Promise((r) => setTimeout(r, 700));
    }
    escritorio.expirarPedido(pedido.id);
    return false;
  };

  server.registerTool(
    "github_repos",
    { description: "Lista os repositórios do GitHub que o humano liberou para a equipe.", inputSchema: {} },
    seguro(async () => {
      const cfg = lerConfigGithub(escritorio);
      if (!cfg.ligado) throw new Error("O acesso ao GitHub está desligado (Configurações → Ferramentas → GitHub).");
      return cfg.todos ? { todos_da_conta: true, repos: await reposDaConta() } : { repos: cfg.repos ?? [] };
    }),
  );

  server.registerTool(
    "github_ler",
    {
      description:
        "Lê dados de um repositório liberado pela API do GitHub (só leitura). caminho é o que vem depois de repos/dono/nome/, " +
        "ex.: 'issues?state=open', 'issues/12/comments', 'pulls', 'pulls/3/files', 'commits?per_page=10', 'contents/src/app.ts', 'actions/runs?per_page=5'. Vazio = dados do repo.",
      inputSchema: { repo: z.string().describe("dono/nome"), caminho: z.string().optional() },
    },
    seguro(({ repo, caminho }: { repo: string; caminho?: string }) => lerGithub(escritorio, repo, caminho ?? "")),
  );

  server.registerTool(
    "github_clonar",
    {
      description: "Clona (ou atualiza) um repositório liberado na pasta de trabalho do chat, para ler e editar o código. Devolve o caminho.",
      inputSchema: { repo: z.string(), conversa_id: z.number().int().optional() },
    },
    seguro(async ({ repo, conversa_id }: { repo: string; conversa_id?: number }) => {
      const pasta = await clonarGithub(escritorio, repo, pastaDoChat(escritorio, conversa_id ?? escritorio.conversaAtualCom(agente)));
      escritorio.registrarEvento(agente, "github", `${agente} clonou ${repo} em ${pasta}.`);
      return { pasta, dica: "Para as IAs trabalharem nele com cópias próprias, o humano pode definir essa pasta como pasta do chat (botão 📁)." };
    }),
  );

  server.registerTool(
    "github_acao",
    {
      description:
        "Faz algo que MUDA o GitHub num repositório liberado: criar_issue (titulo, corpo), comentar (numero, corpo) ou criar_pr " +
        "(pasta = clone/cópia do repo numa branch própria, titulo, corpo, base opcional; envia a branch e abre o PR). " +
        "Sempre pede permissão ao humano antes (espera até 5 min).",
      inputSchema: {
        repo: z.string(),
        tipo: z.enum(["criar_issue", "comentar", "criar_pr"]),
        titulo: z.string().optional(),
        corpo: z.string().optional(),
        numero: z.number().int().optional(),
        pasta: z.string().optional(),
        base: z.string().optional(),
      },
    },
    seguro(async (a: { repo: string; tipo: AcaoGithub["tipo"]; titulo?: string; corpo?: string; numero?: number; pasta?: string; base?: string }) => {
      const repo = await conferirRepo(escritorio, a.repo);
      let acao: AcaoGithub;
      if (a.tipo === "criar_issue") {
        if (!a.titulo) throw new Error("Falta o titulo.");
        acao = { tipo: "criar_issue", titulo: a.titulo, corpo: a.corpo };
      } else if (a.tipo === "comentar") {
        if (!a.numero || !a.corpo) throw new Error("Falta numero ou corpo.");
        acao = { tipo: "comentar", numero: a.numero, corpo: a.corpo };
      } else {
        if (!a.pasta || !a.titulo) throw new Error("Falta pasta ou titulo.");
        acao = { tipo: "criar_pr", pasta: a.pasta, titulo: a.titulo, corpo: a.corpo, base: a.base };
      }
      const ok = await esperarResposta(`github_${a.tipo}`, descreverAcao(repo, acao));
      if (!ok) throw new Error("O humano não permitiu (ou não respondeu a tempo). Não tente de novo sem ele pedir.");
      const r = await executarAcao(repo, acao);
      escritorio.registrarEvento(agente, "github", `${agente}: ${descreverAcao(repo, acao)}. ${r.slice(0, 200)}`);
      return { feito: true, resultado: r };
    }),
  );

  server.registerTool(
    "agendar",
    {
      description:
        "Agenda um pedido para a equipe repetir sozinha (ex.: 'todo dia às 9h resuma os commits'). Use quando o humano pedir algo recorrente ou para depois. " +
        "tipo: intervalo (minutos ≥ 15), diario (hora HH:MM), semanal (hora + dias 0=dom…6=sáb), uma_vez (data AAAA-MM-DD + hora). Hora local do PC.",
      inputSchema: {
        texto: z.string().min(1).describe("O pedido, escrito como se fosse o humano pedindo."),
        tipo: z.enum(["intervalo", "diario", "semanal", "uma_vez"]),
        minutos: z.number().int().optional(),
        hora: z.string().optional(),
        dias: z.array(z.number().int()).optional(),
        data: z.string().optional(),
        conversa_id: z.number().int().optional().describe("Chat onde o resultado aparece (o mesmo do pedido)."),
        para: z.string().optional().describe("Quem recebe; padrão: a coordenadora."),
      },
    },
    seguro((n: NovoAgendamento) => {
      const a = escritorio.criarAgendamento(agente, { ...n, conversa_id: n.conversa_id ?? escritorio.conversaAtualCom(agente) });
      return { ...a, quando: descrever(a), proxima: new Date(a.proxima).toLocaleString("pt-BR") };
    }),
  );

  server.registerTool(
    "listar_agendamentos",
    { description: "Lista os pedidos agendados (de um chat, ou todos).", inputSchema: { conversa_id: z.number().int().optional() } },
    seguro(({ conversa_id }: { conversa_id?: number }) =>
      escritorio.listarAgendamentos(conversa_id).map((a) => ({ id: a.id, texto: a.texto, quando: descrever(a), ativo: !!a.ativo, proxima: a.proxima ? new Date(a.proxima).toLocaleString("pt-BR") : null })),
    ),
  );

  server.registerTool(
    "cancelar_agendamento",
    { description: "Pausa (ativo=false) ou apaga um agendamento quando o humano pedir.", inputSchema: { id: z.number().int(), apagar: z.boolean().optional() } },
    seguro(({ id, apagar }: { id: number; apagar?: boolean }) => {
      if (apagar) escritorio.apagarAgendamento(id); else escritorio.alternarAgendamento(id, false);
      return { ok: true };
    }),
  );

  return server;
}
