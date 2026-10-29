---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos-access.e2e-spec.ts
---

# Acesso e reprodução — Test Plan

## Application Overview

Exercita o contrato HTTP e os efeitos persistentes do fluxo acesso e reprodução descrito no plano da Fase 03.

## Test Scenarios

### 1. Acesso e reprodução

**Setup:** iniciar aplicação NestJS com pipes e filtros globais; banco, MinIO e Redis reais isolados; criar dois usuários e canais, limpar dados após os cenários e fechar a aplicação.

#### 1.1. autorizar-proprietario

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-29T00:59:31Z

**Steps:**
  1. Consultar GET do vídeo com proprietário, outro usuário e sem token; esperar 200, 404 e 401 respectivamente.

#### 1.2. reproduzir-parcial-e-baixar

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-29T00:59:31Z

**Steps:**
  1. Para vídeo pronto obter playback-url, solicitar Range ao storage e esperar 206 e Content-Range; obter download-url e verificar bytes e Content-Disposition.

#### 1.3. bloquear-nao-pronto-e-renovar

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-29T00:59:31Z

**Steps:**
  1. Solicitar URL para vídeo não pronto e esperar 409 VIDEO_NOT_READY; após expirar URL de vídeo pronto, proprietário obtém nova URL funcional.
