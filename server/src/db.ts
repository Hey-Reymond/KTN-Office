import { situacaoCota } from "./cota.js";
import Database from "better-sqlite3";
import path from "node:path";

/** Estados possíveis de uma tarefa no quadro do escritório. */
export type StatusTarefa = "aberta" | "em_andamento" | "entregue" | "cancelada";

export interface Tarefa {
  id: number;
  titulo: string;
  descricao: string;
  criada_por: string;
  para: string | null; // null = qualquer agente pode pegar
  modelo: string | null; // modelo sugerido pela coordenação (ex.: "carbon", "haiku")
  projeto_id: number | null; // parte de qual projeto (null = tarefa avulsa)
  conversa_id: number | null; // chat de onde veio o pedido
  pasta: string | null; // cópia de trabalho (git worktree) desta tarefa, se houver
  branch: string | null;
  base: string | null; // commit de partida, para revisão/diff
  revisa: number | null; // se for uma revisão: qual tarefa está sendo revisada
  status: StatusTarefa;
  responsavel: string | null;
  resultado: string | null;
  criada_em: string;
  atualizada_em: string;
}

export interface Conversa {
  id: number;
  titulo: string;
  /** Pasta (projeto) em que as IAs trabalham neste chat. null = pasta padrão do expediente. */
  pasta: string | null;
  criada_em: string;
  atualizada_em: string;
}

export interface Mensagem {
  id: number;
  de: string;
  para: string;
  texto: string;
  tarefa_id: number | null;
  conversa_id: number | null;
  lida: number;
  criada_em: string;
}

export type StatusProjeto = "dividindo" | "em_andamento" | "integrando" | "consolidando" | "concluido" | "cancelado";

export interface Projeto {
  id: number;
  titulo: string;
  pedido: string;
  coordenadora: string;
  status: StatusProjeto;
  conversa_id: number | null;
  pasta_final: string | null; // cópia onde as partes foram juntadas
  branch_final: string | null;
  resultado: string | null;
  criado_em: string;
  atualizado_em: string;
}

export type NivelPermissao = "leitura" | "edicao" | "comandos";
export const NIVEIS: NivelPermissao[] = ["leitura", "edicao", "comandos"];

export interface PedidoPermissao {
  id: number;
  agente: string;
  /** Ferramenta exata (ex.: "Edit", "Bash") ou categoria (ex.: "edicao"). */
  ferramenta: string;
  /** O que a IA quer fazer (arquivo, comando, motivo), pra você decidir. */
  detalhe: string;
  /** espera = a IA está parada aguardando a resposta (Claude). */
  tipo: "espera" | "recado";
  status: "pendente" | "permitido" | "negado" | "expirado";
  sempre: number;
  tarefa_id: number | null;
  criado_em: string;
}

export interface ParteProjeto {
  para: string;
  titulo: string;
  descricao: string;
  modelo?: string | null;
  pasta?: string | null;
  branch?: string | null;
  base?: string | null;
}

export function abrirBanco(arquivo = process.env.KTN_DB ?? path.resolve("office.db")) {
  const db = new Database(arquivo);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS tarefas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo TEXT NOT NULL,
      descricao TEXT NOT NULL DEFAULT '',
      criada_por TEXT NOT NULL,
      para TEXT,
      status TEXT NOT NULL DEFAULT 'aberta',
      responsavel TEXT,
      resultado TEXT,
      criada_em TEXT NOT NULL DEFAULT (datetime('now')),
      atualizada_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS mensagens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      de TEXT NOT NULL,
      para TEXT NOT NULL,
      texto TEXT NOT NULL,
      tarefa_id INTEGER REFERENCES tarefas(id),
      lida INTEGER NOT NULL DEFAULT 0,
      criada_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS agentes (
      nome TEXT PRIMARY KEY,
      visto_em TEXT NOT NULL DEFAULT (datetime('now')),
      uso_estimado INTEGER NOT NULL DEFAULT 0,
      limite_estimado INTEGER,
      observacao TEXT
    );
    CREATE TABLE IF NOT EXISTS conversas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo TEXT NOT NULL,
      criada_em TEXT NOT NULL DEFAULT (datetime('now')),
      atualizada_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS projetos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      titulo TEXT NOT NULL,
      pedido TEXT NOT NULL DEFAULT '',
      coordenadora TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'dividindo',
      resultado TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now')),
      atualizado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agente TEXT,
      tipo TEXT NOT NULL,
      texto TEXT NOT NULL,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS permissoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agente TEXT NOT NULL,
      ferramenta TEXT NOT NULL,
      detalhe TEXT NOT NULL DEFAULT '',
      tipo TEXT NOT NULL DEFAULT 'recado',
      status TEXT NOT NULL DEFAULT 'pendente',
      sempre INTEGER NOT NULL DEFAULT 0,
      tarefa_id INTEGER,
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS config (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notas (
      chave TEXT PRIMARY KEY,
      conteudo TEXT NOT NULL,
      autor TEXT NOT NULL,
      atualizada_em TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // Migração: bancos da fase 1 não têm a coluna "modelo".
  const colunas = db.prepare(`PRAGMA table_info(tarefas)`).all() as { name: string }[];
  if (!colunas.some((c) => c.name === "modelo")) db.exec(`ALTER TABLE tarefas ADD COLUMN modelo TEXT`);
  if (!colunas.some((c) => c.name === "projeto_id")) db.exec(`ALTER TABLE tarefas ADD COLUMN projeto_id INTEGER`);
  const temColuna = (tabela: string, coluna: string) =>
    (db.prepare(`PRAGMA table_info(${tabela})`).all() as { name: string }[]).some((c) => c.name === coluna);
  for (const tabela of ["tarefas", "mensagens", "projetos"]) {
    if (!temColuna(tabela, "conversa_id")) db.exec(`ALTER TABLE ${tabela} ADD COLUMN conversa_id INTEGER`);
  }
  const novas: [string, string][] = [
    ["conversas", "pasta TEXT"], ["tarefas", "pasta TEXT"], ["tarefas", "branch TEXT"], ["tarefas", "base TEXT"],
    ["projetos", "pasta_final TEXT"], ["projetos", "branch_final TEXT"], ["tarefas", "revisa INTEGER"],
    ["agentes", "cota_percentual INTEGER"], ["agentes", "cota_renova INTEGER"], ["agentes", "cota_lida_em INTEGER"],
    ["agentes", "sem_cota_ate INTEGER"], ["agentes", "limite_5h INTEGER"],
  ];
  for (const [tabela, def] of novas) if (!temColuna(tabela, def.split(" ")[0])) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${def}`);
  db.exec(`CREATE TABLE IF NOT EXISTS uso (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agente TEXT NOT NULL,
    tokens INTEGER NOT NULL DEFAULT 0,
    criado_em INTEGER NOT NULL
  ); CREATE INDEX IF NOT EXISTS uso_agente ON uso (agente, criado_em);`);
  // Mensagens antigas com o humano (antes dos chats existirem) vão para a "Conversa 1".
  const orfas = db.prepare(`SELECT COUNT(*) AS n FROM mensagens WHERE conversa_id IS NULL AND (de = 'humano' OR para = 'humano')`).get() as { n: number };
  if (orfas.n > 0) {
    const id = Number(db.prepare(`INSERT INTO conversas (titulo) VALUES ('Conversa 1')`).run().lastInsertRowid);
    db.prepare(`UPDATE mensagens SET conversa_id = ? WHERE conversa_id IS NULL AND (de = 'humano' OR para = 'humano')`).run(id);
    db.prepare(`UPDATE projetos SET conversa_id = ? WHERE conversa_id IS NULL`).run(id);
  }
  return db;
}

export type Banco = ReturnType<typeof abrirBanco>;

/** Camada de acesso ao escritório. Toda regra de negócio fica aqui, fora do MCP. */
export class Escritorio {
  constructor(private db: Banco) {}

  registrarPresenca(agente: string) {
    this.db
      .prepare(
        `INSERT INTO agentes (nome) VALUES (?)
         ON CONFLICT(nome) DO UPDATE SET visto_em = datetime('now')`,
      )
      .run(agente);
  }

  criarTarefa(
    criadaPor: string,
    titulo: string,
    descricao: string,
    para: string | null,
    modelo: string | null = null,
    conversaId: number | null = null,
  ): Tarefa {
    const info = this.db
      .prepare(`INSERT INTO tarefas (titulo, descricao, criada_por, para, modelo, conversa_id) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(titulo, descricao, criadaPor, para, modelo, conversaId);
    const tarefa = this.tarefa(Number(info.lastInsertRowid))!;
    if (para) {
      const sugestao = modelo ? ` (modelo sugerido: ${modelo})` : "";
      this.enviarMensagem(criadaPor, para, `Nova tarefa #${tarefa.id} pra você: ${titulo}${sugestao}`, tarefa.id);
    }
    return tarefa;
  }

  tarefa(id: number): Tarefa | undefined {
    return this.db.prepare(`SELECT * FROM tarefas WHERE id = ?`).get(id) as Tarefa | undefined;
  }

  listarTarefas(filtro: { status?: StatusTarefa; para?: string } = {}): Tarefa[] {
    const cond: string[] = [];
    const args: unknown[] = [];
    if (filtro.status) {
      cond.push("status = ?");
      args.push(filtro.status);
    }
    if (filtro.para) {
      cond.push("(para = ? OR para IS NULL)");
      args.push(filtro.para);
    }
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    return this.db.prepare(`SELECT * FROM tarefas ${where} ORDER BY id`).all(...args) as Tarefa[];
  }

  /**
   * Pega uma tarefa aberta. Atômico: duas IAs nunca pegam a mesma tarefa.
   * Sem id, pega a mais antiga destinada ao agente (ou sem destinatário).
   */
  pegarTarefa(agente: string, id?: number): Tarefa {
    const pegar = this.db.transaction(() => {
      const alvo = id
        ? this.tarefa(id)
        : (this.db
            .prepare(
              `SELECT * FROM tarefas WHERE status = 'aberta' AND (para = ? OR para IS NULL)
               ORDER BY (para IS NULL), id LIMIT 1`,
            )
            .get(agente) as Tarefa | undefined);
      if (!alvo) throw new Error(id ? `Tarefa #${id} não existe.` : "Nenhuma tarefa aberta pra você.");
      if (alvo.status !== "aberta") throw new Error(`Tarefa #${alvo.id} não está aberta (status: ${alvo.status}).`);
      if (alvo.para && alvo.para !== agente) throw new Error(`Tarefa #${alvo.id} é destinada a ${alvo.para}.`);
      this.db
        .prepare(
          `UPDATE tarefas SET status = 'em_andamento', responsavel = ?, atualizada_em = datetime('now') WHERE id = ?`,
        )
        .run(agente, alvo.id);
      // O aviso de "nova tarefa" já cumpriu o papel: não precisa acordar a IA de novo por ele.
      this.db
        .prepare(`UPDATE mensagens SET lida = 1 WHERE para = ? AND tarefa_id = ? AND texto LIKE 'Nova tarefa #%'`)
        .run(agente, alvo.id);
      return this.tarefa(alvo.id)!;
    });
    return pegar();
  }

  entregarTarefa(agente: string, id: number, resultado: string): Tarefa {
    const t = this.tarefa(id);
    if (!t) throw new Error(`Tarefa #${id} não existe.`);
    if (t.status !== "em_andamento") throw new Error(`Tarefa #${id} não está em andamento (status: ${t.status}).`);
    if (t.responsavel !== agente) throw new Error(`Tarefa #${id} está com ${t.responsavel}, não com ${agente}.`);
    this.db
      .prepare(`UPDATE tarefas SET status = 'entregue', resultado = ?, atualizada_em = datetime('now') WHERE id = ?`)
      .run(resultado, id);
    // Parte de projeto: quem junta é a coordenadora, que é avisada quando TODAS as partes chegarem.
    if (!t.projeto_id) this.enviarMensagem(agente, t.criada_por, `Tarefa #${id} entregue: ${t.titulo}\n\n${resultado}`, id);
    this.verificarProjeto(t.projeto_id);
    return this.tarefa(id)!;
  }

  enviarMensagem(
    de: string,
    para: string,
    texto: string,
    tarefaId: number | null = null,
    conversaId: number | null = null,
  ): Mensagem {
    // Resposta pro humano sem chat informado: vai pro último chat em que o humano falou com essa IA.
    let conversa = conversaId;
    if (conversa === null && tarefaId) conversa = this.tarefa(tarefaId)?.conversa_id ?? null;
    if (conversa === null && para === "humano") conversa = this.conversaAtualCom(de);
    if (conversa !== null) {
      if (!this.conversa(conversa)) throw new Error(`Chat #${conversa} não existe.`);
      this.db.prepare(`UPDATE conversas SET atualizada_em = datetime('now') WHERE id = ?`).run(conversa);
    }
    const info = this.db
      .prepare(`INSERT INTO mensagens (de, para, texto, tarefa_id, conversa_id) VALUES (?, ?, ?, ?, ?)`)
      .run(de, para, texto, tarefaId, conversa);
    return this.db.prepare(`SELECT * FROM mensagens WHERE id = ?`).get(info.lastInsertRowid) as Mensagem;
  }

  // ---------- Chats (conversas com o humano) ----------

  criarConversa(titulo = "Novo chat"): Conversa {
    const info = this.db.prepare(`INSERT INTO conversas (titulo) VALUES (?)`).run(titulo.trim() || "Novo chat");
    return this.conversa(Number(info.lastInsertRowid))!;
  }

  conversa(id: number): Conversa | undefined {
    return this.db.prepare(`SELECT * FROM conversas WHERE id = ?`).get(id) as Conversa | undefined;
  }

  listarConversas(): Conversa[] {
    return this.db.prepare(`SELECT * FROM conversas ORDER BY atualizada_em DESC, id DESC`).all() as Conversa[];
  }

  renomearConversa(id: number, titulo: string) {
    if (!titulo.trim()) throw new Error("Título vazio.");
    if (!this.conversa(id)) throw new Error(`Chat #${id} não existe.`);
    this.db.prepare(`UPDATE conversas SET titulo = ? WHERE id = ?`).run(titulo.trim().slice(0, 120), id);
  }

  /** Apaga o chat e as mensagens dele. Projetos e tarefas ficam no histórico, só perdem o vínculo. */
  apagarConversa(id: number) {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM mensagens WHERE conversa_id = ?`).run(id);
      this.db.prepare(`UPDATE projetos SET conversa_id = NULL WHERE conversa_id = ?`).run(id);
      this.db.prepare(`UPDATE tarefas SET conversa_id = NULL WHERE conversa_id = ?`).run(id);
      this.db.prepare(`DELETE FROM conversas WHERE id = ?`).run(id);
    })();
  }

  /** Mensagens entre o humano e as IAs num chat (o "histórico" que as IAs podem ler). */
  historicoConversa(id: number, limite = 40): Mensagem[] {
    return (
      this.db
        .prepare(`SELECT * FROM mensagens WHERE conversa_id = ? AND (de = 'humano' OR para = 'humano') ORDER BY id DESC LIMIT ?`)
        .all(id, limite) as Mensagem[]
    ).reverse();
  }

  /** Chat da próxima mensagem não lida de uma IA (para saber em que pasta ela vai trabalhar). */
  conversaDaProximaMensagem(agente: string): number | null {
    const r = this.db
      .prepare(`SELECT conversa_id FROM mensagens WHERE para = ? AND lida = 0 AND conversa_id IS NOT NULL ORDER BY id LIMIT 1`)
      .get(agente) as { conversa_id: number } | undefined;
    return r?.conversa_id ?? null;
  }

  conversaAtualCom(agente: string): number | null {
    const r = this.db
      .prepare(`SELECT conversa_id FROM mensagens WHERE de = 'humano' AND para = ? AND conversa_id IS NOT NULL ORDER BY id DESC LIMIT 1`)
      .get(agente) as { conversa_id: number } | undefined;
    if (r) return r.conversa_id;
    const ultima = this.db.prepare(`SELECT id FROM conversas ORDER BY atualizada_em DESC, id DESC LIMIT 1`).get() as
      | { id: number }
      | undefined;
    return ultima?.id ?? null;
  }

  /** Lê as mensagens não lidas do agente e marca como lidas. */
  lerCaixa(agente: string): Mensagem[] {
    const ler = this.db.transaction(() => {
      const msgs = this.db
        .prepare(`SELECT * FROM mensagens WHERE para = ? AND lida = 0 ORDER BY id`)
        .all(agente) as Mensagem[];
      this.db.prepare(`UPDATE mensagens SET lida = 1 WHERE para = ? AND lida = 0`).run(agente);
      return msgs;
    });
    return ler();
  }

  registrarUso(agente: string, tokens: number, limite?: number, observacao?: string) {
    this.registrarPresenca(agente);
    this.db
      .prepare(
        `UPDATE agentes SET uso_estimado = uso_estimado + ?,
           limite_estimado = COALESCE(?, limite_estimado),
           observacao = COALESCE(?, observacao)
         WHERE nome = ?`,
      )
      .run(tokens, limite ?? null, observacao ?? null, agente);
    this.db.prepare(`INSERT INTO uso (agente, tokens, criado_em) VALUES (?, ?, ?)`).run(agente, Math.max(0, Math.round(tokens)), Date.now());
  }

  /** Uso nas últimas 5 horas (a janela de limite da maioria dos planos). */
  uso5h(agente: string, agora = Date.now()) {
    return this.db
      .prepare(`SELECT COALESCE(SUM(tokens), 0) AS tokens, COUNT(*) AS execucoes FROM uso WHERE agente = ? AND criado_em > ?`)
      .get(agente, agora - 5 * 3_600_000) as { tokens: number; execucoes: number };
  }

  /** Cota informada pelo próprio CLI (percentual usado da janela e quando renova). */
  atualizarCota(agente: string, percentual: number | undefined, renovaEm: number | undefined) {
    this.registrarPresenca(agente);
    this.db
      .prepare(`UPDATE agentes SET cota_percentual = COALESCE(?, cota_percentual), cota_renova = COALESCE(?, cota_renova), cota_lida_em = ? WHERE nome = ?`)
      .run(percentual ?? null, renovaEm ?? null, Date.now(), agente);
  }

  marcarSemCota(agente: string, ate: number | null) {
    this.registrarPresenca(agente);
    this.db.prepare(`UPDATE agentes SET sem_cota_ate = ? WHERE nome = ?`).run(ate, agente);
  }

  semCotaAte(agente: string, agora = Date.now()): number | null {
    const r = this.db.prepare(`SELECT sem_cota_ate FROM agentes WHERE nome = ?`).get(agente) as { sem_cota_ate: number | null } | undefined;
    return r?.sem_cota_ate && r.sem_cota_ate > agora ? r.sem_cota_ate : null;
  }

  /** Limite de tokens por 5h que o humano informou (opcional), para estimar o percentual quando o CLI não informa. */
  definirLimite5h(agente: string, limite: number | null) {
    this.registrarPresenca(agente);
    this.db.prepare(`UPDATE agentes SET limite_5h = ? WHERE nome = ?`).run(limite && limite > 0 ? Math.round(limite) : null, agente);
  }

  cota(agente: string, agora = Date.now()) {
    const a = this.db
      .prepare(`SELECT cota_percentual, cota_renova, cota_lida_em, sem_cota_ate, limite_5h FROM agentes WHERE nome = ?`)
      .get(agente) as { cota_percentual: number | null; cota_renova: number | null; cota_lida_em: number | null; sem_cota_ate: number | null; limite_5h: number | null } | undefined;
    const u = this.uso5h(agente, agora);
    // Leitura do CLI vale até a janela renovar (ou por 5h se ele não disse quando).
    const real = a?.cota_percentual != null && a.cota_lida_em && (a.cota_renova ? a.cota_renova > agora : agora - a.cota_lida_em < 5 * 3_600_000);
    const percentual = real ? a!.cota_percentual : a?.limite_5h ? Math.min(100, Math.round((u.tokens / a.limite_5h) * 100)) : null;
    const semCota = a?.sem_cota_ate && a.sem_cota_ate > agora ? a.sem_cota_ate : null;
    return {
      situacao: situacaoCota(percentual, semCota, agora),
      percentual_usado: percentual,
      fonte: real ? "informada pelo CLI" : percentual != null ? "estimada pelo limite que o humano definiu" : "desconhecida",
      renova_em: semCota ? new Date(semCota).toISOString() : real && a!.cota_renova ? new Date(a!.cota_renova).toISOString() : null,
      tokens_5h: u.tokens,
      execucoes_5h: u.execucoes,
      limite_5h: a?.limite_5h ?? null,
    };
  }

  statusEquipe() {
    const agentes = this.db.prepare(`SELECT * FROM agentes ORDER BY nome`).all() as {
      nome: string;
      visto_em: string;
      uso_estimado: number;
      limite_estimado: number | null;
      observacao: string | null;
    }[];
    return agentes.map((a) => {
      const emAndamento = this.db
        .prepare(`SELECT id, titulo FROM tarefas WHERE responsavel = ? AND status = 'em_andamento'`)
        .all(a.nome);
      const pendentes = (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM tarefas WHERE status = 'aberta' AND para = ?`)
          .get(a.nome) as { n: number }
      ).n;
      const naoLidas = (
        this.db.prepare(`SELECT COUNT(*) AS n FROM mensagens WHERE para = ? AND lida = 0`).get(a.nome) as {
          n: number;
        }
      ).n;
      return {
        agente: a.nome,
        situacao: emAndamento.length ? "ocupado" : "livre",
        trabalhando_em: emAndamento,
        tarefas_pendentes: pendentes,
        mensagens_nao_lidas: naoLidas,
        uso_estimado_tokens: a.uso_estimado,
        limite_estimado_tokens: a.limite_estimado,
        uso_percentual: a.limite_estimado ? Math.round((a.uso_estimado / a.limite_estimado) * 100) : null,
        cota: this.cota(a.nome),
        observacao: a.observacao,
        visto_em: a.visto_em,
      };
    });
  }

  escreverNota(autor: string, chave: string, conteudo: string) {
    this.db
      .prepare(
        `INSERT INTO notas (chave, conteudo, autor) VALUES (?, ?, ?)
         ON CONFLICT(chave) DO UPDATE SET conteudo = excluded.conteudo, autor = excluded.autor,
           atualizada_em = datetime('now')`,
      )
      .run(chave, conteudo, autor);
  }

  /** Linha do tempo pra interface (o que o runner e as IAs fizeram). */
  registrarEvento(agente: string | null, tipo: string, texto: string) {
    this.db.prepare(`INSERT INTO eventos (agente, tipo, texto) VALUES (?, ?, ?)`).run(agente, tipo, texto.slice(0, 2000));
  }

  eventosRecentes(limite = 50) {
    return this.db.prepare(`SELECT * FROM eventos ORDER BY id DESC LIMIT ?`).all(limite);
  }

  mensagensRecentes(limite = 100): Mensagem[] {
    return (this.db.prepare(`SELECT * FROM mensagens ORDER BY id DESC LIMIT ?`).all(limite) as Mensagem[]).reverse();
  }

  /** Mensagens não lidas de um agente, sem marcar como lidas (o runner só espia). */
  temNaoLidas(agente: string): number {
    return (
      this.db.prepare(`SELECT COUNT(*) AS n FROM mensagens WHERE para = ? AND lida = 0 AND de != ?`).get(agente, agente) as {
        n: number;
      }
    ).n;
  }

  tarefasAbertasPara(agente: string): Tarefa[] {
    return this.db
      .prepare(`SELECT * FROM tarefas WHERE status = 'aberta' AND para = ? ORDER BY id`)
      .all(agente) as Tarefa[];
  }

  cancelarTarefa(id: number, motivo: string) {
    this.db
      .prepare(`UPDATE tarefas SET status = 'cancelada', resultado = ?, atualizada_em = datetime('now') WHERE id = ?`)
      .run(motivo, id);
    this.verificarProjeto(this.tarefa(id)?.projeto_id ?? null);
  }

  // ---------- Projetos: a coordenadora divide, cada IA faz uma parte, a coordenadora junta ----------

  criarProjeto(coordenadora: string, titulo: string, pedido: string, conversaId: number | null = null): Projeto {
    const conversa = conversaId ?? this.conversaAtualCom(coordenadora);
    const info = this.db
      .prepare(`INSERT INTO projetos (titulo, pedido, coordenadora, conversa_id) VALUES (?, ?, ?, ?)`)
      .run(titulo, pedido, coordenadora, conversa);
    this.registrarEvento(coordenadora, "projeto", `Abriu o projeto #${info.lastInsertRowid}: ${titulo}`);
    return this.projeto(Number(info.lastInsertRowid))!;
  }

  projeto(id: number): Projeto | undefined {
    return this.db.prepare(`SELECT * FROM projetos WHERE id = ?`).get(id) as Projeto | undefined;
  }

  partesDoProjeto(id: number): Tarefa[] {
    return this.db.prepare(`SELECT * FROM tarefas WHERE projeto_id = ? ORDER BY id`).all(id) as Tarefa[];
  }

  listarProjetos(limite = 20) {
    const projetos = this.db.prepare(`SELECT * FROM projetos ORDER BY id DESC LIMIT ?`).all(limite) as Projeto[];
    return projetos.map((p) => ({ ...p, partes: this.partesDoProjeto(p.id) }));
  }

  /**
   * Distribui o projeto: uma parte por IA da equipe (incluindo a coordenadora).
   * `equipe` é quem está disponível agora; toda IA da equipe precisa receber pelo menos uma parte.
   */
  distribuirProjeto(coordenadora: string, id: number, partes: ParteProjeto[], equipe: string[]): Tarefa[] {
    const p = this.projeto(id);
    if (!p) throw new Error(`Projeto #${id} não existe.`);
    if (p.coordenadora !== coordenadora) throw new Error(`Só ${p.coordenadora} distribui o projeto #${id}.`);
    if (p.status !== "dividindo") throw new Error(`Projeto #${id} já foi distribuído (status: ${p.status}).`);
    const fora = partes.filter((x) => !equipe.includes(x.para)).map((x) => x.para);
    if (fora.length) throw new Error(`Não estão na equipe: ${[...new Set(fora)].join(", ")}. Equipe: ${equipe.join(", ")}`);
    const semParte = equipe.filter((a) => !partes.some((x) => x.para === a));
    if (semParte.length) {
      throw new Error(`Toda IA da equipe precisa de uma parte (inclusive você). Faltou: ${semParte.join(", ")}.`);
    }
    const criar = this.db.transaction(() => {
      const tarefas = partes.map((x) => {
        const info = this.db
          .prepare(`INSERT INTO tarefas (titulo, descricao, criada_por, para, modelo, projeto_id, conversa_id, pasta, branch, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(x.titulo, x.descricao, coordenadora, x.para, x.modelo ?? null, id, p.conversa_id, x.pasta ?? null, x.branch ?? null, x.base ?? null);
        return this.tarefa(Number(info.lastInsertRowid))!;
      });
      this.db.prepare(`UPDATE projetos SET status = 'em_andamento', atualizado_em = datetime('now') WHERE id = ?`).run(id);
      return tarefas;
    });
    const tarefas = criar();
    for (const t of tarefas) {
      if (t.para !== coordenadora) {
        this.enviarMensagem(coordenadora, t.para!, `Nova tarefa #${t.id} pra você (projeto #${id}): ${t.titulo}`, t.id);
      }
    }
    this.registrarEvento(coordenadora, "projeto", `Projeto #${id} dividido em ${tarefas.length} partes: ${tarefas.map((t) => `${t.para}${t.modelo ? `/${t.modelo}` : ""}`).join(", ")}.`);
    return tarefas;
  }

  /** Quando a última parte termina, avisa a coordenadora pra juntar tudo. */
  private verificarProjeto(id: number | null) {
    if (!id) return;
    const p = this.projeto(id);
    if (!p || p.status !== "em_andamento") return;
    const partes = this.partesDoProjeto(id);
    if (!partes.length || partes.some((t) => t.status === "aberta" || t.status === "em_andamento")) return;
    if (partes.some((t) => t.branch)) {
      // Partes com git: antes de avisar a coordenadora, o escritório junta as branches (ver integracao.ts).
      this.db.prepare(`UPDATE projetos SET status = 'integrando', atualizado_em = datetime('now') WHERE id = ?`).run(id);
      this.registrarEvento(p.coordenadora, "projeto", `Projeto #${id}: todas as partes chegaram; juntando as branches.`);
      return;
    }
    this.avisarConsolidacao(id);
  }

  /** Passa o projeto para a coordenadora juntar e revisar. `extra` traz o resultado do git, se houver. */
  avisarConsolidacao(id: number, extra = "") {
    const p = this.projeto(id)!;
    const partes = this.partesDoProjeto(id);
    this.db.prepare(`UPDATE projetos SET status = 'consolidando', atualizado_em = datetime('now') WHERE id = ?`).run(id);
    const canceladas = partes.filter((t) => t.status === "cancelada").length;
    this.enviarMensagem(
      "escritorio",
      p.coordenadora,
      `Projeto #${id} (${p.titulo}): todas as ${partes.length} partes terminaram${canceladas ? ` (${canceladas} cancelada(s))` : ""}. ` +
        `Use status_projeto para ler as entregas, faça o merge com a sua parte e finalize com concluir_projeto.${extra ? `\n\n${extra}` : ""}`,
      null,
      p.conversa_id,
    );
    this.registrarEvento(p.coordenadora, "projeto", `Projeto #${id}: todas as partes chegaram; hora do merge.`);
  }

  definirPastaConversa(id: number, pasta: string | null) {
    if (!this.conversa(id)) throw new Error(`Chat #${id} não existe.`);
    this.db.prepare(`UPDATE conversas SET pasta = ? WHERE id = ?`).run(pasta, id);
  }

  definirIntegracao(id: number, pasta: string | null, branch: string | null) {
    this.db.prepare(`UPDATE projetos SET pasta_final = ?, branch_final = ? WHERE id = ?`).run(pasta, branch, id);
  }

  projetosEm(status: StatusProjeto): Projeto[] {
    return this.db.prepare(`SELECT * FROM projetos WHERE status = ?`).all(status) as Projeto[];
  }

  /**
   * Revisão cruzada: outra IA revisa a parte entregue, na mesma cópia (worktree) do autor.
   * Fica no mesmo projeto, então o projeto só fecha depois da revisão.
   */
  criarRevisao(t: Tarefa, revisor: string): Tarefa {
    const descricao = [
      `Revise o trabalho de ${t.responsavel} na tarefa #${t.id} ("${t.titulo}").`,
      t.branch ? `Você está na cópia dele (branch ${t.branch}). Veja as mudanças com: git diff ${t.base}...HEAD` : `Os arquivos estão na pasta de trabalho.`,
      `O que olhar: bugs, casos esquecidos, segurança, código confuso e se a tarefa foi mesmo cumprida.`,
      `Corrija direto os problemas pequenos (se tiver permissão de editar). Na entrega, comece com APROVADO ou PRECISA AJUSTE`,
      `e liste o que encontrou e o que corrigiu.`,
    ].join("\n");
    const info = this.db
      .prepare(`INSERT INTO tarefas (titulo, descricao, criada_por, para, projeto_id, conversa_id, pasta, base, revisa) VALUES (?, ?, 'escritorio', ?, ?, ?, ?, ?, ?)`)
      .run(`Revisar: ${t.titulo}`, descricao, revisor, t.projeto_id, t.conversa_id, t.pasta, t.base, t.id);
    const r = this.tarefa(Number(info.lastInsertRowid))!;
    this.enviarMensagem("escritorio", revisor, `Nova tarefa #${r.id} pra você: revisar o trabalho de ${t.responsavel} (#${t.id}).`, r.id);
    this.registrarEvento(revisor, "projeto", `Revisão cruzada: ${revisor} vai revisar a tarefa #${t.id} de ${t.responsavel}.`);
    return r;
  }

  /** Acrescenta texto ao resultado de uma tarefa já entregue (ex.: arquivos alterados, revisão). */
  anexarAoResultado(id: number, texto: string) {
    this.db.prepare(`UPDATE tarefas SET resultado = COALESCE(resultado, '') || ? WHERE id = ?`).run(texto, id);
  }

  concluirProjeto(coordenadora: string, id: number, resultado: string): Projeto {
    const p = this.projeto(id);
    if (!p) throw new Error(`Projeto #${id} não existe.`);
    if (p.coordenadora !== coordenadora) throw new Error(`Só ${p.coordenadora} conclui o projeto #${id}.`);
    const pendentes = this.partesDoProjeto(id).filter((t) => t.status === "aberta" || t.status === "em_andamento");
    if (pendentes.length) throw new Error(`Ainda faltam partes: ${pendentes.map((t) => `#${t.id} (${t.para})`).join(", ")}.`);
    this.db
      .prepare(`UPDATE projetos SET status = 'concluido', resultado = ?, atualizado_em = datetime('now') WHERE id = ?`)
      .run(resultado, id);
    this.enviarMensagem(coordenadora, "humano", `✅ Projeto #${id} concluído: ${p.titulo}\n\n${resultado}`, null, p.conversa_id);
    this.registrarEvento(coordenadora, "projeto", `Concluiu o projeto #${id}.`);
    return this.projeto(id)!;
  }

  lerConfig<T>(chave: string, padrao: T): T {
    const r = this.db.prepare(`SELECT valor FROM config WHERE chave = ?`).get(chave) as { valor: string } | undefined;
    return r ? (JSON.parse(r.valor) as T) : padrao;
  }

  gravarConfig(chave: string, valor: unknown) {
    this.db
      .prepare(`INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor`)
      .run(chave, JSON.stringify(valor));
  }

  // ---------- Permissões ----------

  nivelDe(agente: string): NivelPermissao {
    return this.lerConfig<Record<string, NivelPermissao>>("niveis", {})[agente] ?? "leitura";
  }

  definirNivel(agente: string, nivel: NivelPermissao) {
    if (!NIVEIS.includes(nivel)) throw new Error(`Nível inválido: ${nivel}`);
    this.gravarConfig("niveis", { ...this.lerConfig<Record<string, NivelPermissao>>("niveis", {}), [agente]: nivel });
    this.registrarEvento(agente, "config", `Permissão de ${agente}: ${nivel}.`);
  }

  /** Ferramentas que você mandou "sempre permitir" pra uma IA. */
  sempreDe(agente: string): string[] {
    return this.lerConfig<Record<string, string[]>>("sempre", {})[agente] ?? [];
  }

  definirSempre(agente: string, ferramentas: string[]) {
    this.gravarConfig("sempre", { ...this.lerConfig<Record<string, string[]>>("sempre", {}), [agente]: [...new Set(ferramentas)] });
  }

  /** Nível liberado só para a próxima execução daquela IA ("permitir uma vez"). */
  tomarUmaVez(agente: string): NivelPermissao | null {
    const mapa = this.lerConfig<Record<string, NivelPermissao>>("umaVez", {});
    const nivel = mapa[agente] ?? null;
    if (nivel) {
      delete mapa[agente];
      this.gravarConfig("umaVez", mapa);
    }
    return nivel;
  }

  pedirPermissao(
    agente: string,
    ferramenta: string,
    detalhe: string,
    tipo: "espera" | "recado",
    tarefaId: number | null = null,
  ): PedidoPermissao {
    const info = this.db
      .prepare(`INSERT INTO permissoes (agente, ferramenta, detalhe, tipo, tarefa_id) VALUES (?, ?, ?, ?, ?)`)
      .run(agente, ferramenta, detalhe.slice(0, 2000), tipo, tarefaId);
    this.registrarEvento(agente, "permissao", `${agente} pediu permissão: ${ferramenta}. ${detalhe.slice(0, 200)}`);
    return this.pedido(Number(info.lastInsertRowid))!;
  }

  pedido(id: number): PedidoPermissao | undefined {
    return this.db.prepare(`SELECT * FROM permissoes WHERE id = ?`).get(id) as PedidoPermissao | undefined;
  }

  pedidosPendentes(): PedidoPermissao[] {
    return this.db.prepare(`SELECT * FROM permissoes WHERE status = 'pendente' ORDER BY id`).all() as PedidoPermissao[];
  }

  /**
   * Sua resposta ao pop-up. "Sempre": ferramenta exata entra na lista da IA, ou o nível dela sobe.
   * "Uma vez" num recado: o nível vale só para a próxima execução. A IA é avisada para continuar.
   */
  responderPermissao(id: number, permitir: boolean, sempre = false) {
    const p = this.pedido(id);
    if (!p) throw new Error(`Pedido #${id} não existe.`);
    if (p.status !== "pendente") throw new Error(`Pedido #${id} já foi respondido.`);
    this.db.prepare(`UPDATE permissoes SET status = ?, sempre = ? WHERE id = ?`).run(permitir ? "permitido" : "negado", sempre ? 1 : 0, id);
    const ehNivel = (NIVEIS as string[]).includes(p.ferramenta);
    if (permitir && sempre) {
      if (ehNivel) {
        const atual = NIVEIS.indexOf(this.nivelDe(p.agente));
        if (NIVEIS.indexOf(p.ferramenta as NivelPermissao) > atual) this.definirNivel(p.agente, p.ferramenta as NivelPermissao);
      } else this.definirSempre(p.agente, [...this.sempreDe(p.agente), p.ferramenta]);
    } else if (permitir && ehNivel) {
      this.gravarConfig("umaVez", { ...this.lerConfig<Record<string, string>>("umaVez", {}), [p.agente]: p.ferramenta });
    }
    this.registrarEvento(p.agente, "permissao", `Você ${permitir ? (sempre ? "sempre permitiu" : "permitiu uma vez") : "negou"}: ${p.ferramenta}.`);
    // Quem deixou recado não está esperando: precisa ser acordado com a resposta.
    if (p.tipo === "recado") {
      const tarefa = p.tarefa_id ? ` da tarefa #${p.tarefa_id} (ela continua com você; entregue com entregar_tarefa ao terminar)` : "";
      this.enviarMensagem(
        "escritorio",
        p.agente,
        permitir
          ? `O humano PERMITIU "${p.ferramenta}" (${sempre ? "sempre" : "só desta vez"}). Continue o trabalho${tarefa} de onde parou.`
          : `O humano NEGOU "${p.ferramenta}". Continue o trabalho${tarefa} sem isso, ou explique na entrega o que ficou faltando.`,
        p.tarefa_id,
      );
    }
  }

  expirarPedido(id: number) {
    this.db.prepare(`UPDATE permissoes SET status = 'expirado' WHERE id = ? AND status = 'pendente'`).run(id);
  }

  lerNotas(chave?: string) {
    return chave
      ? this.db.prepare(`SELECT * FROM notas WHERE chave = ?`).all(chave)
      : this.db.prepare(`SELECT chave, autor, atualizada_em, substr(conteudo, 1, 200) AS resumo FROM notas ORDER BY chave`).all();
  }
}
