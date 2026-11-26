import type { Escritorio } from "./db.js";

export interface ConfigNotificacoes {
  /** Tópico do ntfy.sh para avisos no celular (app ntfy). Vazio = desligado. */
  ntfyTopico?: string;
  /** Servidor ntfy (padrão https://ntfy.sh; pode ser um próprio). */
  ntfyServidor?: string;
}

const curto = (t: string, n = 300) => (t.length > n ? t.slice(0, n - 1) + "…" : t);

/** Manda aviso pro celular via ntfy (só título e começo do texto). Falha em silêncio: aviso não pode quebrar o escritório. */
export async function enviarNtfy(cfg: ConfigNotificacoes, titulo: string, texto: string, prioridade: "default" | "high" = "default") {
  const topico = cfg.ntfyTopico?.trim();
  if (!topico || !/^[\w-]{6,64}$/.test(topico)) return false;
  const base = (cfg.ntfyServidor?.trim() || "https://ntfy.sh").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) return false;
  try {
    // Publicação em JSON: aceita acentos no título (cabeçalhos HTTP não).
    const r = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic: topico, title: curto(titulo, 100), message: curto(texto, 1000), priority: prioridade === "high" ? 4 : 3, tags: ["office"] }),
      signal: AbortSignal.timeout(10_000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Liga os avisos do servidor: mensagem pro humano, pedido de permissão. */
export function ligarNotificacoes(esc: Escritorio, enviar = enviarNtfy) {
  const cfg = () => esc.lerConfig<ConfigNotificacoes>("notificacoes", {});
  esc.aoAvisarHumano((aviso) => {
    const c = cfg();
    if (!c.ntfyTopico) return;
    void enviar(c, aviso.titulo, aviso.texto, aviso.urgente ? "high" : "default");
  });
}
