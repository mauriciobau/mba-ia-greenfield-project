---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.4
target_file: nestjs-project/test/videos-upload-parts.e2e-spec.ts
---

# Retomada e partes — Test Plan

## Application Overview

Exercita o contrato HTTP e os efeitos persistentes do fluxo retomada e partes descrito no plano da Fase 03.

## Test Scenarios

### 1. Retomada e partes

**Setup:** iniciar aplicação NestJS com pipes e filtros globais; banco, MinIO e Redis reais isolados; criar dois usuários e canais, limpar dados após os cenários e fechar a aplicação.

#### 1.1. retomar-partes

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-29T00:59:31Z

**Steps:**
  1. Criar sessão autenticada, obter URLs, enviar partes diretamente ao storage, interromper e consultar GET da sessão; esperar partes e ETags corretos e retomar o envio.

#### 1.2. isolar-proprietario

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-29T00:59:31Z

**Steps:**
  1. Solicitar part-urls com número inválido e consultar sessão de outro usuário; esperar erro de validação e 404 respectivamente.

#### 1.3. renovar-url

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-29T00:59:31Z

**Steps:**
  1. Deixar URL assinada expirar e solicitar nova URL para sessão ativa; esperar que a nova autorização funcione.
