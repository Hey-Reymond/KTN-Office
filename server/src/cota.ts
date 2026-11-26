/**
 * Cota real das IAs: lê o que os CLIs informam (percentual usado / quando renova),
 * reconhece erro de limite atingido e calcula quanto tempo esperar.
 */

/** Erro de limite de uso/cota (diferente de erro de modelo ou de código). */
export const ERRO_COTA =
  /usage limit|rate[ _-]?limit|quota|\b429\b|resource[ _-]?exhausted|too many requests|limit (?:reached|exceeded)|out of credits|insufficient[_ ]quota|hit your limit/i;

export interface LeituraCota {
  percentual?: number; // 0–100 usado da janela atual
  renovaEm?: number; // epoch ms
}

const numero = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : typeof v === "string" && v.trim() && isFinite(+v) ? +v : undefined);

/** Converte "resets_at" (epoch s/ms ou ISO) ou "resets_in_seconds" em epoch ms. */
function lerRenovacao(o: Record<string, unknown>, agora: number): number | undefined {
  for (const k of ["resets_in_seconds", "resetsInSeconds", "reset_in_seconds", "retry_after"]) {
    const n = numero(o[k]);
    if (n !== undefined) return agora + n * 1000;
  }
  for (const k of ["resets_at", "resetsAt", "reset_at", "resetAt", "resets"]) {
    const v = o[k];
    const n = numero(v);
    if (n !== undefined) return n < 1e12 ? n * 1000 : n;
    if (typeof v === "string" && !isNaN(Date.parse(v))) return Date.parse(v);
  }
  return undefined;
}

/** Procura em qualquer profundidade objetos com percentual usado / renovação (Codex: rate_limits.primary; Claude: rate_limit_info). */
function vasculhar(v: unknown, agora: number, achados: LeituraCota[], prof = 0) {
  if (!v || typeof v !== "object" || prof > 8) return;
  if (Array.isArray(v)) return v.forEach((x) => vasculhar(x, agora, achados, prof + 1));
  const o = v as Record<string, unknown>;
  let pct = numero(o.used_percent) ?? numero(o.usedPercent) ?? numero(o.percent_used);
  const util = numero(o.utilization);
  if (pct === undefined && util !== undefined) pct = util <= 1 ? util * 100 : util;
  const renova = lerRenovacao(o, agora);
  if (pct !== undefined || (renova !== undefined && /rate|limit|cota|quota/i.test(Object.keys(o).join(" ") + JSON.stringify(o).slice(0, 200)))) {
    achados.push({ percentual: pct !== undefined ? Math.max(0, Math.min(100, Math.round(pct))) : undefined, renovaEm: renova });
  }
  for (const x of Object.values(o)) vasculhar(x, agora, achados, prof + 1);
}

/** Lê a cota a partir da saída (JSON ou JSONL) de um CLI. Fica com a janela mais apertada. */
export function lerCotaDaSaida(saida: string, agora = Date.now()): LeituraCota | undefined {
  const achados: LeituraCota[] = [];
  for (const linha of saida.split("\n")) {
    const l = linha.trim();
    if (!l.startsWith("{") && !l.startsWith("[")) continue;
    try { vasculhar(JSON.parse(l), agora, achados); } catch { /* linha não é JSON */ }
  }
  if (!achados.length) {
    try { vasculhar(JSON.parse(saida), agora, achados); } catch { /* nada */ }
  }
  const comPct = achados.filter((a) => a.percentual !== undefined);
  if (comPct.length) return comPct.sort((a, b) => b.percentual! - a.percentual!)[0];
  return achados[0];
}

/** Quanto esperar depois de bater no limite: lê "try again in 2 hours", "resets at 3pm", epoch; senão o padrão. */
export function esperaDoErro(erro: string, agora = Date.now(), padraoMin = 60): number {
  const lido = lerCotaDaSaida(erro, agora);
  if (lido?.renovaEm && lido.renovaEm > agora) return lido.renovaEm;
  const em = erro.match(/(?:in|after|em)\s+(\d+(?:\.\d+)?)\s*(s|sec|seconds?|m|min|minutes?|minutos?|h|hr|hours?|horas?)\b/i);
  if (em) {
    const n = parseFloat(em[1]);
    const u = em[2].toLowerCase();
    const ms = u.startsWith("h") ? 3_600_000 : u.startsWith("s") ? 1000 : 60_000;
    return agora + n * ms;
  }
  const hora = erro.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (hora) {
    let h = +hora[1] % 24;
    if (hora[3]?.toLowerCase() === "pm" && h < 12) h += 12;
    if (hora[3]?.toLowerCase() === "am" && h === 12) h = 0;
    const d = new Date(agora);
    d.setHours(h, hora[2] ? +hora[2] : 0, 0, 0);
    if (d.getTime() <= agora) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  return agora + padraoMin * 60_000;
}

/** Situação para a coordenadora: ok, baixa (≥ 80%) ou sem_cota. */
export function situacaoCota(percentual: number | null | undefined, semCotaAte: number | null | undefined, agora = Date.now()) {
  if (semCotaAte && semCotaAte > agora) return "sem_cota" as const;
  if (percentual != null && percentual >= 80) return "baixa" as const;
  return "ok" as const;
}
