import type { ChildProcess } from "node:child_process";
import spawn from "cross-spawn";

export interface SaidaProcesso {
  codigo: number | null;
  stdout: string;
  stderr: string;
  estourouTempo: boolean;
  cancelado?: boolean;
}

/** Encerra o processo e todos os filhos (Windows usa taskkill /T; Linux/macOS mata o grupo de processos). */
export function encerrarArvore(filho: ChildProcess, grupoProprio: boolean) {
  const pid = filho.pid;
  if (!pid) {
    try { filho.kill(); } catch { /* já saiu */ }
    return;
  }
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } catch { /* fallback abaixo */ }
    try { filho.kill(); } catch { /* já saiu */ }
    return;
  }
  if (grupoProprio) {
    try { process.kill(-pid, "SIGTERM"); } catch { /* grupo pode não existir mais */ }
  }
  try { filho.kill("SIGTERM"); } catch { /* já saiu */ }
  setTimeout(() => {
    if (grupoProprio) {
      try { process.kill(-pid, "SIGKILL"); } catch { /* já saiu */ }
    }
    try { filho.kill("SIGKILL"); } catch { /* já saiu */ }
  }, 1500).unref();
}

/**
 * Roda um programa sem shell (seguro contra injeção). cross-spawn cuida dos
 * executáveis .cmd do Windows (npm instala os CLIs assim).
 */
export function rodar(
  comando: string,
  args: string[],
  opcoes: {
    timeoutMs?: number;
    cwd?: string;
    aoReceber?: (trecho: string) => void;
    entrada?: string;
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<SaidaProcesso> {
  return new Promise((resolve) => {
    if (opcoes.signal?.aborted) {
      resolve({ codigo: null, stdout: "", stderr: "Cancelado.", estourouTempo: false, cancelado: true });
      return;
    }
    let stdout = "";
    let stderr = "";
    let estourouTempo = false;
    let cancelado = false;
    const grupoProprio = process.platform !== "win32" && !!opcoes.signal;
    let filho: ChildProcess;
    try {
      filho = spawn(comando, args, {
        cwd: opcoes.cwd,
        env: opcoes.env,
        detached: grupoProprio,
        stdio: [opcoes.entrada === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ codigo: null, stdout: "", stderr: String(e), estourouTempo: false });
      return;
    }
    if (opcoes.entrada !== undefined) filho.stdin?.end(opcoes.entrada);
    const aoCancelar = () => {
      cancelado = true;
      encerrarArvore(filho, grupoProprio);
    };
    opcoes.signal?.addEventListener("abort", aoCancelar, { once: true });
    const timer = opcoes.timeoutMs
      ? setTimeout(() => {
          estourouTempo = true;
          encerrarArvore(filho, grupoProprio);
        }, opcoes.timeoutMs)
      : undefined;
    filho.stdout?.on("data", (d: Buffer) => {
      stdout += d;
      opcoes.aoReceber?.(String(d));
    });
    filho.stderr?.on("data", (d: Buffer) => {
      stderr += d;
      opcoes.aoReceber?.(String(d));
    });
    filho.on("error", (e: Error) => {
      stderr += e.message;
    });
    filho.on("close", (codigo: number | null) => {
      if (timer) clearTimeout(timer);
      opcoes.signal?.removeEventListener("abort", aoCancelar);
      resolve({ codigo, stdout, stderr, estourouTempo, ...(cancelado ? { cancelado: true } : {}) });
    });
  });
}
