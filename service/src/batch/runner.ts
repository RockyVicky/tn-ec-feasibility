import type { FastifyInstance } from "fastify";
import type { RequestStore } from "../store/types.ts";
import type { Batch, BatchRecordStatus } from "./types.ts";
import type { MemoryBatchStore } from "./store.ts";
import { cancelRun } from "../providers/automation-registry.ts";

const TERMINAL: BatchRecordStatus[] = ["completed", "partial", "failed"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// TYPICAL_DURATION_MS is only an estimate shown in the UI, not a guarantee.
// RECORD_TIMEOUT_MS is the hard cutoff (set to 1.5 min per explicit
// instruction): past this, the record is treated as stuck, its browser is
// forcibly cancelled (see automation-registry.ts — just "stopping the
// wait" without this would leave two automations fighting over the same
// persistent Chrome profile once the next record starts), and the batch
// moves on to the next record. Note this is tight relative to some
// observed real runs (modal-retry-recovery cases have taken longer than
// 90s) — expect more records to hit this cutoff and get skipped than with
// a longer grace period; that tradeoff was explicit, not a default.
const TYPICAL_DURATION_MS = 60_000;
const RECORD_TIMEOUT_MS = 90_000; // 1.5 min grace period, per explicit instruction

/** Runs every record in a batch strictly one at a time, in order — the
 * automation provider shares a single persistent Chrome profile, so two
 * records in flight at once will fight over it and kill each other
 * (confirmed live earlier in this project). Submits through the normal
 * POST /v1/ec-requests route via app.inject() rather than duplicating its
 * validation/idempotency/store-write logic here. */
// The router's circuit breaker (src/providers/router.ts) is shared across
// EVERY request, not scoped per batch — 3 consecutive failures from
// anything (even an unrelated manual test running at the same time) opens
// it for 60s, during which every request gets rejected instantly with this
// message before automation is even attempted. Confirmed live: a batch
// mid-run hit this and cascade-"failed" the rest of its own records within
// seconds, none of them ever reaching a CAPTCHA. Recognize it and wait the
// breaker out instead of treating it as a real per-record failure.
const BREAKER_MESSAGE = /no provider supports this request/i;
const BREAKER_COOLDOWN_MS = 65_000;

export function createBatchRunner(app: FastifyInstance, batchStore: MemoryBatchStore, store: RequestStore, tenantKey: string) {
  async function submitAndWait(batch: Batch, record: Batch["records"][number], attempt: number): Promise<{ st: BatchRecordStatus; failureMessage?: string }> {
    const payload = {
      searchType: "EC_WISE" as const,
      certified: false,
      property: { ...record.extracted },
      period: { from: record.periodFrom, to: record.periodTo },
      callbackUrl: "https://batch.invalid/webhook", // batch runs are polled, not webhook-driven
      reference: `batch-${batch.id}-${record.id}-a${attempt}`,
    };

    const res = await app.inject({
      method: "POST",
      url: "/v1/ec-requests",
      headers: {
        authorization: `Bearer ${tenantKey}`,
        // a fresh key per attempt - reusing the same one would just return
        // the prior (failed) result instead of actually retrying
        "idempotency-key": `batch-${batch.id}-${record.id}-a${attempt}`,
        "content-type": "application/json",
      },
      payload,
    });

    if (res.statusCode >= 400) {
      return { st: "failed", failureMessage: `submit failed: ${res.body}` };
    }
    const body = JSON.parse(res.body) as { requestId: string };
    const startedAt = Date.now();
    batchStore.updateRecord(batch.id, record.id, {
      requestId: body.requestId,
      status: "queued",
      startedAt: new Date(startedAt).toISOString(),
      estimatedEndAt: new Date(startedAt + TYPICAL_DURATION_MS).toISOString(),
      timeoutAt: new Date(startedAt + RECORD_TIMEOUT_MS).toISOString(),
    });

    const deadline = startedAt + RECORD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(3000);
      const rec = await store.get(body.requestId);
      if (!rec) continue;
      const st = rec.status.status as BatchRecordStatus;
      if (TERMINAL.includes(st)) {
        const pdfRef = rec.status.result?.provenance.rawArtifactRefs.find((r) => r.startsWith("file://"));
        if (pdfRef) batchStore.updateRecord(batch.id, record.id, { pdfPath: pdfRef.replace("file://", "") });
        return { st, failureMessage: rec.status.failure?.message };
      }
      batchStore.updateRecord(batch.id, record.id, { status: st });
    }
    // Stuck past the hard timeout — cancel its browser before moving on, so
    // the next record's automation doesn't launch a second browser against
    // the same still-alive persistent Chrome profile (see
    // automation-registry.ts). cancelRun() is a no-op if the run had
    // already finished between the last poll and here.
    const cancelled = await cancelRun(body.requestId).catch(() => false);
    return {
      st: "failed",
      failureMessage: `timed out after ${Math.round(RECORD_TIMEOUT_MS / 60_000)} min${cancelled ? " - cancelled, moved on" : " - already finished, result lost to the timeout"}`,
    };
  }

  async function runBatch(batch: Batch): Promise<void> {
    for (const record of batch.records) {
      let outcome: { st: BatchRecordStatus; failureMessage?: string } | undefined;
      for (let attempt = 1; attempt <= 3; attempt++) {
        outcome = await submitAndWait(batch, record, attempt);
        const isBreakerBlock = outcome.st === "failed" && outcome.failureMessage && BREAKER_MESSAGE.test(outcome.failureMessage);
        if (!isBreakerBlock || attempt === 3) break;
        batchStore.updateRecord(batch.id, record.id, { status: "queued", failureMessage: `provider temporarily unavailable - retrying in ${BREAKER_COOLDOWN_MS / 1000}s` });
        await sleep(BREAKER_COOLDOWN_MS);
      }
      batchStore.updateRecord(batch.id, record.id, { status: outcome!.st, failureMessage: outcome!.failureMessage });
    }
    batchStore.markCompleted(batch.id);
  }

  return { runBatch };
}
