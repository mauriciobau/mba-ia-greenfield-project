---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-07-14T19:23:38.260548142-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-28T21:54:48.402599780-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-07-14T19:23:38.255159815-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-07-14T19:23:38.258654204-03:00"
  docs/phases/phase-02-auth/context.md: "2026-07-14T19:23:38.259521528-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-07-14T19:23:38.258764443-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-07-14T19:23:38.213811389-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos
**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** interface de vídeo; edição, visibilidade e publicação (Fase 04); página de visualização anônima (Fase 05).
**Deliverables:** upload até 10 GB, processamento automático, streaming e URLs únicas; API, worker e infraestrutura em Docker conforme `requisitos.md`.
**Affected subprojects:** `nestjs-project/` e infraestrutura local.
**Deferred subprojects:** interface em `next-frontend/`.
**Sequencing notes:** depende das Fases 01 e 02; upload deve permitir retomada segundo os pontos de atenção do plano.
**Neighbors (for boundary detection only):** Fase 02 — autenticação e canais; Fase 04 — gestão e publicação; Fase 05 — página de visualização.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Object storage local | decided | A | MinIO RELEASE.2025-10-15T17-29-55Z |
| phase-03-videos/TD-02 | phase | Cross-layer | Contrato de upload retomável | decided | A | @aws-sdk/client-s3@3.1145.0, @aws-sdk/s3-request-presigner@3.1145.0 |
| phase-03-videos/TD-03 | phase | Backend | Fila e worker | decided | A | bullmq@5.77.6, Redis 8.6.8 |
| phase-03-videos/TD-04 | phase | Backend | Consistência entre conclusão, banco e fila | decided | A | — |
| phase-03-videos/TD-05 | phase | Backend | Processamento e compatibilidade de mídia | decided | A | FFmpeg e ffprobe 8.0.3 |
| phase-03-videos/TD-06 | phase | Backend | Ciclo de status e acesso antes da publicação | decided | A | — |
| phase-03-videos/TD-07 | phase | Cross-layer | URL única, streaming e download | decided | A | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-04, phase-03-videos/TD-06 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-06 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05, phase-03-videos/TD-06, phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-06, phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Revision:** Build local da release oficial RELEASE.2025-10-15T17-29-55Z.

**Recommendation:** A — MinIO no Compose atende ao ambiente local e ao requisito de infraestrutura real. Fixar imagem e validar operações usadas, sem presumir equivalência integral com S3.
**Libraries:** MinIO RELEASE.2025-10-15T17-29-55Z

### phase-03-videos/TD-02

**Revision:** AWS SDK v3 para S3 e assinatura, versão inicial 3.1145.0.

**Recommendation:** A — aproveita MinIO e elimina um serviço intermediário. A API deve conferir as partes e seus tamanhos no storage antes de completar, limitar a emissão de URLs, verificar o objeto final e limpar sessões abandonadas; URLs pré-assinadas são credenciais temporárias e não impõem, por si só, o limite agregado de 10 GB. Definir explicitamente GB versus GiB e testar tentativas acima do limite. O S3 suporta retomada por partes e tem limites de tamanho e número de partes; validar o comportamento no MinIO escolhido. [Multipart](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html), [limites](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html).
**Libraries:** @aws-sdk/client-s3@3.1145.0, @aws-sdk/s3-request-presigner@3.1145.0

### phase-03-videos/TD-03

**Recommendation:** A — separa o trabalho pesado da API e oferece primitivas de fila adequadas ao projeto, ao custo de Redis. Configurar persistência e recuperação, limitar concorrência e validar falhas reais. BullMQ documenta reentrega após falhas e requer processamento idempotente. [BullMQ](https://docs.bullmq.io/), [jobs idempotentes](https://docs.bullmq.io/patterns/idempotent-jobs).
**Libraries:** bullmq@5.77.6, Redis 8.6.8

### phase-03-videos/TD-04

**Recommendation:** A — outbox protege a fronteira banco/fila; reconciliação separada protege storage/banco. Worker idempotente, identificadores estáveis e transições condicionais são necessários, inclusive quando o publicador falha após enviar. [Transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html).
**Libraries:** —

### phase-03-videos/TD-05

**Revision:** MP4 com H.264 e AAC opcional; outros formatos e codecs são rejeitados.

**Recommendation:** A — responde ao escopo sem pressupor conversão universal. Definir uma matriz mínima de container/codecs e verificar reprodução e busca no cliente-alvo; se a avaliação exigir entradas amplas, B precisa ser reavaliada. Usar arquivo temporário limitado ou acesso compatível com busca, sem manter 10 GB em memória, e limpar arquivos após falhas. [ffprobe](https://www.ffmpeg.org/ffprobe.html), [FFmpeg](https://www.ffmpeg.org/ffmpeg.html).
**Libraries:** FFmpeg e ffprobe 8.0.3

### phase-03-videos/TD-06

**Recommendation:** A — preserva a separação das fases. Especificar estados em tentativas temporárias, falha definitiva, upload abandonado e operações repetidas; não criar publicação antecipadamente. Confirmar que o avaliador aceita demonstração autenticada.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** A — alinha-se ao diagrama de acesso direto ao storage e à decisão existente do frontend para arquivos grandes. Usar identificador curto aleatório com constraint única e nova tentativa em colisão; definir prazo e renovação das URLs. Testar `Range`, `206`, busca e download efetivo no MinIO; suporte de Range no S3 está documentado, mas não substitui o teste local. [S3 GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).
**Libraries:** —

## Inherited Decisions Detail


### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)


### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —


### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** **Option A (`@nestjs/swagger`)** — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger

### openapi-docs-nestjs/TD-02

**Recommendation:** **Option C (Ambos)** — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** **Option B (Apenas em dev/staging)** — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

## Inherited Conventions

- Configuração por domínio com `registerAs`, validação Joi e injeção tipada; reutilizar factory no data source. _(from phase 01)_
- TypeORM com `forRootAsync`, `autoLoadEntities` e `synchronize: false`; migrations versionadas. _(from phase 01)_
- Guard JWT global, serviços responsáveis pela lógica, DTOs validados e filtro de exceções de domínio. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend da fase base | deferred | phase-01-configuracao-base | Frontend criado em fase posterior. |
| Telas de autenticação | deferred | phase-02-auth | Planejadas em slice frontend. |
| Confirmação de conta e destino de redefinição de senha | deferred | phase-02-auth-frontend | Telas ausentes do escopo daquela fase. |
| Logout UI | deferred | phase-02-auth-frontend | Botão depende do chrome autenticado. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity | Integração: constraints e defaults no banco real |
| Service | Unitário para ramificações; integração para contratos de banco e serviços externos |
| Module | Compilação de DI para imports configurados |
| Controller, DTO e autorização | E2E HTTP para contrato, validação e autenticação |
| Worker, storage e fila | Integração com serviços reais e testes de falha e repetição |
