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
  status: StatusTarefa;
  responsavel: string | null;
  resultado: string | null;
  criada_em: string;
  atualizada_em: string;
}

export interface Mensagem {
  id: number;
  de: string;
  para: string;
  texto: string;
  tarefa_id: number | null;
  lida: number;
  criada_em: string;
}

export type StatusProjeto = "dividindo" | "em_andamento" | "consolidando" | "concluido" | "cancelado";

export interface Projeto {
  id: number;
  titulo: string;
  pedido: string;
  coordenadora: string;
  status: StatusProjeto;
  resultado: string | null;
  criado_em: string;
  atualizado_em: string;
}

export interface ParteProjeto {
  para: string;
  titulo: string;
  descricao: string;
  modelo?: string | null;
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
  ): Tarefa {
    const info = this.db
      .prepare(`INSERT INTO tarefas (titulo, descricao, criada_por, para, modelo) VALUES (?, ?, ?, ?, ?)`)
      .run(titulo, descricao, criadaPor, para, modelo);
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

  enviarMensagem(de: string, para: string, texto: string, tarefaId: number | null = null): Mensagem {
    const info = this.db
      .prepare(`INSERT INTO mensagens (de, para, texto, tarefa_id) VALUES (?, ?, ?, ?)`)
      .run(de, para, texto, tarefaId);
    return this.db.prepare(`SELECT * FROM mensagens WHERE id = ?`).get(info.lastInsertRowid) as Mensagem;
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

  criarProjeto(coordenadora: string, titulo: string, pedido: string): Projeto {
    const info = this.db
      .prepare(`INSERT INTO projetos (titulo, pedido, coordenadora) VALUES (?, ?, ?)`)
      .run(titulo, pedido, coordenadora);
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
          .prepare(`INSERT INTO tarefas (titulo, descricao, criada_por, para, modelo, projeto_id) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(x.titulo, x.descricao, coordenadora, x.para, x.modelo ?? null, id);
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
    this.db.prepare(`UPDATE projetos SET status = 'consolidando', atualizado_em = datetime('now') WHERE id = ?`).run(id);
    const canceladas = partes.filter((t) => t.status === "cancelada").length;
    this.enviarMensagem(
      "escritorio",
      p.coordenadora,
      `Projeto #${id} (${p.titulo}): todas as ${partes.length} partes terminaram${canceladas ? ` (${canceladas} cancelada(s))` : ""}. ` +
        `Use status_projeto para ler as entregas, faça o merge com a sua parte e finalize com concluir_projeto.`,
    );
    this.registrarEvento(p.coordenadora, "projeto", `Projeto #${id}: todas as partes chegaram; hora do merge.`);
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
    this.enviarMensagem(coordenadora, "humano", `✅ Projeto #${id} concluído: ${p.titulo}\n\n${resultado}`);
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

  lerNotas(chave?: string) {
    return chave
      ? this.db.prepare(`SELECT * FROM notas WHERE chave = ?`).all(chave)
      : this.db.prepare(`SELECT chave, autor, atualizada_em, substr(conteudo, 1, 200) AS resumo FROM notas ORDER BY chave`).all();
  }
}
