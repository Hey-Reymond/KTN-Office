import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Escritorio } from "./db.js";
import { carregarRegistro, modeloDisponivel, modelosDisponiveis } from "./equipe/registro.js";
import { equipeAtiva } from "./equipe/detectar.js";

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
      return json(fn(args));
    } catch (e) {
      return erro(e);
    }
  };

const INSTRUCOES = `Você é um funcionário do KTN Office, um escritório onde várias IAs trabalham juntas.
- Comece lendo sua caixa (ler_caixa) e o status da equipe (status_equipe).
- Para pedir algo a outra IA, use criar_tarefa com "para" = nome dela; depois acompanhe pela caixa.
- Ao terminar uma tarefa, use entregar_tarefa com um resultado completo e objetivo.
- Guarde decisões e contexto útil em escrever_nota, para ninguém gastar tokens repetindo trabalho.
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

  const equipe = () => equipeAtiva(escritorio.lerConfig<string[]>("foraDaEquipe", []));
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
      },
    },
    seguro(({ titulo, pedido }: { titulo: string; pedido: string }) => {
      const projeto = escritorio.criarProjeto(agente, titulo, pedido);
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
    seguro(({ projeto_id, partes }: { projeto_id: number; partes: { para: string; titulo: string; descricao: string; modelo?: string }[] }) => {
      const normalizadas = partes.map((x) => {
        const para = x.para.trim().toLowerCase();
        return { ...x, para, modelo: validarModelo(para, x.modelo?.trim()) };
      });
      return escritorio.distribuirProjeto(agente, projeto_id, normalizadas, equipe());
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
    seguro(({ projeto_id, resultado }: { projeto_id: number; resultado: string }) =>
      escritorio.concluirProjeto(agente, projeto_id, resultado),
    ),
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
    seguro(({ id, resultado }: { id: number; resultado: string }) => escritorio.entregarTarefa(agente, id, resultado)),
  );

  server.registerTool(
    "mandar_mensagem",
    {
      description: "Manda uma mensagem direta para outra IA (ou para 'humano').",
      inputSchema: {
        para: z.string().min(1),
        texto: z.string().min(1),
        tarefa_id: z.number().int().optional(),
      },
    },
    seguro(({ para, texto, tarefa_id }: { para: string; texto: string; tarefa_id?: number }) =>
      escritorio.enviarMensagem(agente, para, texto, tarefa_id ?? null),
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
        "Mostra cada IA do escritório: livre/ocupada, tarefas pendentes, mensagens não lidas e uso estimado de tokens. Use antes de delegar.",
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

  return server;
}
