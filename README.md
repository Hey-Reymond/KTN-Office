# KTN Office

Um escritório onde IAs (Claude, Gemini, Codex…) trabalham juntas: dividem tarefas,
trocam mensagens, compartilham notas e enxergam o uso de cada uma pra economizar tokens.

Feito pela **KTN Dev**.

## Status

**Fase 1 – servidor MCP "Escritório"** ✅
As IAs se conectam ao mesmo servidor e ganham ferramentas da equipe.
Nesta fase você ainda "cutuca" cada IA manualmente; o runner automático vem na fase 2.

**Fase 2 – equipe** ✅
- ✅ Detecção automática dos CLIs (instalado, versão, login, conectado ao escritório)
- ✅ Instalação automática (com confirmação) ou adição manual
- ✅ Conexão automática ao escritório (Claude e Gemini)
- ✅ Interface de funcionário (`CliAgent`; `ApiAgent` reservado)
- ✅ Expediente (runner): IAs acordam e trabalham sozinhas
- ✅ Coordenadora distribui tarefas e escolhe modelos
- ✅ Detecção automática de modelos + caixinhas
- ✅ Interface web

## Interface (recomendado)

Com o servidor ligado (`npm start`), abra **http://127.0.0.1:7777/**. A tela segue o jeito do Claude Desktop:

- **Esquerda:** seus chats e, no canto de baixo, **⚙️ Configurações** (equipe e modelos, expediente, quadro de tarefas e bastidores).
- **Centro:** a conversa com a coordenadora, com respostas formatadas e a barra do projeto em andamento.
- **Direita:** painel **Atividade** (dá pra esconder): o que cada IA está fazendo agora, os projetos do chat e a memória dele.

Detalhes:

- **Chats** (barra lateral, como no Claude Desktop): crie, renomeie (✏️) e apague (🗑️) conversas por assunto.
- **Chat com a coordenadora**: você pede, ela divide o trabalho com a equipe e te responde ali.
- **🧠 Memória de cada chat**: um arquivo `memoria.md` no seu PC (`~/KTN-Office-dados/conversas/<id>/`).
  As IAs anotam decisões e preferências ali e leem quando precisam (`ler_memoria`, `historico_conversa`).
  Você pode editar pela interface ou no Bloco de Notas. Apagar o chat apaga a memória dele.
- **Expediente** (chave no topo): ligado = as IAs acordam sozinhas quando têm tarefa ou mensagem.
- **Equipe e modelos**: status de cada CLI, botão *Conectar* e uma caixinha por modelo.
  *Testar modelos* descobre o que o seu plano libera; o que responder fica marcado, e você desmarca o que não quiser.
- **Quadro de tarefas**, **conversa da equipe** e **linha do tempo** do que cada IA fez.

### Projetos: dividir → fazer → merge
Quando você pede algo grande no chat, a coordenadora:
1. abre um projeto (`criar_projeto`) e vê quem está na equipe;
2. divide em **uma parte para cada IA da equipe, inclusive ela mesma** (`distribuir_projeto`),
   dando a cada uma a parte em que é melhor e o modelo certo; o escritório recusa a divisão se alguém ficar sem parte;
3. todas trabalham em paralelo; quando a última parte é entregue, o escritório avisa a coordenadora;
4. ela junta tudo com a própria parte (`status_projeto` → merge) e entrega pra você (`concluir_projeto`).

Na interface, a chave **na equipe** em cada IA define quem entra na divisão.

### Pasta do projeto e git
No topo do chat, o botão 📁 define em que pasta as IAs trabalham naquele chat.
Se a pasta for um **repositório git**, cada parte de um projeto roda numa **cópia própria** (git worktree,
branch `ktn/projN-ia-tN`). Assim as IAs editam ao mesmo tempo sem atrapalhar umas às outras:
1. ao entregar, o escritório faz o commit da parte (a IA não precisa de permissão de git);
2. quando todas terminam, as branches são juntadas em `ktn/projN`, numa cópia separada;
3. a coordenadora revisa e resolve conflitos ali e conclui;
4. você clica em **Aplicar no meu projeto** (git merge na sua branch atual). Seu projeto nunca muda antes disso.
**Limpar cópias** remove as pastas temporárias (as branches ficam).

### Mais CLIs
Além de Claude Code, Antigravity e Codex, o Office reconhece:

| CLI | Instalar | Login | Observação |
|---|---|---|---|
| GitHub Copilot CLI | `npm i -g @github/copilot` | `copilot` → `/login` | grátis com GitHub Student (Copilot Pro) |
| Qwen Code | `npm i -g @qwen-code/qwen-code` | `qwen` → Qwen OAuth | cota grátis diária |
| OpenCode | `npm i -g opencode-ai` | `opencode auth login` | usa qualquer provedor, até modelos locais |
| Kimi Code CLI | `npm i -g @moonshot-ai/kimi-code` | `kimi` → `/login` | no Windows precisa do Git for Windows |

Depois de instalar: `npm run equipe -- conectar <id>` (ou o botão na interface).
OpenCode e Kimi aprovam ferramentas sozinhos no modo sem interação, e a interface avisa isso.

### IAs por API (chave própria ou local)
Em Configurações → Equipe → **Adicionar IA por API**: escolha o provedor, cole a chave (se precisar),
clique em **Buscar modelos**, marque os que quer e coloque na equipe. Ela trabalha igual às outras:
pega tarefas, conversa pelo escritório e lê/escreve arquivos **só dentro da pasta do trabalho**
(escrever só com permissão de edição; comandos no terminal, não).

| Provedor | Precisa de chave | Observação |
|---|---|---|
| Ollama / LM Studio | não | roda no seu PC, grátis |
| OpenRouter | sim | uma chave, centenas de modelos (alguns grátis) |
| Gemini API, Groq | sim | têm cota grátis |
| OpenAI, Anthropic, DeepSeek, Mistral | sim | cobrado por uso |
| Outro | opcional | qualquer servidor compatível com OpenAI |

As chaves ficam em `~/KTN-Office-dados/chaves-api.json`, fora da pasta do projeto (nunca vão pro git).

### Controle da tela (opcional, Windows)
Em Configurações → Ferramentas → **Controle da tela**: uma IA por vez (tipo Claude Code) vê a tela e usa
mouse e teclado nos programas do Windows, pelo [Windows-MCP](https://github.com/CursorTouch/Windows-MCP) (código aberto).
- Vem **desligado**; precisa do `uv` (botão "Instalar o uv").
- **Toda ação pede permissão**; "Sempre permitir" não vale para ele.
- Só aparece para a IA escolhida; as outras não recebem.

### Aparência
Configurações → Aparência: **Automático** (segue o tema claro/escuro do Windows e muda junto), Claro ou Escuro.

### Receitas
Pedidos prontos que já dizem como dividir o trabalho: Revisar código, Nova funcionalidade, Corrigir bug,
Pesquisar e comparar, Documentar projeto e Estudar para prova. Ficam na tela inicial e no ícone de prancheta
do chat; o texto entre «» já vem selecionado para você completar. Crie as suas em Configurações → Receitas
(ou "Salvar o texto atual como receita"). As suas ficam em `~/KTN-Office-dados/receitas.json`.

### Agenda
Aba **Agenda** no painel da direita, ou peça no chat ("todo dia às 9h resuma os commits"):
todo dia, dias da semana, a cada X minutos (mínimo 15) ou uma vez. Na hora, o pedido entra no chat
e a coordenadora trata como se fosse você pedindo. Só roda com o Office aberto e o expediente ligado.

### Notificações
- **No PC:** em Configurações → Expediente, ligue "Avisar nesta tela". Respostas, projetos concluídos e pedidos de permissão viram notificação do sistema quando você está em outra janela. A aba mostra `(N)` quando há permissão esperando.
- **No celular:** instale o app **ntfy**, assine um tópico difícil de adivinhar e coloque o mesmo tópico no Office. Pedidos de permissão chegam com prioridade alta.

### Cota real
- O Office lê a cota que o CLI informa na saída (Codex e Claude mostram % usado e quando renova).
- Se a IA bater no limite do plano, ela fica **sem cota** até renovar (lê "try again in 2 hours" e afins). Isso não conta como falha: você é avisado e a coordenadora repassa as tarefas dela.
- Para CLIs que não informam, coloque um limite de tokens por 5h em Configurações → Equipe, e o Office estima.
- No `status_equipe`, a coordenadora vê `cota.situacao` (ok / baixa / sem_cota). Quem está baixa recebe partes menores; quem está sem cota fica fora da divisão.

### Anexos
Arraste, cole (Ctrl+V) ou use o 📎 no chat: até 10 arquivos de 20 MB. Eles são salvos em
`<pasta do chat>/.ktn-anexos/` (fora do git) e o caminho vai na mensagem, para as IAs abrirem.

### Revisão cruzada
Cada parte de projeto que muda arquivos é revisada por **outra IA** (de preferência uma boa em revisão)
na mesma cópia do autor, antes do merge. O revisor corrige o que for pequeno e responde APROVADO ou PRECISA AJUSTE;
a revisão vai junto no resultado da parte. Liga/desliga em Configurações → Expediente.

### Ferramentas (navegador)
Em **Configurações → Ferramentas** você liga, em todas as IAs de uma vez:
- **Navegador (Playwright)**: abrir sites, clicar, preencher, tirar print. Funciona com Brave, Chrome, Edge ou Firefox
  (o Firefox usa a versão de automação do Playwright; clique em *Preparar Firefox* uma vez).
- **Chrome DevTools**: console, rede e desempenho. Só navegadores Chromium (Brave, Chrome, Edge).

O navegador abre com um perfil separado, sem as suas senhas. "Usar sem pedir permissão" libera as ações dessa
ferramenta; desligado, cada ação passa pelo aviso de permissão.

### Permissões
Cada IA tem um nível (Configurações → Equipe e modelos → Permissões):

| Nível | O que a IA pode fazer sem perguntar |
|---|---|
| **Ler e pesquisar** (padrão) | ler arquivos, buscar na web, usar o escritório |
| **Editar arquivos** | + criar e alterar arquivos na pasta de trabalho |
| **Rodar comandos** | + rodar comandos no seu PC |

O que passar do nível vira um **aviso na tela**: *"Claude quer criar ou sobrescrever um arquivo"* com o arquivo
ou comando exato e os botões **Negar / Permitir uma vez / Sempre permitir**.
- **Claude**: espera a sua resposta e continua de onde parou (via `--permission-prompt-tool`). Sem resposta em 5 min, conta como negado.
- **Antigravity e Codex**: param, deixam o pedido e são acordados com a sua resposta.
- "Sempre permitir" guarda a ferramenta (Claude) ou sobe o nível (outras IAs); dá pra desfazer nas Configurações.

### Como o expediente funciona
A cada poucos segundos o escritório olha quem tem tarefa aberta ou mensagem não lida e roda o CLI dessa IA
(`claude -p`, `agy -p`…) com o modelo escolhido na tarefa. Travas: no máximo N execuções por IA por hora,
tarefa cancelada (e você avisado) se a IA não assumir depois de 2 tentativas. As IAs trabalham na
*pasta de trabalho* configurável (padrão `~/KTN-Office-trabalho`).

> No modo automático o CLI não consegue pedir permissão a você: ferramentas do office já são liberadas
> pelo *Conectar*; editar arquivos ou rodar comandos depende das permissões que você der no próprio CLI.

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
- `conectar` também libera **só as ferramentas do office** (Claude: `mcp__office`; Antigravity: `mcp(office/*)`), pra não pedir confirmação a cada chamada. Use `--sem-liberar` pra aprovar na mão.
- Antes de mexer em arquivos de configuração (`mcp_config.json`, `settings.json`), é feito um backup (`.bak`).
- Instaladores que não mexem no PATH da janela atual (ex.: Antigravity) são achados nas pastas padrão deles.
- `GET /equipe` no servidor devolve a mesma detecção em JSON.

## Escolha de modelo

A coordenação escolhe o modelo de cada tarefa (`criar_tarefa` com `modelo`).
O catálogo fica em `agents/clis.json` → `modelos`, com apelidos:

| IA | Apelidos |
|---|---|
| Claude | **`opus` (padrão)**, `fable` (opcional, o mais difícil), `sonnet` (economizar), `haiku` (só o muito básico) |
| Antigravity | **`neon` (padrão)**, `carbon` (difícil), `hydrogen` (só o muito básico), `argon` (antigo, evitar) |
| Codex (ChatGPT) | **`sol` (padrão)**, `astra` (difícil), `terra` (rápido), `luna` (só o muito básico) |

Cada um usa o que o próprio plano libera:
```bash
npm run equipe -- modelos                    # ✅ ligados / ⬜ desligados
npm run equipe -- modelo claude fable on     # liga um opcional (ex.: quem tem Fable)
npm run equipe -- modelo antigravity argon off
```
A escolha fica no seu `agents/clis.custom.json`. A IA só vê e só pode pedir modelos ligados.
Guia completo com a pesquisa de cada modelo: [`docs/modelos.md`](docs/modelos.md).

O runner (próxima etapa) roda a tarefa com esse modelo. Confira os ids exatos com `/model` no `agy`.

## Ferramentas que cada IA ganha

| Ferramenta | Pra quê |
|---|---|
| `criar_tarefa` | Cria/delega uma tarefa (`para: "antigravity"`, `modelo: "carbon"`) |
| `modelos_equipe` | Modelos que cada IA pode usar (nível, custo, velocidade, quando usar) |
| `criar_projeto` / `distribuir_projeto` | Coordenadora divide um pedido em uma parte por IA |
| `status_projeto` / `concluir_projeto` | Lê as entregas, faz o merge e entrega pro humano |
| `historico_conversa` / `ler_memoria` / `escrever_memoria` | Contexto de cada chat (histórico e memória no PC) |
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
- [x] **Fase 2** – detecção/instalação/conexão dos CLIs, expediente automático, coordenadora, modelos e interface web
- [ ] **Fase 3** – cota real (agy `/usage --output-format json`, transcript.jsonl), economia e mais CLIs
- [ ] **Fase 3b** – funcionários via API (chaves Anthropic/Google/OpenAI)
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
