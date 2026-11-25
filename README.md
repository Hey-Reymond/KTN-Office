# KTN Office

Um escritório onde IAs (Claude, Gemini, Codex…) trabalham juntas: dividem tarefas,
trocam mensagens, compartilham notas e enxergam o uso de cada uma pra economizar tokens.

Feito pela **KTN Dev**.

## Status

**Fase 1 – servidor MCP "Escritório"** ✅
As IAs se conectam ao mesmo servidor e ganham ferramentas da equipe.
Nesta fase você ainda "cutuca" cada IA manualmente; o runner automático vem na fase 2.

**Fase 2 – equipe (em andamento)**
- ✅ Detecção automática dos CLIs (instalado, versão, login, conectado ao escritório)
- ✅ Instalação automática (com confirmação) ou adição manual
- ✅ Conexão automática ao escritório (Claude e Gemini)
- ✅ Interface de funcionário (`CliAgent`; `ApiAgent` reservado)
- ⏳ Runner que acorda quem tem tarefa
- ⏳ Gerente que distribui tarefas

## Gerenciar a equipe

```bash
cd server
npm run equipe                          # detecta os CLIs
npm run equipe -- instalar antigravity  # instala (mostra o comando e pede confirmação)
npm run equipe -- conectar antigravity  # liga o CLI ao escritório
npm run equipe -- caminho claude "C:\tools\claude.cmd"   # CLI instalado em outro lugar
npm run equipe -- adicionar             # cadastra um CLI novo (perguntas)
```

Exemplo:
```
Claude Code    ✅ 2.1.332 (Claude Code)   ✅ logado       ⚠️ conectar
Antigravity    ✅ 1.5.17                  ✅ logado       ⚠️ conectar
```

- CLIs conhecidos ficam em `agents/clis.json`; os seus (caminhos, CLIs novos) em `agents/clis.custom.json` (fora do git).
- O login é feito por você, no próprio CLI. O KTN Office nunca lê arquivos de credencial: só confere se a pasta de config existe.
- Antes de mexer em arquivos de configuração (`mcp_config.json`, `settings.json`), é feito um backup (`.bak`).
- Instaladores que não mexem no PATH da janela atual (ex.: Antigravity) são achados nas pastas padrão deles.
- `GET /equipe` no servidor devolve a mesma detecção em JSON.

## Ferramentas que cada IA ganha

| Ferramenta | Pra quê |
|---|---|
| `criar_tarefa` | Cria/delega uma tarefa (`para: "gemini"`) |
| `listar_tarefas` | Vê o quadro |
| `pegar_tarefa` | Assume uma tarefa (atômico, ninguém pega duas vezes) |
| `entregar_tarefa` | Entrega o resultado pra quem pediu |
| `mandar_mensagem` / `ler_caixa` | Conversa direta entre IAs (ou com `humano`) |
| `status_equipe` | Quem está livre/ocupado e uso estimado de tokens |
| `registrar_uso` | Informa tokens gastos e limite do plano |
| `escrever_nota` / `ler_notas` | Memória compartilhada da equipe |
| `quem_sou_eu` | Confere o nome registrado |

## Como rodar

Requisitos: Node.js 20+.

```bash
cd server
npm install
npm start
```

Servidor: `http://127.0.0.1:7777/mcp?agent=<nome>`
Painel rápido (JSON): `http://127.0.0.1:7777/status`

Variáveis opcionais: `KTN_PORT` (porta) e `KTN_DB` (arquivo do banco, padrão `office.db`).

## Conectar as IAs

**Claude Code**
```bash
claude mcp add --transport http office "http://127.0.0.1:7777/mcp?agent=claude"
```

**Antigravity CLI (`agy`)** — em `~/.gemini/config/mcp_config.json`:
```json
{
  "mcpServers": {
    "office": { "serverUrl": "http://127.0.0.1:7777/mcp?agent=antigravity" }
  }
}
```

> O **Gemini CLI** não aceita mais login com conta Google (AI Pro/Ultra) desde 18/06/2026.
> Ele continua no registro como legado (desativado); use o Antigravity CLI.

Ou deixe o KTN Office fazer: `npm run equipe -- conectar claude` / `conectar antigravity`.

Depois, cole o conteúdo de `agents/INSTRUCOES-EQUIPE.md` no `CLAUDE.md` e no `GEMINI.md`
da pasta onde vão trabalhar.

## Primeiro teste

1. No Claude: *"crie uma tarefa pro antigravity: pesquisar como o Antigravity CLI mostra o uso de tokens"*
2. No Antigravity (`agy`): *"leia sua caixa e execute as tarefas pendentes"*
3. No Claude: *"leia sua caixa"* → recebe a entrega.
4. Abra `http://127.0.0.1:7777/status` pra ver o quadro.

## Testes

```bash
cd server
npm test        # escritório via MCP + equipe com CLIs falsos
npm run typecheck
```

## Roadmap

- [x] **Fase 1** – servidor MCP com tarefas, mensagens, uso e notas
- [ ] **Fase 2** – ✅ detecção/instalação/conexão dos CLIs + interface de funcionário · ⏳ runner que acorda quem tem tarefa + gerente que distribui
- [ ] **Fase 3** – medição automática de uso (ex.: `claude -p --output-format json`) e economia
- [ ] **Fase 4** – app desktop: chat com o gerente, painel do escritório, conversa da equipe

## Estrutura

```
server/src/index.ts   servidor HTTP MCP (127.0.0.1)
server/src/tools.ts   ferramentas expostas às IAs
server/src/db.ts      regras do escritório + SQLite
server/src/equipe/    detecção, instalação, conexão e funcionários (CliAgent/ApiAgent)
server/test/          testes (smoke: escritório; equipe: CLIs falsos, sem gastar tokens)
agents/clis.json      CLIs conhecidos e especialidades
agents/INSTRUCOES-EQUIPE.md  regras pra colar no CLAUDE.md / GEMINI.md
```
