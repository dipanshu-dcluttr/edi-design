# Simulation API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local simulation API for Blinkit partnersbiz, ERP, and sheet providers under `dev/simulation-api`.

**Architecture:** One Node HTTP service exposes three route groups. Blinkit platform endpoints match documented auth, endpoint paths, request shapes, and response payloads. ERP and sheet endpoints provide deterministic scenario controls and in-memory request storage for application development and tests.

**Tech Stack:** Node.js built-in `http`, `node:test`, `fetch`, no runtime dependencies.

---

### Task 1: Service Skeleton And Contract Tests

**Files:**
- Create: `dev/simulation-api/package.json`
- Create: `dev/simulation-api/test/simulation-api.test.js`
- Create: `dev/simulation-api/src/server.js`
- Create: `dev/simulation-api/src/app.js`
- Create: `dev/simulation-api/src/state.js`

- [x] **Step 1: Write failing tests**

Tests must cover health, Blinkit auth, PO ack response, ASN response, amendment response, ERP ASN poll readiness, sheet row storage, and scenario failure behavior.

- [x] **Step 2: Run test to verify it fails**

Run: `npm test --prefix dev/simulation-api`
Expected: fail because `src/app.js` does not exist.

- [x] **Step 3: Write minimal implementation**

Implement a small Node HTTP router with JSON body parsing, `Api-Key` auth for platform and simulator APIs, scenario state, and in-memory received-call storage.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test --prefix dev/simulation-api`
Expected: all tests pass.

### Task 2: Developer Documentation And Samples

**Files:**
- Create: `dev/simulation-api/README.md`

- [x] **Step 1: Document endpoints**

List exact Blinkit platform endpoints and chosen ERP/sheet simulator endpoints.

- [x] **Step 2: Document local run**

Run: `npm start --prefix dev/simulation-api`
Expected: server listens on port `4500` unless `PORT` is provided.

