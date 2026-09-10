/**
 * Postgres-backed RequestStore — Phase 1 implementation sketch.
 *
 * Not wired into the default build (BACKEND=memory). Kept here so the schema and
 * query shape are reviewable now. To activate: add `pg` to dependencies, set
 * BACKEND=postgres+redis, and register this in src/app.ts.
 *
 * Schema:
 *
 *   CREATE TABLE ec_requests (
 *     request_id       uuid PRIMARY KEY,
 *     idempotency_key  text UNIQUE NOT NULL,
 *     param_hash       text NOT NULL,
 *     status           text NOT NULL,
 *     certified        boolean NOT NULL,
 *     reference        text,
 *     request_json     jsonb NOT NULL,
 *     status_json      jsonb NOT NULL,
 *     created_at       timestamptz NOT NULL DEFAULT now(),
 *     updated_at       timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE INDEX ec_requests_param_hash_idx ON ec_requests (param_hash, created_at DESC)
 *     WHERE status = 'completed';
 *
 *   CREATE TABLE ec_request_audit (
 *     id          bigserial PRIMARY KEY,
 *     request_id  uuid NOT NULL REFERENCES ec_requests(request_id),
 *     at          timestamptz NOT NULL DEFAULT now(),
 *     event       text NOT NULL,
 *     detail      jsonb
 *   );
 */
import type { RequestStore, StoredRequest } from "./types.ts";
import type { RequestStatus } from "../contract.ts";

export class PostgresRequestStore implements RequestStore {
  constructor(private readonly _databaseUrl: string) {}

  private nyi(): never {
    throw new Error("PostgresRequestStore not implemented — see file header. Use BACKEND=memory for now.");
  }
  async create(_rec: StoredRequest): Promise<void> { this.nyi(); }
  async get(_requestId: string): Promise<StoredRequest | undefined> { this.nyi(); }
  async update(_requestId: string, _patch: Partial<RequestStatus>, _auditEvent: string, _detail?: unknown): Promise<StoredRequest> { this.nyi(); }
  async findByIdempotencyKey(_key: string): Promise<StoredRequest | undefined> { this.nyi(); }
  async findRecentByParamHash(_paramHash: string, _since: Date): Promise<StoredRequest | undefined> { this.nyi(); }
}
