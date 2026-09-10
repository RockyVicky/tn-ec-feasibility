import type { RequestStore } from "./store/types.ts";
import type { ProviderRouter } from "./providers/router.ts";
import type { WebhookDeliverer } from "./webhook/deliver.ts";
import type { HitlStore } from "./hitl/types.ts";
import { ProviderError } from "./providers/types.ts";
import { MasterDataError, resolveUnit } from "./masterdata/index.ts";
import type { Config } from "./config.ts";
import type { FailureCode, RequestStatus, WebhookEventName } from "./contract.ts";

type Logger = (event: string, data?: Record<string, unknown>) => void;

export interface Pipeline {
  run(requestId: string): Promise<void>;
}

export function createPipeline(deps: {
  store: RequestStore;
  router: ProviderRouter;
  webhooks: WebhookDeliverer;
  hitl: HitlStore;
  config: Config;
  log: Logger;
}): Pipeline {
  const { store, router, webhooks, hitl, config, log } = deps;

  async function emit(event: WebhookEventName, status: RequestStatus, callbackUrl: string): Promise<void> {
    void webhooks.send(event, status, callbackUrl);
  }

  async function fail(requestId: string, code: FailureCode, message: string, retryable: boolean, callbackUrl: string): Promise<void> {
    const rec = await store.update(
      requestId,
      { status: "failed", completedAt: new Date().toISOString(), failure: { code, message, retryable, operatorNote: null } },
      "failed",
      { code, message },
    );
    await emit("ec.failed", rec.status, callbackUrl);
  }

  return {
    async run(requestId: string): Promise<void> {
      const rec = await store.get(requestId);
      if (!rec) {
        log("pipeline.missing_request", { requestId });
        return;
      }
      const { request: req } = rec;

      // 1. resolve master data (turns a bad SRO into a clean 'unresolvable' failure)
      try {
        const unit = resolveUnit({ zone: req.property.zone, district: req.property.district, sro: req.property.sroCode });
        req.property.zone = unit.zone;
        req.property.district = unit.district;
        req.property.sroCode = unit.sroCode;
      } catch (err) {
        if (err instanceof MasterDataError) {
          await fail(requestId, "unresolvable", err.message, false, req.callbackUrl);
          return;
        }
        throw err;
      }

      // 2. dedupe (informational only)
      if (!req.certified && config.dedupeWindowDays > 0) {
        const since = new Date(Date.now() - config.dedupeWindowDays * 86_400_000);
        const hit = await store.findRecentByParamHash(rec.paramHash, since);
        if (hit?.status.result) {
          const rec2 = await store.update(
            requestId,
            { status: "completed", completedAt: new Date().toISOString(), source: hit.status.source, result: hit.status.result, documents: hit.status.documents },
            "dedupe_hit",
            { servedFrom: hit.status.requestId },
          );
          await emit("ec.completed", rec2.status, req.callbackUrl);
          return;
        }
      }

      // 3. mark in progress
      await store.update(requestId, { status: "in_progress" }, "in_progress");

      // 4. retrieve via provider router
      let result: RequestStatus["result"];
      let provider: string;
      try {
        const out = await router.retrieve(req, {
          requestId,
          log: (e, d) => log(e, { requestId, ...d }),
          requestHuman: async (task) => {
            const opened = await hitl.open({ ...task, requestId, context: task.context ?? {} });
            await store.update(requestId, { status: "needs_human" }, "needs_human", { taskId: opened.id, kind: opened.kind });
            const current = await store.get(requestId);
            if (current) await emit("ec.needs_human", current.status, req.callbackUrl);
            const answer = await hitl.await(opened.id, 15 * 60_000);
            await store.update(requestId, { status: "in_progress" }, "human_answered", { taskId: opened.id });
            return answer;
          },
        });
        result = out.result;
        provider = out.provider;
      } catch (err) {
        if (err instanceof ProviderError) {
          const map: Record<string, FailureCode> = {
            unsupported: "unresolvable",
            portal_unavailable: "portal_unavailable",
            provider_error: "provider_error",
            no_records_unconfirmed: "no_records_unconfirmed",
            payment_required: "payment_required",
            not_digitised: "not_digitised",
            captcha_unrecoverable: "captcha_unrecoverable",
            timeout: "timeout",
          };
          await fail(requestId, map[err.code] ?? "provider_error", err.message, err.retryable, req.callbackUrl);
        } else {
          await fail(requestId, "provider_error", (err as Error).message, true, req.callbackUrl);
        }
        return;
      }

      // 5. terminal state
      const partial =
        result.outcome === "NIL_UNCONFIRMED" ||
        result.outcome === "PERIOD_GAP" ||
        result.caveats.some((c) => c.code === "OCR_LOW_CONFIDENCE" || c.code === "PARTIAL_PERIOD_DIGITISED");

      const status: RequestStatus["status"] = partial ? "partial" : "completed";
      const rec2 = await store.update(
        requestId,
        { status, completedAt: new Date().toISOString(), source: provider, result, documents: [] },
        status,
        { provider, outcome: result.outcome },
      );
      await emit(partial ? "ec.partial" : "ec.completed", rec2.status, req.callbackUrl);
    },
  };
}
