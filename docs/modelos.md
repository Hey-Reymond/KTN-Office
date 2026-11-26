# Guia de modelos do KTN Office

Pesquisa de novembro/2026. Preços e planos mudam: confira as fontes antes de decidir.
O catálogo usado pelo escritório fica em `agents/clis.json` → `modelos`.

## Política padrão do escritório

| Situação | Claude | Antigravity | Codex (ChatGPT) |
|---|---|---|---|
| **Padrão** | opus | neon | sol |
| Difícil | opus → fable (se tiver) | carbon | astra |
| Muito básico | haiku | hydrogen | luna |
| Economizar em tarefas médias | sonnet | — | terra |

Modelos marcados como `opcional` (ex.: fable) ficam desligados até você ligar:
`npm run equipe -- modelo claude fable on`. Qualquer modelo pode ser desligado com `off`.

## Claude (Anthropic) — via Claude Code

- **Fable 5.2** — o mais capaz da linha pública; recomendado só para o trabalho mais difícil e aberto,
  quando o Opus em esforço alto não basta. Custa o dobro do Opus. Em alguns planos pago usa créditos extras.
- **Opus 5.5** — recomendação da Anthropic para começar na maior parte do trabalho de código; é o padrão do
  Claude Code nos planos pagos.
- **Sonnet 5.5** — metade do preço do Opus, desempenho próximo; bom para economizar.
- **Haiku 5.5** — muito mais barato; para volume alto e tarefas simples.
- No plano, o uso é um pool só (claude.ai, app e Claude Code) com janela de 5h e limite semanal.

## Gemini 4 (Google) — via Antigravity CLI (`agy`)

O Gemini CLI parou de aceitar login Google para AI Pro/Ultra em 18/06/2026; o substituto é o Antigravity CLI.

- **Carbon** — o mais forte para raciocínio difícil e longo; o mais caro.
- **Neon** — intermediário lançado em 18/11/2026, derivado do Carbon, com desempenho próximo e ~3x mais rápido.
  Substituiu o Argon no seletor do app. **Padrão do escritório.**
- **Hydrogen** — rápido e barato, para o dia a dia simples; único com camada gratuita na API.
- **Argon** — primeiro da família (out/2026); ficou para trás com a chegada do Neon.
- Todos compartilham janela de contexto de ~1M tokens.

## GPT-6 (OpenAI) — via Codex CLI

- **GPT-6.2 Astra** — para os projetos mais difíceis.
- **GPT-6.2 Sol** — uso diário de código e escrita; segundo a OpenAI, chega perto do Astra com custo bem menor.
- **GPT-6.1 Terra** — rápido e eficiente para trabalho profissional.
- **GPT-6 Luna** — o mais barato; Free/Go têm acesso a ele no app.
- Plus, Pro, Business, Enterprise e Edu têm Astra e Sol no Codex.
- Escolha no CLI: `codex -m <id>` ou `/model`.

## Fontes

- Anthropic / comparativos: https://smartscope.blog/en/blog/claude-fable-5-2-vs-opus-5-5-2026/ ·
  https://www.toolcolumn.com/learn/claude-opus-5-5-vs-fable-5-2-vs-sonnet-5-5 ·
  https://tech-insider.org/claude-opus-vs-sonnet-vs-haiku-5-5-2026/
- Gemini 4: https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-neon/ ·
  https://9to5google.com/2026/11/18/gemini-4-neon/ ·
  https://www.toolcolumn.com/learn/gemini-4-hydrogen-vs-carbon-vs-argon
- Fim do Gemini CLI no AI Pro: https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals
- OpenAI: https://learn.chatgpt.com/docs/whats-new/gpt-62-astra-sol · https://9to5mac.com/?p=1080945
