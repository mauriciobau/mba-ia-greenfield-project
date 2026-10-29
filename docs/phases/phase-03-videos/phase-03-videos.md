---
kind: phase
name: phase-03-videos
test_specs_aware: true
affected_subprojects: [nestjs-project]
sources_mtime:
  docs/project-plan.md: "2026-07-14T19:23:38.260548142-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-28T21:54:48.402599780-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-14T19:23:38.255159815-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-14T19:23:38.258654204-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-14T19:23:38.259521528-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-14T19:23:38.258764443-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-14T19:23:38.213811389-03:00"
  docs/phases/phase-03-videos/context.md: "2026-10-28T21:54:48.407645402-03:00"
  docs/phases/phase-03-videos/validation.md: "2026-10-28T21:54:56.152746194-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-28T21:58:04.136544863-03:00"
---

# Fase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload retomável de vídeos de até 10.000.000.000 bytes, processamento assíncrono, thumbnail, URL única, streaming e download, com API, storage, fila e worker reais em Docker.

---

## Step Implementations

### SI-03.1 — Preparar infraestrutura e dependências

**Description:** Disponibilizar storage, Redis e ambiente do worker para os fluxos seguintes.

**Technical actions:**

1. Configurar Compose com MinIO construído da release fixada, volume persistente, inicialização do bucket, Redis com AOF e worker separado (per `phase-03-videos/TD-01`, `TD-03`).
2. Registrar versões de partida de BullMQ, AWS SDK e FFmpeg, configuração validada e nomes de serviços; conferir disponibilidade e ajustar com documentação caso necessário.
3. Definir endereço externo assinável, CORS, healthchecks, limites de recursos e readiness das dependências, preservando `db` e demais hosts internos por nome de serviço.

**Tests:** _(empty — Infra)_

**Dependencies:** none.

**Acceptance criteria:**

- Compose constrói e inicia os serviços com volumes persistentes e healthchecks saudáveis.
- Storage e Redis permanecem acessíveis após reinício; o worker possui `ffmpeg` e `ffprobe` funcionais.
- URLs assinadas de teste são acessíveis a um cliente fora da rede Compose, sem reescrever o host assinado.

---

### SI-03.2 — Persistir vídeos e sessões

**Description:** Criar modelo persistente, relações e garantias de unicidade.

**Technical actions:**

1. Criar entidades e migration reversível `Video`, `VideoUpload` e `VideoProcessingOutbox` conforme Data Model e relação com canal (per `phase-03-videos/TD-02`, `TD-04`, `TD-07`).
2. Implementar persistência transacional, geração de `public_id` com constraint única e repetição em colisão, e transições condicionais.
3. Registrar módulos e providers com TypeORM e configuração existente, sem `synchronize`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Migration e entidades | Integration: FK, constraints e rollback | `src/database/videos-migrations.integration-spec.ts` |
| Persistência de vídeos | Integration: colisão, transação e concorrência | `src/videos/videos.persistence.integration-spec.ts` |
| VideosModule | Unit: compilação DI | `src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.1 — banco disponível e ambiente preparado.

**Acceptance criteria:**

- Migration cria e reverte as tabelas e a relação com canal sem alterar registros existentes.
- Banco rejeita `public_id` duplicado e canal inexistente; colisão na geração produz outro identificador.
- Gravação de estado e outbox é atômica; uma transição concorrente incompatível não substitui a vencedora.

---

### SI-03.3 — Iniciar upload e criar rascunho

**Route:** POST /videos/uploads

**Test Specs:** see `nestjs-project/specs/videos-upload-init.plan.md`

**Description:** Criar vídeo do canal autenticado e iniciar sessão multipart sem transferir bytes pela API.

**Technical actions:**

1. Criar adapter S3 e serviço de início com tratamento de falhas parciais e limpeza de sessão órfã (per `phase-03-videos/TD-01`, `TD-02`).
2. Implementar `POST /videos/uploads` conforme API Contracts, incluindo limite de 10.000.000.000 bytes e vínculo ao canal autenticado.
3. Documentar DTOs, respostas e erros em OpenAPI; validar serviços e injeção.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Serviço de início | Unit: limite e falhas parciais | `src/videos/upload-init.service.spec.ts` |
| Adapter S3 | Integration: multipart real e limpeza | `src/videos/storage.integration-spec.ts` |

**Dependencies:** SI-03.1, SI-03.2.

**Acceptance criteria:**

- `POST /videos/uploads` autenticado com tamanho válido retorna `201`, identificadores e `status: draft`, associado ao canal correto.
- Tamanho acima de 10.000.000.000 bytes retorna `413 VIDEO_UPLOAD_TOO_LARGE`; não há sessão ativa remanescente.
- Usuário não autenticado recebe `401`; falha de storage não deixa sessão órfã permanente.

---

### SI-03.4 — Retomar upload por partes

**Route:** GET /videos/uploads/{uploadId}

**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`

**Description:** Permitir consultar partes e assinar envios diretos limitados à sessão do proprietário.

**Technical actions:**

1. Implementar `GET /videos/uploads/{uploadId}` com paginação das partes reais do storage (per `phase-03-videos/TD-02`).
2. Implementar `POST /videos/uploads/{uploadId}/part-urls`, limites de lote, numeração, expiração e autorização.
3. Configurar CORS, host público assinável e leitura do ETag; atualizar OpenAPI.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Gestão de sessão | Unit: números, estado e proprietário | `src/videos/upload-parts.service.spec.ts` |
| Multipart | Integration: MinIO real, paginação e retomada | `src/videos/upload-parts.integration-spec.ts` |

**Dependencies:** SI-03.3.

**Acceptance criteria:**

- Cliente envia partes diretamente ao storage e retoma consultando as partes já recebidas após interrupção.
- Requisição de parte fora da sessão é rejeitada e usuário não proprietário recebe `404`.
- URLs expiradas podem ser renovadas por proprietário enquanto a sessão estiver ativa.

---

### SI-03.5 — Finalizar upload e registrar processamento

**Route:** POST /videos/uploads/{uploadId}/complete

**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`

**Description:** Finalizar ou abortar a sessão e registrar a intenção durável de processar.

**Technical actions:**

1. Implementar `POST /videos/uploads/{uploadId}/complete` e `DELETE /videos/uploads/{uploadId}` conforme API Contracts (per `phase-03-videos/TD-02`, `TD-04`).
2. Validar partes, ETags e tamanho real, conferir objeto concluído e tratar concorrência, repetição e limpeza; limitar armazenamento temporário indevido.
3. Gravar `processing` e outbox na mesma transação; reconciliar falhas entre finalização S3 e gravação no banco.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Finalização | Unit: estados e limites | `src/videos/upload-completion.service.spec.ts` |
| Finalização e banco | Integration: MinIO, transação e falhas | `src/videos/upload-completion.integration-spec.ts` |

**Dependencies:** SI-03.4.

**Acceptance criteria:**

- Finalização válida retorna `202` e registra `processing` e intenção persistente uma única vez.
- Partes ausentes, alteradas ou com tamanho excedente são rejeitadas sem disponibilizar vídeo.
- Repetições e concorrência entre abortar e finalizar não geram estado contraditório; falha parcial é recuperável.

---

### SI-03.6 — Processar vídeo em worker

**Description:** Publicar e consumir trabalho durável, validar mídia e gerar thumbnail.

**Technical actions:**

1. Implementar publicador outbox e reconciliação periódica de eventos pendentes e trabalhos perdidos após confirmação do Redis (per `phase-03-videos/TD-03`, `TD-04`).
2. Consumir `video.process.requested` no worker com tentativas limitadas, backoff, idempotência e proteção por geração.
3. Inspecionar MP4/H.264/AAC opcional com ffprobe, extrair thumbnail via FFmpeg e persistir duração e metadados; limitar disco, memória, tempo e concorrência (per `phase-03-videos/TD-05`).
4. Atualizar `ready` somente após salvar thumbnail; marcar `error` após erro definitivo e limpar recursos temporários.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Worker | Unit: formatos, falhas e idempotência | `src/videos/video-worker.spec.ts` |
| Fila e reconciliação | Integration: Redis/PostgreSQL reais, duplicatas e perda | `src/videos/video-queue.integration-spec.ts` |
| Processamento | Integration: MinIO e FFmpeg reais | `src/videos/video-processing.integration-spec.ts` |

**Dependencies:** SI-03.5.

**Acceptance criteria:**

- Upload válido gera metadados e thumbnail e muda `processing` para `ready`.
- Arquivo incompatível ou falha permanente muda status para `error` sem publicar thumbnail inválida.
- Trabalho duplicado, reinício do worker e perda de job após publicação não impedem convergência para um resultado consistente.

---

### SI-03.7 — Disponibilizar consulta, streaming e download

**Route:** GET /videos/{publicId}

**Test Specs:** see `nestjs-project/specs/videos-access.plan.md`

**Description:** Expor status e URLs temporárias de leitura para o proprietário.

**Technical actions:**

1. Implementar `GET /videos/{publicId}`, `POST /videos/{publicId}/playback-url` e `POST /videos/{publicId}/download-url` conforme API Contracts e Authorization Matrix (per `phase-03-videos/TD-06`, `TD-07`).
2. Assinar leitura e download com expiração e disposição adequada; bloquear acesso a vídeo não pronto e não expor credenciais em logs.
3. Atualizar OpenAPI e validar respostas parciais do storage e renovação das URLs.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Serviço de acesso | Unit: propriedade, estado e expiração | `src/videos/video-access.service.spec.ts` |
| Streaming e download | Integration: MinIO real e HTTP Range | `src/videos/video-access.integration-spec.ts` |

**Dependencies:** SI-03.6.

**Acceptance criteria:**

- Proprietário consulta o estado; anônimo recebe `401` e terceiro recebe `404`.
- Vídeo `ready` produz URL de reprodução com `206` e `Content-Range` para intervalo válido; download retorna conteúdo e disposição apropriada.
- Vídeo não pronto retorna `409 VIDEO_NOT_READY`; URL expirada pode ser renovada pelo proprietário.

---

### SI-03.8 — Validar aceite e documentar execução

**Description:** Conferir os requisitos completos, operação e documentação da fase.

**Technical actions:**

1. Executar jornada completa com serviços reais, retomada, falhas, 10 GB e um byte acima do limite, observando memória da API e registrando evidências reproduzíveis.
2. Atualizar `AGENTS.md` raiz e `nestjs-project/AGENTS.md` com serviços, fluxo, comandos e limites implementados; atualizar `progress.md` e documentação operacional (per `phase-03-videos/TD-01` a `TD-07`).
3. Executar suítes completas, `tsc`, lint e revisar os critérios de aceite de `requisitos.md` e Git Flow.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Jornada real | Integration: falhas e serviços reais | `test/video-pipeline.integration-spec.ts` |

**Dependencies:** SI-03.7.

**Acceptance criteria:**

- Upload real de 10.000.000.000 bytes termina e é processado sem memória da API proporcional ao arquivo; arquivo maior é rejeitado.
- Reprodução parcial, download, falhas e reinícios funcionam conforme os contratos e há instruções reproduzíveis.
- Suítes, compilação e lint passam; documentação e progresso refletem o código entregue.

---

## Technical Specifications

Os nomes e valores abaixo especificam o contrato proposto para esta fase; devem ser revistos antes da implementação. Sem interface de vídeos nesta fase. `phase-03-videos/TD-01` a `TD-07` são as decisões de origem.

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK gerada |
| channel_id | uuid | FK para `channels.id`, obrigatório |
| public_id | varchar | identificador curto aleatório, `UNIQUE NOT NULL`; repetir geração em colisão |
| status | varchar | `draft`, `processing`, `ready`, `error`; obrigatório |
| object_key | varchar | chave interna única gerada pelo servidor, obrigatória |
| thumbnail_key | varchar | nulo até o processamento terminar |
| size_bytes | bigint | tamanho verificado, até 10.000.000.000 bytes |
| duration_ms | bigint | nulo até inspeção bem-sucedida |
| metadata | jsonb | metadados selecionados, nulo antes do processamento |
| error_code | varchar | nulo exceto após falha definitiva |
| created_at, updated_at | timestamptz | obrigatórios |

**Relations:** cada vídeo pertence a um canal; um canal possui vários vídeos. **Indexes:** `public_id` e `object_key` únicos; índice em `channel_id`. `ready` significa processamento concluído, não publicação.

#### VideoUpload

| Field | Type | Constraints |
|-------|------|-------------|
| id, video_id | uuid | PK; FK única ao vídeo |
| upload_id | text | identificador multipart do storage, protegido no servidor |
| expected_size_bytes, part_size_bytes | bigint | positivos; tamanho total limitado a 10.000.000.000 bytes |
| state | varchar | `initiated`, `completing`, `completed`, `aborted` |
| expires_at, created_at, updated_at | timestamptz | obrigatórios |

**Invariantes:** uma sessão ativa por vídeo; armazenar sessão e chave para retomada. Reconciliar criação ou finalização no storage se a gravação no banco falhar. Limpar uploads expirados e objetos rejeitados.

#### VideoProcessingOutbox

| Field | Type | Constraints |
|-------|------|-------------|
| id, video_id | uuid | PK; FK ao vídeo |
| generation | integer | identifica tentativa lógica de processamento; único com `video_id` |
| state | varchar | `pending`, `published`; publicação é retomável |
| created_at, updated_at | timestamptz | obrigatórios |

**Invariantes:** transação grava `processing` e intenção de enfileirar; publicação e consumo toleram repetição. Reconciliação também recupera trabalho perdido após confirmação ao Redis. Transições usam controle de concorrência e versão lógica para impedir que execução obsoleta sobrescreva resultado atual.

### API Contracts

Todos os endpoints usam JWT Bearer e escopo do canal do usuário; os exemplos não expõem credenciais do storage. API não recebe bytes de vídeo. O OpenAPI da API é atualizado conforme decisões herdadas de `openapi-docs-nestjs`.

#### POST /videos/uploads (SI-03.3)

**Request headers:** `Content-Type: application/json`, `Authorization: Bearer <token>`.
**Request body:** `{ "sizeBytes": integer, "contentType": "video/mp4" }`; tamanho entre 1 e 10.000.000.000 bytes.
**Response 201:** `{ "videoId": "uuid", "publicId": "string", "status": "draft", "uploadId": "uuid", "partSizeBytes": integer, "expiresAt": "ISO-8601" }`.
**Error responses:** 400 validação; 401 autenticação; 413 tamanho; 503 storage indisponível.

#### GET /videos/uploads/{uploadId} (SI-03.4)

**Request headers:** `Authorization: Bearer <token>`.
**Request query parameters:** cursor opcional para paginação.
**Response 200:** estado, tamanho esperado, tamanho da parte, partes confirmadas `{ partNumber, size, etag }` e próximo cursor. A API pagina o storage e permite retomar a sessão.
**Error responses:** 401, 404 sessão inexistente ou de terceiro, 409 sessão expirada, 503 storage indisponível.

#### POST /videos/uploads/{uploadId}/part-urls (SI-03.4)

**Request body:** `{ "partNumbers": [integer] }`; números distintos e dentro da sessão, em lote limitado.
**Response 200:** `{ "parts": [{ "partNumber": integer, "url": "string", "expiresAt": "ISO-8601" }] }`.
**Error responses:** 400, 401, 404, 409, 503. URLs são temporárias e só autorizam a parte e chave daquela sessão.

#### POST /videos/uploads/{uploadId}/complete (SI-03.5)

**Request body:** vazio. O servidor consulta todas as partes no storage e valida sequência, tamanhos e soma real antes de completar; não confia na lista fornecida pelo cliente.
**Response 202:** `{ "videoId": "uuid", "status": "processing" }`; repetição após sucesso retorna o estado corrente sem duplicar processamento.
**Error responses:** 400 partes inválidas; 401; 404; 409 estado incompatível; 413 tamanho; 503 dependência indisponível.

#### DELETE /videos/uploads/{uploadId} (SI-03.5)

**Response 204:** sessão abortada ou já abortada; partes e recursos temporários são removidos ou agendados para limpeza segura.
**Error responses:** 401, 404, 409 sessão finalizada, 503. Concorrência entre abortar e finalizar deve ter resultado determinístico.

#### GET /videos/{publicId} (SI-03.7)

**Response 200:** `{ "publicId": "string", "status": "draft|processing|ready|error", "sizeBytes": integer|null, "durationMs": integer|null, "metadata": object|null, "errorCode": string|null }`.
**Error responses:** 401; 404 vídeo inexistente ou de terceiro.

#### POST /videos/{publicId}/playback-url (SI-03.7)

**Response 200:** `{ "url": "string", "expiresAt": "ISO-8601" }` para acesso de leitura com suporte a `Range`; chamada repetida renova a URL.
**Error responses:** 401, 404, 409 vídeo não pronto, 503 storage indisponível.

#### POST /videos/{publicId}/download-url (SI-03.7)

**Response 200:** `{ "url": "string", "expiresAt": "ISO-8601" }` para download com `Content-Disposition` apropriado.
**Error responses:** 401, 404, 409 vídeo não pronto, 503 storage indisponível.

#### Validation Rules

- O servidor verifica tamanho e conteúdo real; não aceita somente MIME ou nome alegado. O worker aceita MP4 com vídeo H.264 e áudio AAC ou sem áudio, e rejeita mídia inválida ou incompatível.
- Emissão de URLs limitada por sessão, número de partes, expiração e propriedade; não prometer bloqueio de bytes indevidos apenas pela assinatura. Evitar corrida entre validação das partes e substituição antes da conclusão: vincular a finalização a ETags validados e tratar falha de precondição; remover o objeto rejeitado após conferência final.
- O endereço assinado deve ser acessível pelo cliente externo e manter o host assinado; conexões internas usam nomes dos serviços Compose. Configurar CORS necessário e exposição de ETag quando aplicável.

### Authorization Matrix

| Operação | Anônimo | Autenticado não proprietário | Proprietário |
|----------|---------|-----------------------------|--------------|
| Iniciar upload | não | cria somente para seu próprio canal | sim |
| Consultar, assinar partes, finalizar ou abortar sessão | não | não | sim |
| Consultar vídeo ou obter URLs de reprodução/download | não | não | sim; URLs apenas quando `ready` |

O identificador público não concede acesso nesta fase. URLs assinadas já emitidas são credenciais temporárias válidas até expirar; não registrar seu conteúdo em logs.

### Error Catalog

Formato herdado para erros de domínio: `{ "statusCode": number, "error": "CODE", "message": "string" }`; validação segue o filtro global existente.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_UPLOAD_TOO_LARGE | 413 | tamanho acima do limite |
| VIDEO_UPLOAD_INVALID_PARTS | 400 | partes ausentes, inválidas ou total inconsistente |
| VIDEO_UPLOAD_CONFLICT | 409 | estado da sessão não permite operação |
| VIDEO_NOT_FOUND | 404 | identificador inexistente ou não pertencente ao usuário |
| VIDEO_NOT_READY | 409 | leitura de conteúdo antes de `ready` |
| VIDEO_STORAGE_UNAVAILABLE | 503 | falha temporária do storage |
| VIDEO_QUEUE_UNAVAILABLE | 503 | dependência indisponível quando não é possível registrar intenção durável |

Erros de processamento, incluindo formato incompatível e falha após tentativas, são refletidos em `errorCode` e no status do vídeo; não expor detalhes internos.

### Events/Messages

#### video.process.requested

**Payload:** `{ "eventId": "uuid", "videoId": "uuid", "generation": integer }`; nenhum token ou URL assinada.
**Producer:** publicador do outbox após transação de conclusão (`phase-03-videos/TD-04`).
**Consumer:** worker separado com BullMQ (`phase-03-videos/TD-03`).
**Trigger:** objeto concluído e validado; vídeo e intenção registrados atomicamente.
**Delivery semantics:** pelo menos uma vez; duplicação, falha do publicador e perda de job após confirmação exigem reconciliação e processamento idempotente.
**Failure:** tentativas limitadas com backoff; falha definitiva grava `error`; recuperar worker interrompido sem permitir resultado obsoleto. Extração via ffprobe e FFmpeg ocorre sem carregar o vídeo completo em memória; recursos temporários têm limites e limpeza.


---

## Dependency Map

`SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8`.

SI-03.1 prepara storage e fila; SI-03.2 fornece as relações e transações; a finalização antecede worker e acesso. A jornada completa depende de todos os serviços.

---

## Deliverables

- [x] SI-03.1 — Infraestrutura, storage, fila e worker no Compose.
- [x] SI-03.2 — Migrations, entidades e persistência.
- [x] SI-03.3 — Pré-cadastro e início do upload.
- [x] SI-03.4 — Partes assinadas e retomada.
- [x] SI-03.5 — Finalização segura, abort e outbox.
- [x] SI-03.6 — Worker, thumbnail, metadados e recuperação.
- [x] SI-03.7 — Consulta, streaming e download autorizados.
- [x] SI-03.8 — Aceite, progresso e documentação.
- [x] Suíte completa: `docker compose exec nestjs-api npm test -- --runInBand`.
- [x] E2E: `docker compose exec nestjs-api npm run test:e2e`.
- [x] Compilação: `docker compose exec nestjs-api npx tsc --noEmit`.
- [x] Lint: `docker compose exec nestjs-api npm run lint`.
- [x] Specs de testes geradas antes da implementação para os SIs com `Test Specs`.
