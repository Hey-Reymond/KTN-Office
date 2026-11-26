import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ERRO_COTA, esperaDoErro, lerCotaDaSaida, situacaoCota } from "../src/cota.js";

const agora = Date.UTC(2026, 10, 26, 12, 0, 0);
// Codex (JSONL com rate_limits)
const codex = [
  `{"type":"thread.started"}`,
  `{"type":"token_count","rate_limits":{"primary":{"used_percent":42.4,"window_minutes":300,"resets_in_seconds":3600},"secondary":{"used_percent":12,"resets_in_seconds":86400}}}`,
].join("\n");
assert.deepEqual(lerCotaDaSaida(codex, agora), { percentual: 42, renovaEm: agora + 3_600_000 });
// Claude (rate_limit_info com utilization 0–1 e resetsAt em segundos)
const claude = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","utilization":0.85,"resetsAt":${agora / 1000 + 600}}}`;
assert.deepEqual(lerCotaDaSaida(claude, agora), { percentual: 85, renovaEm: agora + 600_000 });
assert.equal(lerCotaDaSaida(`{"type":"result","result":"oi"}`, agora), undefined);

assert.ok(ERRO_COTA.test("You've hit your usage limit. Try again in 2 hours."));
assert.ok(ERRO_COTA.test("429 Too Many Requests"));
assert.ok(!ERRO_COTA.test("model not supported"));
assert.equal(esperaDoErro("Try again in 2 hours", agora), agora + 7_200_000);
assert.equal(esperaDoErro("tente em 30 minutos", agora), agora + 1_800_000);
assert.equal(esperaDoErro("limite", agora), agora + 3_600_000);
assert.ok(esperaDoErro("Your limit resets at 3pm", agora) > agora);
assert.equal(situacaoCota(85, null, agora), "baixa");
assert.equal(situacaoCota(10, agora + 1, agora), "sem_cota");
assert.equal(situacaoCota(null, null, agora), "ok");

const tmp = mkdtempSync(path.join(tmpdir(), "ktn-cota-"));
try {
  const { abrirBanco, Escritorio } = await import("../src/db.js");
  const esc = new Escritorio(abrirBanco(path.join(tmp, "o.db")));
  esc.registrarUso("claude", 1000);
  esc.registrarUso("claude", 500);
  let c = esc.cota("claude");
  assert.equal(c.tokens_5h, 1500); assert.equal(c.execucoes_5h, 2); assert.equal(c.percentual_usado, null);
  esc.definirLimite5h("claude", 2000);
  c = esc.cota("claude");
  assert.equal(c.percentual_usado, 75); assert.match(c.fonte, /estimada/);
  esc.atualizarCota("claude", 90, Date.now() + 60_000);
  c = esc.cota("claude");
  assert.equal(c.percentual_usado, 90); assert.equal(c.situacao, "baixa"); assert.match(c.fonte, /CLI/);
  esc.marcarSemCota("claude", Date.now() + 60_000);
  assert.equal(esc.cota("claude").situacao, "sem_cota");
  assert.ok(esc.semCotaAte("claude"));
  assert.equal(esc.statusEquipe().find((s) => s.agente === "claude")!.cota.situacao, "sem_cota");
  esc.marcarSemCota("claude", null);
  assert.equal(esc.semCotaAte("claude"), null);
  console.log("OK: cota (leitura do Codex/Claude, erro de limite, espera, janela de 5h, situação).");
} finally {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
}
