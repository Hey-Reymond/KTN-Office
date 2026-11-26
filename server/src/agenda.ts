/** Tarefas agendadas: um pedido que o escritório manda sozinho para a equipe, de tempos em tempos. */
import type { Escritorio } from "./db.js";

export type TipoAgenda = "intervalo" | "diario" | "semanal" | "uma_vez";

export interface Agendamento {
  id: number;
  conversa_id: number | null;
  para: string | null; // null = coordenadora
  texto: string;
  tipo: TipoAgenda;
  minutos: number | null; // intervalo
  hora: string | null; // "HH:MM" (diário/semanal/uma vez)
  dias: string | null; // semanal: "1,3,5" (0 = domingo)
  data: string | null; // uma vez: "AAAA-MM-DD"
  proxima: number; // epoch ms
  ultima: number | null;
  ativo: number;
  criado_por: string;
}

export interface NovoAgendamento {
  texto: string;
  tipo: TipoAgenda;
  minutos?: number;
  hora?: string;
  dias?: number[];
  data?: string;
  conversa_id?: number | null;
  para?: string | null;
}

const HORA = /^([01]?\d|2[0-3]):([0-5]\d)$/;

export function validar(n: NovoAgendamento) {
  if (!String(n.texto ?? "").trim()) throw new Error("Escreva o que a equipe deve fazer.");
  if (!["intervalo", "diario", "semanal", "uma_vez"].includes(n.tipo)) throw new Error("Tipo inválido: use intervalo, diario, semanal ou uma_vez.");
  if (n.tipo === "intervalo" && !(Number(n.minutos) >= 15)) throw new Error("Intervalo mínimo: 15 minutos (para não gastar a cota à toa).");
  if (n.tipo !== "intervalo" && !HORA.test(String(n.hora ?? ""))) throw new Error("Informe a hora no formato HH:MM.");
  if (n.tipo === "semanal" && !(n.dias?.length && n.dias.every((d) => Number.isInteger(d) && d >= 0 && d <= 6))) throw new Error("Escolha os dias da semana (0 = domingo … 6 = sábado).");
  if (n.tipo === "uma_vez" && !/^\d{4}-\d{2}-\d{2}$/.test(String(n.data ?? ""))) throw new Error("Informe a data no formato AAAA-MM-DD.");
}

/** Próxima execução depois de "agora" (hora local do PC). */
export function proximaExecucao(a: Pick<Agendamento, "tipo" | "minutos" | "hora" | "dias" | "data">, agora = Date.now()): number | null {
  if (a.tipo === "intervalo") return agora + (a.minutos ?? 60) * 60_000;
  const [h, m] = String(a.hora).split(":").map(Number);
  if (a.tipo === "uma_vez") {
    const [ano, mes, dia] = String(a.data).split("-").map(Number);
    const t = new Date(ano, mes - 1, dia, h, m, 0, 0).getTime();
    return t > agora ? t : null;
  }
  const dias = a.tipo === "semanal" ? String(a.dias ?? "").split(",").filter(Boolean).map(Number) : [0, 1, 2, 3, 4, 5, 6];
  for (let i = 0; i < 8; i++) {
    const d = new Date(agora);
    d.setDate(d.getDate() + i);
    d.setHours(h, m, 0, 0);
    if (d.getTime() > agora && dias.includes(d.getDay())) return d.getTime();
  }
  return null;
}

const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
export function descrever(a: Pick<Agendamento, "tipo" | "minutos" | "hora" | "dias" | "data">): string {
  if (a.tipo === "intervalo") return (a.minutos ?? 0) % 60 === 0 ? `a cada ${(a.minutos ?? 0) / 60}h` : `a cada ${a.minutos} min`;
  if (a.tipo === "diario") return `todo dia às ${a.hora}`;
  if (a.tipo === "uma_vez") return `em ${String(a.data).split("-").reverse().join("/")} às ${a.hora}`;
  return `${String(a.dias).split(",").map((d) => DIAS[+d]).join(", ")} às ${a.hora}`;
}

/** Dispara o que venceu: manda o pedido (como se fosse o humano) para a coordenadora, no chat do agendamento. */
export function dispararVencidos(esc: Escritorio, coordenadora: string, agora = Date.now()): number {
  let n = 0;
  for (const a of esc.agendamentosVencidos(agora)) {
    dispararUm(esc, a, coordenadora, agora, proximaExecucao(a, agora));
    n++;
  }
  return n;
}

/** Manda o pedido agora. "proxima" = quando repetir (undefined = mantém a programação atual). */
export function dispararUm(esc: Escritorio, a: Agendamento, coordenadora: string, agora = Date.now(), proxima: number | null | undefined = undefined) {
  const para = a.para || coordenadora;
  let conversa = a.conversa_id && esc.conversa(a.conversa_id) ? a.conversa_id : null;
  if (!conversa) conversa = esc.criarConversa(`⏰ ${a.texto.slice(0, 40)}`).id;
  esc.enviarMensagem("agenda", para, `⏰ Tarefa agendada (#${a.id}, ${descrever(a)}): ${a.texto}`, null, conversa);
  esc.registrarEvento(para, "agenda", `Agendamento #${a.id} disparou: ${a.texto.slice(0, 120)}`);
  esc.marcarAgendamentoFeito(a.id, proxima === undefined ? a.proxima : proxima, agora, conversa);
}
