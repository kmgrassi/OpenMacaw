# Secretless credential proxy — scoping (exploratory, not scheduled)

> **Status:** Exploratory. Captures a design direction borrowed from the
> Omnigent project for hardening how cloud agents authenticate to external
> services (GitHub first). **We are not building this now.** This documents
> how Omnigent does it, how it relates to what we already have, and what it
> would take to emulate — so the option is well-understood when the threat
> model justifies it.
>
> Related: [`oq-04-per-task-model-overrides-credentials`](../open-questions/oq-04-per-task-model-overrides-credentials.md),
> [`oq-11-oauth-for-runners`](../open-questions/oq-11-oauth-for-runners.md),
> [`oq-12-git-and-source-control`](../open-questions/oq-12-git-and-source-control.md),
> [`production-container-tool-execution-scope`](./production-container-tool-execution-scope.md).
> Implemented credential plumbing: GitHub App installation credential +
> JIT token minting (`platform/apps/api/src/services/resource-credentials.ts`,
> PRs #290 / #293).

## Motivation

A cloud-running agent (e.g. the manager) needs to authenticate to external
services — GitHub first (`gh pr list`, clone, PR actions), later other SaaS.
The question that prompted this: when a service wakes unattended (no user
present) and needs GitHub access, how is the credential exposed at runtime,
and how do we keep it from leaking?

Two facts frame the whole discussion:

1. **Unattended auth always requires a pre-provisioned secret.** Nothing
   avoids this. A human sets up *something* ahead of time — a PAT, or (what we
   chose) a **GitHub App** whose private key is stored as a secret and used to
   mint short-lived installation tokens on demand. The credential proxy below
   does **not** change this; it is not an easier-setup mechanism.
2. **The credential proxy is a *runtime-exposure* mechanism, not an
   *authentication* mechanism.** It changes *where the secret is exposed*
   (keeps it out of the agent's reach), not *how it is obtained*. Evaluate it
   on security grounds, never on ease-of-setup grounds.

## How we do it today (token injection)

The platform mints a short-lived GitHub App installation token
(`mintGitHubInstallationToken`) and the plan is to set it as `GH_TOKEN` in the
environment where `git.run` / `gh` runs. Properties:

- Durable secret (App private key) stays server-side; only a ~1h token is
  materialized. Blast radius is bounded **in time**.
- But the live token sits in the **environment of the process that runs the
  tool**. Any code in that process (a prompt-injected agent, a malicious
  dependency) can read `GH_TOKEN` and exfiltrate it.
- The cloud manager's `git.run` runs in the **shared orchestrator**
  (`llm_tool_runner`), which makes a materialized token there a sharper concern
  than for coding agents that run in isolated workers.

## How Omnigent does it (secretless egress proxy)

Reference: `omnigent/designs/SANDBOX_CREDENTIAL_PROXY.md`
(`omnigent/inner/credential_proxy.py`, `omnigent/inner/egress/proxy.py`).

The real secret **never enters the sandbox**. It lives only in (a) the
unsandboxed **parent** process and (b) the **egress proxy's** in-memory rewrite
table (`host → (scheme, real_secret)`). The agent runs in a sandbox whose
**only** network path is a mandatory L7 MITM proxy. Injection happens **on the
wire**, two modes:

- **Swap-on-access (default).** The tool makes its request with **no
  `Authorization` header**; the proxy recognizes the bound host and adds
  `Authorization: <scheme> <real>` on the way out. `git clone`, `curl`, etc.
  authenticate with *nothing* credential-shaped in the sandbox.
- **Placeholder injection (opt-in, for "gating" clients).** Some clients —
  notably **`gh`** — refuse to call without a local token, so there's no
  request to decorate. The parent mints a random **non-secret** placeholder
  (`oa_cred_…`) and injects only that into `GH_TOKEN`. `gh` sends
  `Authorization: token oa_cred_…`; the proxy swaps it for the real token —
  **only on the bound host** (presenting it elsewhere → HTTP 403 leak guard).

Config is per-credential, not per-app: you declare a **host**, a **scheme**
(`bearer` / `basic` / `token`), the **source** (`{env}` / `{file}` /
`{command: gh auth token}`), and whether it gates. Omnigent ships presets
(`gh_basic`, `git_https`, `https_bearer`, `https_basic`). Our GitHub case is
exactly their `gh_basic` preset.

This works for **HTTP(S) bearer/basic/token** auth (GitHub, most SaaS). It does
**not** cover request-signing auth (AWS SigV4), SSH git remotes, OAuth code
exchanges, or mTLS.

## Why a worker isn't enough by itself

Two distinct isolation layers:

- **Layer 1 — compute/process isolation (WHERE the agent runs).** We have
  this: the worker-bridge / container/ECS execution spins up ephemeral,
  per-session environments outside the orchestrator, with the repo cloned in.
  This already contains blast radius — a leaked token dies with the disposable
  worker.
- **Layer 2 — network/egress isolation (HOW the agent reaches the network).**
  We do **not** have this. Today's workers have **open egress** (they need it
  to clone, install deps, hit registries). A grep of the worker-bridge /
  runtime finds zero egress-proxy / MITM / forced-egress / network-policy
  machinery. The credential proxy requires that the agent's box can reach
  **only** the proxy — enforced at the network layer, not via `HTTPS_PROXY`
  (which an agent can simply unset).

So the proxy is **Layer 2 layered on top of the Layer 1 workers we already
built** — not a greenfield sandbox. That reframes the cost from "build
sandboxing from scratch" to "add network-egress control to existing workers."

## What it would take to emulate

Role mapping onto our system:

- **Parent (trusted):** the platform resolves the secret / mints the App token
  and hands it to the proxy sidecar — never into the worker.
- **Proxy:** a TLS-terminating MITM sidecar that enforces a host allowlist and
  injects/swaps `Authorization`.
- **Sandbox:** the existing per-session worker, with egress locked to the proxy.

Pieces, with rough effort (the proxy code is the cheap part; the network
enforcement dominates):

| Piece | Effort | Notes |
|---|---|---|
| MITM proxy (allowlist + inject/swap + wrong-host 403) | Small (days) | Use `mitmproxy` / Envoy / a small Go proxy + addon; don't hand-roll cert minting. |
| **Forced egress** (worker reaches only the proxy) | **Moderate–hard (1–3 wks)** | The crux. Sidecar in the worker netns + iptables/nftables redirect, or an egress gateway; must be network-enforced, not env-based. |
| CA trust across the toolchain | Moderate, fiddly (days + tail) | Bake CA into the worker image's system store; chase stragglers (`GIT_SSL_CAINFO`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`/`SSL_CERT_FILE`, JVM truststore…). |
| Credential wiring + per-session config | Small–moderate (days) | Mint in platform → deliver to sidecar out-of-band; host/scheme config per session. |

**Rough v1: ~3–6 focused weeks, dominated by forced-egress + CA trust.**

**Biggest swing factor — the worker substrate** (worker-bridge is "an external
cloud service"; confirm before estimating for real):

- Containers/pods/microVMs we control → textbook sidecar + netns/iptables.
- ECS Fargate specifically → in-task iptables is awkward; may need a proxy ENI
  + security groups or a substrate where we own the netns. Pushes effort up.
- A third-party sandbox provider (Modal/Daytona/E2B-style) → depends on whether
  *they* expose forced-egress controls; could be a flag or unsupported.

Plus a hardening tail regardless: DNS rebinding, IPv6, keeping package
registries reachable, and non-HTTP egress (git-over-SSH bypasses an HTTP proxy
entirely).

## Recommendation / sequencing

1. **Now:** keep token injection (JIT short-lived App tokens). It's the correct
   ahead-of-time mechanism for unattended cloud GitHub access; the App is
   designed for exactly this.
2. **Cheap interim hardening (days, when it matters):** route the manager's
   `git.run` through a **worker** (like coding agents) instead of the shared
   orchestrator, and keep tokens short-lived. This gets ~80% of the
   blast-radius benefit (a leak dies with the disposable worker) with none of
   the proxy/egress machinery.
3. **Build the secretless proxy when the threat model justifies it** — i.e.
   when we run **untrusted or third-party agent code** in those workers, where
   "the agent itself cannot read the live token" is the threat worth the
   weeks. At that point the proxy is a small addition on top of the egress
   infrastructure you'd be standing up anyway, and composes cleanly with the
   GitHub App (mint in parent → inject on wire → nothing in the sandbox).

## Open questions

- What is the worker substrate, exactly? (Drives the forced-egress effort.)
- Do we need anything beyond HTTP(S) bearer/basic/token? (SSH git remotes and
  signed auth are out of scope for the proxy.)
- Per-session vs per-workspace proxy/credential lifetime.
- Where does the proxy run relative to the worker (sidecar vs gateway) on our
  substrate, and how is the secret delivered to it out-of-band.
