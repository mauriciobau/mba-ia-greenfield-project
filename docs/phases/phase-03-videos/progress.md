# phase-03-videos — Progress

**Status:** completed
**SIs:** 8/8 completed

### SI-03.1 — Preparar infraestrutura e dependências
- **Status:** completed
- **Tests:** builds, healthchecks, CORS, URLs assinadas, persistência, compose config e tsc passaram; sem testes Jest previstos neste SI.
- **Observations:**
  - Worker iniciado em modo de espera; o consumidor será implementado no SI-03.6.
  - Override temporário em /tmp evita conflito com porta 5432 ocupada por outro projeto.
  - npm reportou 51 vulnerabilidades nas dependências instaladas; avaliação fora deste SI.

### SI-03.2 — Persistir vídeos e sessões
- **Status:** completed
- **Tests:** 3 suítes, 6 testes aprovados; TypeScript sem erros.
- **Observations:**
  - Context7 oferece TypeORM 0.3.27; o projeto usa 0.3.28. A API instalada passou nos testes do SI.

### SI-03.3 — Iniciar upload e criar rascunho
- **Status:** completed
- **Tests:** verificação independente de 6 suítes/29 testes passou; tsc e lint focado das alterações passaram.
- **Observations:**
  - Reconciliação durável de multipart órfão permanece para SI-03.5; em falha de compensação o draft e object_key são preservados.
  - Lint completo detectou 150 erros em código e testes preexistentes; corrigidos em tarefa separada: npm run lint passou com 0 erros e 23 avisos. Suítes completas e TypeScript passaram após a correção.
  - Container API foi recriado para carregar configuração S3, sem recriar banco ou serviços de terceiros.

### SI-03.4 — Retomar upload por partes
- **Status:** completed
- **Tests:** verificação independente: 5 suítes/19 testes e 1 suíte E2E/2 testes passaram; tsc e lint focado passaram.
- **Observations:**
  - E2E confirmou 403 real de URL expirada e renovação para envio válido.
  - E2E no container usa S3_PUBLIC_ENDPOINT=http://minio:9000; acesso externo foi verificado no SI-03.1.

### SI-03.5 — Finalizar upload e registrar processamento
- **Status:** completed
- **Tests:** regressão independente 28 testes; suíte completa 185 testes; E2E 70 testes; tsc e lint passaram (23 avisos).
- **Observations:**
  - Migration aditiva registra token de posse para bloquear executor obsoleto; reconciliação requer aplicação NestJS ativa.
  - Teste de rollback usa banco temporário isolado; schema local foi reparado após regressão identificada.
  - TypeORM 0.3.28 instalado; Context7 ofereceu 0.3.27 como documentação versionada mais próxima.

### SI-03.6 — Processar vídeo em worker
- **Status:** completed
- **Tests:** verificação independente 18 testes isolados, suíte completa 201 testes, E2E 70 testes, tsc e lint aprovados (23 avisos).
- **Observations:**
  - Worker real processou job Redis, MP4 em MinIO e gerou thumbnail JPEG, duração e metadata; fixture removida.
  - Publicador recupera job perdido/falho; execução usa token persistente, lease e chave de thumbnail por tentativa.
  - Testes de migrations legados foram isolados após removerem tabelas no banco de teste anterior; novo banco streamtube_phase03_clean conserva 5 migrations após suíte completa.
  - Worker usa concorrência 1 e entrada limitada a 10 GB; não há cota geral de disco no Compose.

### SI-03.7 — Disponibilizar consulta, streaming e download
- **Status:** completed
- **Tests:** verificação independente: 8 unit/integração e 10 E2E aprovados; TypeScript e lint focado passaram.
- **Observations:**
  - Fluxo interno validou Range 206, Content-Disposition e renovação das URLs no MinIO real.
  - Respostas das três rotas têm schemas OpenAPI concretos e teste de contrato.

### SI-03.8 — Validar aceite e documentar execução
- **Status:** completed
- **Tests:** 38 suítes/209 testes; 7 suítes E2E/74 testes; teste opt-in real de 10 GB passou separadamente; tsc, lint e build passaram.
- **Observations:**
  - Aceite real: 10.000.000.000 bytes, 150 partes, vídeo ready, thumbnail e Range 206; duração do teste 148,7 s. RSS do processo API/Jest aumentou 11.403.264 bytes; uploader em processo filho.
  - Comando de aceite: docker compose exec -T -e VIDEO_10GB_ACCEPTANCE=1 nestjs-api npm run test:e2e -- --runInBand test/video-pipeline.e2e-spec.ts.
  - Corrigida corrida entre publicação na fila e mudança de status no outbox; regressão com Redis e PostgreSQL reais passou.
  - Lint terminou com 0 erros e 23 avisos em testes existentes de auth.
  - O banco de teste anterior teve seu histórico alterado por teste legado; teste foi isolado e o banco novo streamtube_phase03_clean mantém cinco migrations. Bancos anteriores não foram removidos.
  - Storage aceita MP4/H.264 com áudio AAC ou sem áudio; acesso nesta fase é restrito ao proprietário. O worker usa cópia temporária de até 10 GB e não há cota geral de disco no Compose.
