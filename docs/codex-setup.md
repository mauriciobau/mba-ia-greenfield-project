# Fundação Codex

Este documento descreve como conduzir no Codex o workflow de IA do desafio da Fase 03. Ele registra o ambiente verificado em 2026-10-29 e separa as instruções reprodutíveis das integrações que não estão configuradas. Nenhum MCP externo é instalado ou configurado por este documento.

## Estado verificado neste ambiente

| Item | Estado observado |
| --- | --- |
| Codex CLI | `codex-cli 0.165.0`, disponível em `/usr/bin/codex` |
| RTK | `rtk 0.43.0` |
| Context7 MCP | Ativo em Codex como servidor `context7`, transporte HTTP streamable, endpoint `https://mcp.context7.com/mcp`; `codex mcp get context7` confirma configuração. O cabeçalho de autorização foi mascarado durante a inspeção e não é reproduzido aqui. |
| Postgres MCP | Não aparece em `codex mcp list`; portanto não está configurado para esta instalação do Codex. |
| PostgreSQL no Docker | O serviço `db` foi verificado como saudável com um override local que remove a publicação da porta, pois a porta 5432 do host estava ocupada por outro projeto. O Compose padrão publica `5432:5432`. |

Comandos usados para conferir a instalação e integrações:

```sh
rtk --version
rtk which codex
rtk proxy codex --version
rtk proxy codex mcp list
rtk proxy codex mcp get context7
```

O prefixo `rtk` segue a regra local em `/home/bau/.codex/RTK.md`. Os comandos `codex mcp ...` abaixo são exemplos para o ambiente de quem os executar; este documento não os executou para adicionar ou remover servidores.

## Instruções, skills e subagentes

| Fundação do Claude Code | Caminho no Codex |
| --- | --- |
| `CLAUDE.md` | `AGENTS.md`. Codex lê instruções `AGENTS.md` do escopo global e do caminho entre a raiz Git e o diretório atual. Este repositório já tem instruções na raiz e em subprojetos. |
| Skills em `.agents/skills/*/SKILL.md` | Skills são diretórios de instruções com um `SKILL.md`. O Codex CLI oferece suporte a skills; peça a skill pelo nome (por exemplo, `/research phase 03`) e confirme que o fluxo descrito consegue usar as ferramentas disponíveis. As skills existentes contêm referências a ferramentas Claude; adapte essas etapas ao Codex e mantenha a sequência e os artefatos definidos pelo projeto. |
| Agentes de leitura em `.agents/agents/*.md` | São instruções reutilizáveis, mas não registros automáticos de papéis Codex. Quando delegação for autorizada e adequada, solicite subagentes com tarefas independentes e forneça ao agente o arquivo Markdown relevante. Também é possível converter papéis para a configuração nativa TOML em `.codex/agents/`, mas isso requer uma migração explícita; não foi criada nesta entrega. |
| `.agents/rules/*.md` | Não são carregadas automaticamente como instruções por nome de arquivo. `AGENTS.md` orienta a leitura das regras aplicáveis antes de modificar os arquivos cobertos. |
| `.claude/settings.json`, hooks e `.mcp.json` | São configurações do Claude Code e não configuram o Codex CLI. MCPs do Codex são configurados na instalação do Codex, normalmente em `~/.codex/config.toml`, pela CLI `codex mcp`. |
| Comandos `/research`, `/plan-context` etc. | Correspondem ao workflow e às skills do projeto, não a slash commands Claude executáveis automaticamente no Codex. Peça a skill pelo nome ou conduza manualmente as etapas, produzindo os mesmos artefatos e respeitando as dependências do pipeline. |

Para a Fase 03, a ordem exigida pelo desafio continua sendo `research → plan-context → plan-validate → plan-resolve → plan-build → plan-test-specs` (opcional) `→ implement`. Os arquivos da fase e os critérios de aceite permanecem o contrato de saída independentemente da ferramenta. Antes de começar uma etapa, verifique o `SKILL.md` correspondente e confirme que cada ferramenta, subagente ou integração invocada está disponível; substitua apenas o mecanismo de execução, não pule a etapa nem seus artefatos.

O Codex CLI suporta delegação a subagentes. Solicite delegação explicitamente para trabalho independente de leitura, revisão ou investigação; agentes que escrevem nos mesmos arquivos precisam de coordenação. Arquivos Markdown sob `.agents/agents/` não viram papéis personalizados automaticamente. A definição nativa de papéis do Codex usa TOML sob `.codex/agents/` e deve ser configurada separadamente.

## Context7 MCP

Context7 está configurado nesta instalação, conforme a verificação acima. Em outra instalação Codex, consulte as instruções atuais do Context7 para escolher o transporte, autenticação e endpoint adequados. A documentação oficial do Codex mostra a sintaxe da CLI e confirma que `codex mcp list` lista os servidores configurados. Para uma instalação stdio baseada em `npx`, a forma documentada é:

```sh
codex mcp add context7 -- npx -y @upstash/context7-mcp
codex mcp list
```

Não execute o comando `add` se Context7 já estiver configurado. A configuração observada aqui usa transporte HTTP e um cabeçalho de autorização; não copie credenciais para arquivos versionados, prompts ou histórico do shell. Use `codex mcp get context7` para inspecionar o registro sem expor o valor do cabeçalho.

## Postgres MCP

O servidor `postgres` não está configurado no Codex deste ambiente. O arquivo `.mcp.json` existente pertence à convenção do Claude Code; sua presença não ativa o MCP no Codex. Não interprete a configuração do Compose como evidência de que o banco está no ar.

O Compose do backend expõe a porta `5432` no host. Se, futuramente, o processo stdio do MCP for iniciado pelo Codex CLI no host, use o endereço do host publicado (`127.0.0.1:5432`) na URL de conexão. Se o servidor MCP for executado como container na mesma rede Compose, use `db:5432`. `db` é resolução interna da rede Docker e normalmente não resolve em um processo executado diretamente no host; `localhost`/`127.0.0.1` só serve para acessar a porta publicada no próprio host. Confirme que o serviço `db` está saudável antes de conectar.

O projeto já usa o pacote `@modelcontextprotocol/server-postgres` como servidor stdio no `.mcp.json`, passando a URL PostgreSQL como argumento. A CLI Codex aceita servidores stdio. Para evitar gravar a senha em `~/.codex/config.toml`, prefira uma variável local `DATABASE_URL` fornecida pelo gerenciador de segredos ou pelo ambiente de inicialização do Codex e use uma configuração local privada, fora do repositório:

```toml
[mcp_servers.postgres]
command = "sh"
args = ["-c", "exec npx -y @modelcontextprotocol/server-postgres \"$DATABASE_URL\""]
env_vars = ["DATABASE_URL"]
```

Defina `DATABASE_URL` no ambiente local antes de iniciar o Codex, com o usuário, senha e banco locais. Para o Codex rodando no host, a URL deve apontar para a porta publicada no host; para um servidor MCP dentro da rede Compose, ela deve apontar para `db:5432`. Não coloque uma URL com senha em `AGENTS.md`, `.mcp.json`, `compose.yaml`, exemplos versionados ou histórico de comandos. Essa configuração é apenas uma referência: este setup não foi aplicado nem validado e o override usado nesta máquina não publica a porta do banco no host.

Depois de configurar um servidor deliberadamente, valide com:

```sh
codex mcp get postgres
codex mcp list
```

## Referências oficiais

- [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
- [Instruções `AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Subagentes Codex](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- [MCP no Codex](https://learn.chatgpt.com/docs/extend/mcp)
- [Skills e o formato `SKILL.md`](https://developers.openai.com/api/docs/guides/tools-skills)
