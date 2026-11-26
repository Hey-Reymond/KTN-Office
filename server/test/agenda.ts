import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { descrever, dispararUm, dispararVencidos, proximaExecucao, validar } from "../src/agenda.js";

const tmp = mkdtempSync(path.join(tmpdir(), "ktn-agenda-"));
try {
  // Quarta, 26/11/2026 10:00 local
  const agora = new Date(2026, 10, 26, 10, 0, 0).getTime();
  const diario = { tipo: "diario" as const, minutos: null, hora: "09:00", dias: null, data: null };
  assert.equal(proximaExecucao(diario, agora), new Date(2026, 10, 27, 9, 0).getTime(), "9h já passou: amanhã");
  assert.equal(proximaExecucao({ ...diario, hora: "18:30" }, agora), new Date(2026, 10, 26, 18, 30).getTime());
  const semanal = { tipo: "semanal" as const, minutos: null, hora: "08:00", dias: "1,5", data: null }; // seg e sex
  assert.equal(proximaExecucao(semanal, agora), new Date(2026, 10, 27, 8, 0).getTime(), "sexta");
  assert.equal(proximaExecucao({ tipo: "intervalo", minutos: 30, hora: null, dias: null, data: null }, agora), agora + 30 * 60_000);
  assert.equal(proximaExecucao({ tipo: "uma_vez", minutos: null, hora: "09:00", dias: null, data: "2026-11-26" }, agora), null, "já passou");
  assert.equal(descrever(semanal), "seg, sex às 08:00");
  assert.equal(descrever({ tipo: "intervalo", minutos: 120, hora: null, dias: null, data: null }), "a cada 2h");
  assert.throws(() => validar({ texto: "x", tipo: "intervalo", minutos: 5 }), /mínimo: 15/);
  assert.throws(() => validar({ texto: "x", tipo: "diario", hora: "25:00" }), /HH:MM/);
  assert.throws(() => validar({ texto: "", tipo: "diario", hora: "09:00" }), /Escreva/);

  const { abrirBanco, Escritorio } = await import("../src/db.js");
  const esc = new Escritorio(abrirBanco(path.join(tmp, "o.db")));
  const chat = esc.criarConversa("Rotina");
  const a = esc.criarAgendamento("humano", { texto: "Resuma os commits", tipo: "intervalo", minutos: 15, conversa_id: chat.id }, agora);
  assert.equal(dispararVencidos(esc, "claude", agora + 60_000), 0, "ainda não venceu");
  assert.equal(dispararVencidos(esc, "claude", agora + 16 * 60_000), 1);
  const caixa = esc.lerCaixa("claude");
  assert.match(caixa[0].texto, /⏰ Tarefa agendada \(#1, a cada 15 min\): Resuma os commits/);
  assert.equal(caixa[0].conversa_id, chat.id);
  assert.equal(esc.historicoConversa(chat.id).length, 1, "aparece no histórico do chat");
  assert.equal(esc.agendamento(a.id)!.proxima, agora + 31 * 60_000, "reprogramou");
  // uma vez: desativa depois de rodar
  const u = esc.criarAgendamento("humano", { texto: "Lembrete", tipo: "uma_vez", data: "2026-11-26", hora: "11:00" }, agora);
  dispararVencidos(esc, "claude", new Date(2026, 10, 26, 11, 1).getTime());
  assert.equal(esc.agendamento(u.id)!.ativo, 0);
  assert.ok(esc.agendamento(u.id)!.conversa_id, "sem chat: criou um");
  // pausar, rodar agora, apagar
  esc.lerCaixa("claude"); // limpa (o de 15 min também venceu às 11:01)
  esc.alternarAgendamento(a.id, false);
  assert.equal(dispararVencidos(esc, "claude", agora + 999 * 60_000), 0, "pausado não roda");
  dispararUm(esc, esc.agendamento(a.id)!, "claude");
  assert.equal(esc.lerCaixa("claude").length, 1);
  esc.apagarAgendamento(a.id);
  assert.equal(esc.agendamento(a.id), undefined);
  console.log("OK: agenda (diário, semanal, intervalo, uma vez, disparo no chat, pausar, rodar agora).");
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
}
