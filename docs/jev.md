# Jev (TypeSafe) integration — operator notes

Jev is an **optional, off-by-default judgment stage**. When it is off
(the default), the system makes zero TypeSafe calls and behaves exactly
as it did before this feature existed. When it is on, it reranks
already-retrieved, already-authorized candidate passages — nothing more.

## What Jev does and does not do

| Jev does | Jev does not |
| --- | --- |
| Reorder the ≤20 hydrated candidates it was given | Invent passages or expand document scope |
| Record its usage separately from generation usage | Generate answer text |
| Fall back to baseline RRF ordering on any provider failure | Bypass or relax authorization |
| Treat retrieved text as untrusted data | Execute actions or create tools |

Authorization is deterministic application policy — never a model
output (INV-01). A relevance score is not truth, permission, or claim
support (INV-11).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `JEV_MODE` | `off` | `off` / `shadow` / `on` for reranking only |
| `JEV_ROUTING_MODE` | `off` | R2 request routing; independent of JEV_MODE |
| `JEV_CLAIM_CHECK_MODE` | `off` | R3 advisory claim-support assessment; independent of JEV_MODE |
| `JEV_MAX_RUN_HTTP_MS` | 2000 | Aggregate Jev HTTP budget per run (routing 500ms, rerank 1500ms, claim 1000ms ceilings, bounded by remainder) |
| `JEV_KILL_SWITCH` | `false` | Stops **all** Jev traffic, overriding every mode |
| `TYPESAFE_API_KEY` | unset | Server-side secret; presence alone enables nothing |
| `TYPESAFE_MODEL` | `jev-latest` | Dev alias; production requires a pinned, verified model |
| `JEV_ALLOWED_WORKSPACE_IDS` | empty | Exact UUID allowlist, comma-separated; wildcards are rejected as invalid config |
| `JEV_TIMEOUT_MS` | 1500 | Total transport deadline (50–5000 accepted) |
| `JEV_MAX_CANDIDATES` | 20 | Candidate cap per invocation |
| `JEV_MAX_EXCERPT_BYTES` | 1600 | UTF-8-safe excerpt budget per candidate (utf8-prefix-v1) |
| `JEV_MAX_REQUEST_BYTES` | 48000 | Serialized request cap, checked before send |
| `JEV_MAX_RESPONSE_BYTES` | 65536 | Consumed response cap, including decoded bytes |
| `JEV_MAX_INFLIGHT_PER_WORKSPACE` | 2 | Capacity admission |
| `JEV_MAX_INFLIGHT_PER_CREDENTIAL` | 4 | Capacity admission |
| `JEV_SHADOW_SAMPLE_RATE` | 1.0 | Deterministic shadow sampling by invocation id |

Invalid optional configuration **degrades** (stage disabled, reason
`invalid_configuration`) instead of preventing the baseline API from
starting. The kill switch and mode changes take effect on process
restart; propagate them to every replica during an incident (§22.4).

## Modes

- **off** — baseline RRF ordering, zero egress.
- **shadow** — one real Score call is made (this is still external
  processing); results are recorded in `details.judgment` as a
  counterfactual; user-facing selection is unchanged and
  `config.reranker` stays null.
- **on** — candidates are reordered by descending expected score with
  baseline-rank tie-breaking; `details.config.reranker` names the
  rubric. Evidence membership never changes — only order.

## Failure semantics

Any of timeout, 429, 5xx, network error, oversized request/response,
schema rejection, or model mismatch yields **baseline ordering** (or a
`not_evaluated` outcome for future stages) with a safe reason in
diagnostics. There are no in-path retries. Five consecutive retryable
failures within 60s open a 30s circuit; 401/403 disables the credential
pending operator action. A cancelled run reports `cancelled`, never a
completed answer.

## Capacity scope limitation

Capacity counters and the breaker are **process-local**. The current
deployment runs API + workers in one process, which satisfies
shared-capacity semantics. Before running multiple replicas, replace
`src/services/jev/budget.ts` with Redis-backed expiring leases
(spec §10.5).

## Tests

```bash
pnpm test:jev              # offline suites (injected transport; no network, no key)
pnpm test:jev:integration  # real PostgreSQL required (docker compose --profile dev up -d)
pnpm test:jev:live         # explicit opt-in: TYPESAFE_LIVE_SMOKE=1 TYPESAFE_API_KEY=<test-key>
```

`test:jev:live` sends exactly one synthetic two-passage request and
prints the returned model, usage, and validation verdict. Run it and
record the results **before** enabling any workspace (spec §22.3
Stage B). What remains unverified until then: live provider contract,
actual account limits/rate behavior, and any quality/latency/cost
claims — those require the WP-05/WP-06 evaluation, not offline tests.
