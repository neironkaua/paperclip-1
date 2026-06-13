import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

// Mock run-log store so we can simulate read errors without real files
vi.mock("../services/run-log-store.js", () => ({
  getRunLogStore: vi.fn(),
}));

import { getRunLogStore } from "../services/run-log-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe.sequential : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping issue comment enrichment isolation tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("issue comment enrichment error isolation (ANT-2446)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-comment-enrichment-isolation-");
    db = createDb(tempDb.connectionString);
    await db.execute(sql.raw("CREATE EXTENSION IF NOT EXISTS pg_trgm"));
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(companyMemberships);
    await db.delete(companies);
    vi.resetAllMocks();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedScenario() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Enrichment Isolation Co",
      issuePrefix: `EI${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "board-user-1",
      status: "active",
      membershipRole: "owner",
      updatedAt: new Date(),
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "EI-1",
      title: "Enrichment isolation test",
      status: "todo",
      priority: "medium",
    });

    // User-authored comment with no runId — triggers derived attribution path
    const commentId = randomUUID();
    await db.insert(issueComments).values({
      id: commentId,
      companyId,
      issueId,
      authorUserId: "board-user-1",
      body: "human comment, no runId",
    });

    // Heartbeat run overlapping the comment timestamp so enrichment queries for logs
    const runId = randomUUID();
    const now = new Date();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "done",
      createdAt: new Date(now.getTime() - 5_000),
      startedAt: new Date(now.getTime() - 5_000),
      finishedAt: new Date(now.getTime() + 5_000),
      logStore: "local_file",
      logRef: "fake/run.ndjson",
      logBytes: 1024,
      contextSnapshot: { issueId },
    });

    return { companyId, issueId, commentId };
  }

  it("listComments returns comments without throwing when run-log read fails with a non-404 error", async () => {
    const { issueId, commentId } = await seedScenario();

    // Simulate ENOENT / store error — any non-404 error must be swallowed
    vi.mocked(getRunLogStore).mockReturnValue({
      read: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" })),
      begin: vi.fn(),
      append: vi.fn(),
      finalize: vi.fn(),
    } as any);

    // Must not throw — must return comments list (blast-radius isolation)
    const comments = await issueService(db).listComments(issueId, { order: "asc" });

    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      id: commentId,
      body: "human comment, no runId",
    });
  });

  it("getComment returns comment without throwing when run-log read fails", async () => {
    const { commentId } = await seedScenario();

    vi.mocked(getRunLogStore).mockReturnValue({
      read: vi.fn().mockRejectedValue(new Error("log store unavailable")),
      begin: vi.fn(),
      append: vi.fn(),
      finalize: vi.fn(),
    } as any);

    const comment = await issueService(db).getComment(commentId);
    expect(comment).not.toBeNull();
    expect(comment?.id).toBe(commentId);
  });
});
