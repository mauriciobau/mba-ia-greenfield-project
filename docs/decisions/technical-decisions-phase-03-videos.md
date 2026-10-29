---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-28
scope_description: "Backend, worker e infraestrutura local para upload retomável, processamento e acesso a vídeos."
---

# Decisões técnicas — Fase 03: Upload e Processamento de Vídeos

_Subprojetos no escopo:_

- `nestjs-project/` — API, persistência, infraestrutura e worker de vídeo.
- `next-frontend/` — interface fora do escopo; o contrato de um cliente futuro é considerado onde necessário.

As recomendações são propostas para discussão; as escolhas aprovadas estão registradas nos respectivos campos de decisão. O Context7 está disponível; a documentação geral foi consultada. Antes da implementação, consultar as versões escolhidas e fixar referências compatíveis em `library-refs.md`. As pesquisas gerais não comprovam compatibilidade de versões específicas.

---

## TD-01: Object storage local

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Os arquivos devem persistir fora da API e ser acessíveis ao worker e ao cliente. A arquitetura já restringe o storage a S3/MinIO.

**Options:**

### Option A: MinIO no Compose, API compatível com S3
- Usa armazenamento local persistente e um cliente S3; o bucket não depende do ciclo de vida da API.
- **Pros:** Infraestrutura real sem conta externa; aproxima o contrato de S3.
- **Cons:** Exige configurar persistência, credenciais, inicialização e endereços externos; compatibilidade deve ser testada na versão escolhida.

### Option B: S3 remoto
- Usa um bucket AWS real acessível pelos serviços locais.
- **Pros:** Serviço gerenciado e comportamento nativo S3.
- **Cons:** Conta, rede e custos externos; não entrega o storage subindo no Compose como exigido.

**Recommendation:** A — MinIO no Compose atende ao ambiente local e ao requisito de infraestrutura real. Fixar imagem e validar operações usadas, sem presumir equivalência integral com S3.

**Decision:** A — MinIO no Docker Compose com armazenamento persistente.

**Libraries:** MinIO RELEASE.2025-10-15T17-29-55Z

**Revisions:**
- 2026-10-28 — Construir imagem local a partir da release oficial RELEASE.2025-10-15T17-29-55Z. Rationale: distribuição comunitária somente em código-fonte; validar build e manutenção na implementação.

---

## TD-02: Contrato de upload retomável

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance; Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** O cliente deve enviar até 10 GB sem transferir o conteúdo pela API; o plano geral também exige retomada após falha. A API precisa associar sessão e objeto ao dono e validar o resultado.

**Options:**

### Option A: Multipart S3 direto com URLs assinadas por parte
- A API cria rascunho e sessão, autoriza partes e finalização; o cliente envia partes ao storage e retoma consultando as partes recebidas.
- **Pros:** Arquivo não passa pela API; reenvia apenas partes necessárias; usa storage já previsto.
- **Cons:** Exige controle de sessão, paginação das partes, limpeza e proteção contra upload acima do limite declarado; endereços e CORS devem funcionar para o cliente externo.

### Option B: Serviço de upload tus separado com armazenamento S3
- Um serviço próprio recebe o fluxo retomável e transfere o conteúdo ao storage, enquanto a API controla o rascunho.
- **Pros:** Protocolo dedicado à retomada, com clientes existentes; API permanece fora do caminho dos bytes.
- **Cons:** Mais um serviço, tráfego intermediário e integração com estado e eventos.

**Recommendation:** A — aproveita MinIO e elimina um serviço intermediário. A API deve conferir as partes e seus tamanhos no storage antes de completar, limitar a emissão de URLs, verificar o objeto final e limpar sessões abandonadas; URLs pré-assinadas são credenciais temporárias e não impõem, por si só, o limite agregado de 10 GB. Definir explicitamente GB versus GiB e testar tentativas acima do limite. O S3 suporta retomada por partes e tem limites de tamanho e número de partes; validar o comportamento no MinIO escolhido. [Multipart](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html), [limites](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html).

**Decision:** A — upload multipart direto com URLs assinadas, retomável; limite de 10.000.000.000 bytes.

**Libraries:** @aws-sdk/client-s3@3.1145.0, @aws-sdk/s3-request-presigner@3.1145.0

**Revisions:**
- 2026-10-28 — Adotar AWS SDK for JavaScript v3 para operações S3 e assinatura, com versões iniciais 3.1145.0 sujeitas à validação. Rationale: contrato S3 compatível com o storage escolhido.

---

## TD-03: Fila e worker

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** O processamento precisa ocorrer em processo e container próprios, com fila operacional e recuperação de falhas.

**Options:**

### Option A: BullMQ com Redis e worker Node separado
- A API publica trabalhos e um processo separado consome e executa FFmpeg.
- **Pros:** Ecossistema TypeScript; tentativas, backoff e recuperação de trabalhos parados.
- **Cons:** Acrescenta Redis, persistência e operação; entregas podem repetir e exigem idempotência.

### Option B: Fila baseada em PostgreSQL
- API e worker usam uma biblioteca de fila apoiada no PostgreSQL existente.
- **Pros:** Menos um serviço de dados; pode facilitar transações com o banco.
- **Cons:** Acopla carga e operação da fila ao banco; exige avaliar biblioteca, compatibilidade e comportamento operacional.

**Recommendation:** A — separa o trabalho pesado da API e oferece primitivas de fila adequadas ao projeto, ao custo de Redis. Configurar persistência e recuperação, limitar concorrência e validar falhas reais. BullMQ documenta reentrega após falhas e requer processamento idempotente. [BullMQ](https://docs.bullmq.io/), [jobs idempotentes](https://docs.bullmq.io/patterns/idempotent-jobs).

**Decision:** A — BullMQ com Redis e worker separado.

**Libraries:** bullmq@5.77.6, Redis 8.6.8

---

## TD-04: Consistência entre conclusão, banco e fila

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Serviço de processamento em segundo plano (filas); Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Storage, PostgreSQL e Redis não participam da mesma transação. Uma falha após completar o objeto ou após atualizar o banco pode deixar o vídeo sem processamento.

**Options:**

### Option A: Outbox transacional e reconciliação do upload
- Estado e intenção de enfileirar são gravados na mesma transação; um publicador reenvia pendências. Uma reconciliação verifica sessões cujo objeto foi concluído antes de uma falha no banco.
- **Pros:** Trata as duas fronteiras de falha; permite recuperação automática.
- **Cons:** Mais estado, processo de publicação e limpeza; duplicatas continuam possíveis.

### Option B: Publicação direta com reconciliação periódica
- Após concluir o objeto, a API atualiza o banco e publica diretamente; uma rotina encontra e repara estados inconsistentes.
- **Pros:** Menos infraestrutura de outbox.
- **Cons:** Identificar se um job foi publicado ou perdido exige regras e observabilidade adicionais.

**Recommendation:** A — outbox protege a fronteira banco/fila; reconciliação separada protege storage/banco. Worker idempotente, identificadores estáveis e transições condicionais são necessários, inclusive quando o publicador falha após enviar. [Transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html).

**Decision:** A — outbox transacional e reconciliação entre storage e banco.

**Libraries:** —

---

## TD-05: Processamento e compatibilidade de mídia

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo; Reprodução via streaming (sem necessidade de download completo)

**Context:** O requisito não define formatos de entrada nem exige transcodificação. Um arquivo válido nem sempre é reproduzível no cliente, e metadados podem exigir acesso aleatório.

**Options:**

### Option A: Aceitar um conjunto limitado de formatos reproduzíveis
- Worker usa ffprobe para validar formato, codecs e duração, e FFmpeg para gerar thumbnail; arquivos incompatíveis terminam em erro.
- **Pros:** Evita transcodificação pesada e arquivos adicionais; escopo local menor.
- **Cons:** Restringe os uploads; os critérios exatos de compatibilidade precisam ser documentados e testados.

### Option B: Transcodificar para formato padrão
- Worker converte entradas aceitas em uma versão de reprodução, além de extrair metadados e thumbnail.
- **Pros:** Amplia compatibilidade de reprodução.
- **Cons:** Uso maior de CPU, tempo e armazenamento; requer política para originais e falhas.

**Recommendation:** A — responde ao escopo sem pressupor conversão universal. Definir uma matriz mínima de container/codecs e verificar reprodução e busca no cliente-alvo; se a avaliação exigir entradas amplas, B precisa ser reavaliada. Usar arquivo temporário limitado ou acesso compatível com busca, sem manter 10 GB em memória, e limpar arquivos após falhas. [ffprobe](https://www.ffmpeg.org/ffprobe.html), [FFmpeg](https://www.ffmpeg.org/ffmpeg.html).

**Decision:** A — MP4 com vídeo H.264 e áudio AAC, ou sem áudio; outros formatos e codecs são rejeitados com erro claro. Sem transcodificação.

**Libraries:** FFmpeg e ffprobe 8.0.3

**Revisions:**
- 2026-10-28 — Matriz inicial definida como MP4 com H.264 e AAC opcional; outros formatos e codecs são rejeitados. Rationale: fixar um contrato de entrada testável para a fase.

---

## TD-06: Ciclo de status e acesso antes da publicação

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados); Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** `requisitos.md` exige rascunho → processando → pronto/erro; publicação e visibilidade pertencem à Fase 04, e a visualização anônima à Fase 05. Precisamos de um contrato executável nesta fase.

**Options:**

### Option A: Status de processamento separado de publicação; acesso do proprietário
- Vídeo inicia rascunho, passa a processando e termina pronto ou erro; proprietário autenticado consulta e acessa vídeo pronto.
- **Pros:** Não antecipa publicação; evita expor rascunhos.
- **Cons:** Demonstração de reprodução exige autenticação; acesso anônimo virá depois.

### Option B: Vídeo pronto acessível a qualquer pessoa com o link
- Mesmos estados, mas o conteúdo pronto fica acessível pelo identificador sem autenticação.
- **Pros:** Demonstra visualização anônima por link desde já.
- **Cons:** Introduz uma política de visibilidade antes da Fase 04 e pode expor conteúdo ainda não publicado.

**Recommendation:** A — preserva a separação das fases. Especificar estados em tentativas temporárias, falha definitiva, upload abandonado e operações repetidas; não criar publicação antecipadamente. Confirmar que o avaliador aceita demonstração autenticada.

**Decision:** A — somente o proprietário autenticado acessa o vídeo pronto nesta fase; publicação e acesso anônimo ficam para fases posteriores.

---

## TD-07: URL única, streaming e download

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos; Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** A URL estável identifica o vídeo; acesso ao conteúdo precisa respeitar autorização e intervalos HTTP, sem sobrecarregar a API.

**Options:**

### Option A: Identificador estável e URLs temporárias do storage
- A API consulta por identificador único e fornece URLs assinadas de leitura e download; o cliente acessa o storage diretamente.
- **Pros:** API não transporta vídeo; URL de aplicação permanece estável enquanto credenciais expiram.
- **Cons:** URLs temporárias podem expirar durante uso; endereço externo, CORS, comportamento de download e Range precisam ser testados.

### Option B: API como proxy de streaming
- A API autoriza cada requisição e repassa o conteúdo e os headers de intervalo do storage.
- **Pros:** Autorização centralizada e endereço único para o cliente.
- **Cons:** Tráfego e conexões de mídia passam pela API; aumenta carga e complexidade do proxy.

**Recommendation:** A — alinha-se ao diagrama de acesso direto ao storage e à decisão existente do frontend para arquivos grandes. Usar identificador curto aleatório com constraint única e nova tentativa em colisão; definir prazo e renovação das URLs. Testar `Range`, `206`, busca e download efetivo no MinIO; suporte de Range no S3 está documentado, mas não substitui o teste local. [S3 GetObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html).

**Decision:** A — identificador estável e URLs assinadas temporárias para streaming e download.

**Libraries:** —

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Storage local | A — MinIO | A |
| TD-02 | Cross-layer | Upload retomável | A — multipart direto | A |
| TD-03 | Backend | Fila e worker | A — BullMQ/Redis | A |
| TD-04 | Backend | Consistência | A — outbox e reconciliação | A |
| TD-05 | Backend | Processamento e formatos | A — formatos limitados | A |
| TD-06 | Backend | Status e acesso | A — acesso do proprietário | A — acesso do proprietário |
| TD-07 | Cross-layer | URL, streaming e download | A — URL estável e URLs assinadas | A |
