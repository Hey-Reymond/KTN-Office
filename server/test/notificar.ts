import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";

const tmp = mkdtempSync(path.join(tmpdir(), "ktn-notif-"));
const recebidos: { url: string; titulo: string; corpo: string; prio: string }[] = [];
const srv = http.createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => { const j = JSON.parse(b); recebidos.push({ url: "/" + j.topic, titulo: j.title, corpo: j.message, prio: j.priority === 4 ? "high" : "default" }); res.end("ok"); });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
const porta = (srv.address() as { port: number }).port;
try {
  const { abrirBanco, Escritorio } = await import("../src/db.js");
  const { enviarNtfy, ligarNotificacoes } = await import("../src/notificar.js");
  const esc = new Escritorio(abrirBanco(path.join(tmp, "o.db")));
  const servidor = `http://127.0.0.1:${porta}`;
  assert.equal(await enviarNtfy({ ntfyTopico: "curto", ntfyServidor: servidor }, "t", "x"), false, "tópico curto demais é recusado");
  assert.equal(await enviarNtfy({}, "t", "x"), false, "desligado sem tópico");
  ligarNotificacoes(esc);
  esc.enviarMensagem("claude", "humano", "nada configurado ainda");
  esc.gravarConfig("notificacoes", { ntfyTopico: "ktn-teste-123", ntfyServidor: servidor });
  esc.enviarMensagem("claude", "humano", "Pronto, terminei.");
  esc.enviarMensagem("claude", "antigravity", "isso não avisa o humano");
  esc.pedirPermissao("codex", "Bash", "npm install", "recado");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(recebidos.length, 2);
  assert.equal(recebidos[0].url, "/ktn-teste-123");
  assert.equal(recebidos[0].titulo, "claude respondeu");
  assert.equal(recebidos[0].corpo, "Pronto, terminei.");
  assert.equal(recebidos[1].titulo, "codex pede permissão");
  assert.equal(recebidos[1].prio, "high");
  console.log("OK: notificações (ntfy para respostas e pedidos de permissão).");
} finally {
  srv.close();
  rmSync(tmp, { recursive: true, force: true, maxRetries: 10 });
}
