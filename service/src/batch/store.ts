import type { Batch, BatchRecord } from "./types.ts";

/** In-process batch store — mirrors store/memory.ts's pattern. Batches don't need
 * to survive a server restart; they're a short-lived upload-review-run workflow. */
export class MemoryBatchStore {
  private batches = new Map<string, Batch>();

  create(batch: Batch): void {
    this.batches.set(batch.id, batch);
  }

  get(id: string): Batch | undefined {
    return this.batches.get(id);
  }

  list(): Batch[] {
    return [...this.batches.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  updateRecord(batchId: string, recordId: string, patch: Partial<BatchRecord>): BatchRecord | undefined {
    const batch = this.batches.get(batchId);
    const rec = batch?.records.find((r) => r.id === recordId);
    if (!rec) return undefined;
    Object.assign(rec, patch);
    return rec;
  }

  /** Atomic check-and-set — the route handler used to check `batch.started`
   * and set it in two separate steps, which left a window for two
   * near-simultaneous "Start Batch" requests (e.g. a double-click) to both
   * pass the check before either flipped the flag, launching two copies of
   * the batch runner in parallel. They'd then submit records independently
   * and fight over the single shared browser profile - confirmed live as
   * the cause of a batch run that failed almost every record instantly.
   * Returns false (and does nothing) if the batch was already started. */
  tryMarkStarted(batchId: string): boolean {
    const batch = this.batches.get(batchId);
    if (!batch || batch.started) return false;
    batch.started = true;
    return true;
  }

  markCompleted(batchId: string): void {
    const batch = this.batches.get(batchId);
    if (batch) batch.completedAt = new Date().toISOString();
  }
}
