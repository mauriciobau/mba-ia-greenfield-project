---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.5
target_file: nestjs-project/test/videos-upload-complete.e2e-spec.ts
---

# Conclusão e cancelamento — Test Plan

## Application Overview

Exercita o contrato HTTP e os efeitos persistentes do fluxo conclusão e cancelamento descrito no plano da Fase 03.

## Test Scenarios

### 1. Conclusão e cancelamento

**Setup:** iniciar aplicação NestJS com pipes e filtros globais; banco, MinIO e Redis reais isolados; criar dois usuários e canais, limpar dados após os cenários e fechar a aplicação.

#### 1.1. finalizar-uma-vez

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-29T00:59:31Z

**Steps:**
  1. Enviar partes válidas e POST complete; esperar 202 processing, estado no banco e uma intenção outbox; repetir e verificar ausência de duplicata.

#### 1.2. rejeitar-partes-incorretas

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-29T00:59:31Z

**Steps:**
  1. Tentar finalizar partes ausentes, alteradas ou acima do limite; esperar 400 ou 413 conforme contrato e ausência de vídeo pronto.

#### 1.3. corrida-e-recuperacao

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-29T00:59:31Z

**Steps:**
  1. Concorrer cancelamento e finalização e simular falha após conclusão no storage; verificar estado consistente e recuperação sem duplicar o trabalho.
