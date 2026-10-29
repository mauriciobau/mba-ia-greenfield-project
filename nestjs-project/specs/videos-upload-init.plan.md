---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.3
target_file: nestjs-project/test/videos-upload-init.e2e-spec.ts
---

# Início de upload — Test Plan

## Application Overview

Exercita o contrato HTTP e os efeitos persistentes do fluxo início de upload descrito no plano da Fase 03.

## Test Scenarios

### 1. Início de upload

**Setup:** iniciar aplicação NestJS com pipes e filtros globais; banco, MinIO e Redis reais isolados; criar dois usuários e canais, limpar dados após os cenários e fechar a aplicação.

#### 1.1. criar-rascunho

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-10-29T00:59:31Z

**Steps:**
  1. Autenticar usuário com canal, POST /videos/uploads com sizeBytes válido e contentType video/mp4; esperar 201, identificadores, status draft e vínculo ao canal no banco.

#### 1.2. rejeitar-tamanho-excedente

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-10-29T00:59:31Z

**Steps:**
  1. POST /videos/uploads com 10000000001 bytes; esperar 413 VIDEO_UPLOAD_TOO_LARGE e nenhuma sessão ativa no banco ou storage.

#### 1.3. exigir-autenticacao-e-recuperar-falha

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-10-29T00:59:31Z

**Steps:**
  1. POST sem token retorna 401; simular indisponibilidade do storage e verificar recuperação de recursos órfãos.
