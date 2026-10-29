---
libs:
  bullmq:
    version: "5.77.6"
    context7_id: "/taskforcesh/bullmq/v5.77.6"
    fetched_at: "2026-10-28"
  aws-sdk-js-v3:
    version: "3.1145.0"
    context7_id: "/aws/aws-sdk-js-v3/v3.1145.0"
    fetched_at: "2026-10-28"
  minio:
    version: "RELEASE.2025-10-15T17-29-55Z"
    context7_id: "/minio/docs"
    fetched_at: "2026-10-28"
  ffmpeg:
    version: "8.0.3"
    context7_id: "/websites/ffmpeg_documentation"
    fetched_at: "2026-10-28"
  redis:
    version: "8.6.8"
    context7_id: "/redis/docs"
    fetched_at: "2026-10-28"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-28T21:54:48.402599780-03:00"
---

# Referências de bibliotecas — Fase 03

**Versões de partida aprovadas para o plano.** A SI-03.1 instalou e validou parcialmente essas dependências; a compatibilidade dos fluxos de aplicação permanece sujeita aos testes das etapas seguintes.

### bullmq@5.77.6

- Context7: `/taskforcesh/bullmq/v5.77.6`. A documentação consultada recomenda reconexão persistente no worker e descreve requisitos de configuração de conexões Redis; a concorrência precisa ser limitada de acordo com os recursos disponíveis.
- Fonte: [conexões BullMQ v5.77.6](https://github.com/taskforcesh/bullmq/blob/v5.77.6/docs/gitbook/guide/connections.md).
- Verificar compatibilidade efetiva com Node, Redis e a integração NestJS antes de fixar a versão.

### @aws-sdk/client-s3@3.1145.0

### @aws-sdk/s3-request-presigner@3.1145.0

- Context7: `/aws/aws-sdk-js-v3/v3.1145.0`. A documentação consultada descreve `getSignedUrl` com cliente e comando e o pacote de assinatura separado.
- Fonte: [presigner v3.1145.0](https://github.com/aws/aws-sdk-js-v3/blob/v3.1145.0/packages/s3-request-presigner/README.md).
- AWS SDK v3 foi escolhido; os pacotes `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` têm versão inicial 3.1145.0. Confirmar operações multipart e compatibilidade com o MinIO na implementação.

### MinIO RELEASE.2025-10-15T17-29-55Z

- Context7: `/minio/docs`. A documentação consultada apresenta armazenamento persistente em container e URLs assinadas, mas os exemplos podem não refletir a distribuição atual.
- O [repositório oficial](https://github.com/minio/minio/blob/master/README.md) informa que a edição comunitária é distribuída apenas como código-fonte e orienta construir a imagem. Selecionar revisão imutável, verificar licença e testar build e funcionalidades S3 antes de fixar a imagem.
- Versão `RELEASE.2025-10-15T17-29-55Z` compilada com sucesso a partir do módulo Go fixado. O repositório foi arquivado em 25/04/2026; avaliar o impacto de manutenção e segurança antes de usá-lo além do ambiente local.

### FFmpeg e ffprobe 8.0.3

- Context7: `/websites/ffmpeg_documentation`. FFmpeg permite limitar os frames extraídos com `-frames:v`; ffprobe fornece metadados em formato processável.
- Fontes: [FFmpeg](https://ffmpeg.org/ffmpeg-all.html), [ffprobe](https://ffmpeg.org/ffprobe.html).
- Selecionar e verificar a versão disponível na imagem do worker e testar a matriz MP4/H.264/AAC.
- A release [8.0.3](https://ffmpeg.org/download.html) foi confirmada na imagem `jrottenberg/ffmpeg:8.0.3-ubuntu2404`, com `ffmpeg` e `ffprobe` executáveis no container do worker. O Context7 dispõe de documentação versionada da família 8.0.
- Context7 `/websites/ffmpeg_doxygen/8.0` foi consultado para essa família; os exemplos retornados são de APIs C e não substituem a referência da CLI, que deve ser consultada para as opções efetivamente utilizadas.

### Redis 8.6.8

- Context7: `/redis/docs`. AOF registra alterações para recuperação e `noeviction` retorna erros quando o limite de memória é atingido. A política de sincronização e o tratamento desses erros precisam ser testados; a versão inicial é 8.6.8. [Persistência](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/), [eviction](https://redis.io/docs/latest/develop/reference/eviction/).
- A release [8.6.8](https://github.com/redis/redis/releases/tag/8.6.8) foi executada pela imagem `redis:8.6.8-alpine`; healthcheck passou. A compatibilidade de integração com BullMQ ainda deve ser confirmada quando a fila for implementada.
- `appendfsync everysec` pode perder até aproximadamente um segundo de gravações em falhas; a reconciliação deve detectar trabalhos que o Redis perdeu mesmo depois da publicação pelo outbox. Persistência AOF não elimina essa janela.

## Validação da SI-03.1 — 2026-10-28

- Compose: `nestjs-api`, `video-worker`, `db`, `mailpit`, `redis`, `minio` e `minio-init`. Os hosts de serviço usados entre containers são `db`, `redis` e `minio`.
- MinIO `RELEASE.2025-10-15T17-29-55Z` e MinIO Client `RELEASE.2025-08-13T08-35-41Z` foram compilados de seus módulos Go fixados. O healthcheck passou e `minio-init` criou o bucket `videos`.
- Esta release não implementa `PutBucketCors`; `mc cors set` foi testado e retornou erro. A origem é configurada pelo servidor via `MINIO_API_CORS_ALLOW_ORIGIN` (default local `http://localhost:3001`). Preflight `PUT` retornou `204` e `Access-Control-Allow-Origin` correspondente; uma origem diferente não recebeu esse header. Upload e leitura com URLs assinadas foram acessíveis pelo host e a resposta expôs `ETag`.
- `S3_ENDPOINT=http://minio:9000` é o endereço interno para operações da API/worker. `S3_PUBLIC_ENDPOINT=http://localhost:9000` existe apenas para formar URLs assinadas consumidas fora da rede Compose; o host incluído na assinatura precisa permanecer inalterado.
- Redis `8.6.8-alpine` ficou healthy com AOF, `appendfsync everysec`, limite de memória de `384mb` e `noeviction`; uma chave temporária sobreviveu ao restart. `bullmq@5.77.6`, `@aws-sdk/client-s3@3.1145.0` e `@aws-sdk/s3-request-presigner@3.1145.0` foram instalados com versões exatas. A integração BullMQ ainda não é exercitada nesta unidade.
- A imagem de worker `jrottenberg/ffmpeg:8.0.3-ubuntu2404` foi construída com Node `25.6.0`; `ffmpeg -version` e `ffprobe -version` retornaram `8.0.3`. O container ficou isolado da API e tem limite de memória de `2g`.
