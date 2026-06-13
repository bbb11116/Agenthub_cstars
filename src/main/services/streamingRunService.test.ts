import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, initializeDatabase } from "../db";
import { getDiffProposalsByConversation } from "../db/repositories/diffRepo";
import { getMessagesByConversation } from "../db/repositories/messageRepo";
import { getArtifactsByMessage } from "../db/repositories/messageArtifactRepo";
import type {
  AgentProviderAdapter,
  AgentProviderRunInput,
  AgentRunEvent,
  DiffProposalPayload
} from "../../shared/agentRunEvent";
import { runStreamingAgent } from "./streamingRunService";
import { createWorkspaceFromFolder } from "./workspaceService";
import { createSubAgentManually } from "./agentService";

let tempDir: string | null = null;

function createTempRoot(): string {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-streaming-run-"));
  return tempDir;
}

afterEach(() => {
  closeDatabase();

  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function buildUnifiedDiff(filePath: string, oldLine: string, newLine: string): string {
  return [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1,1 +1,1 @@",
    `-${oldLine}`,
    `+${newLine}`
  ].join("\n");
}

function buildAddedFileUnifiedDiff(filePath: string, content: string): string {
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return [
    "--- /dev/null",
    `+++ b/${filePath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`)
  ].join("\n");
}

function makeEvent<T extends AgentRunEvent["type"]>(
  runId: string,
  conversationId: string,
  seq: number,
  type: T,
  payload: Extract<AgentRunEvent, { type: T }>["payload"]
): Extract<AgentRunEvent, { type: T }> {
  return {
    id: `evt-${seq}`,
    runId,
    conversationId,
    seq,
    type,
    createdAt: new Date().toISOString(),
    payload
  } as Extract<AgentRunEvent, { type: T }>;
}

function fakeAdapter(script: (input: AgentProviderRunInput) => AsyncGenerator<AgentRunEvent>): AgentProviderAdapter {
  return {
    async *run(input: AgentProviderRunInput): AsyncIterable<AgentRunEvent> {
      yield* script(input);
    }
  };
}

async function drainRun(input: Parameters<typeof runStreamingAgent>[0]): Promise<AgentRunEvent[]> {
  const events: AgentRunEvent[] = [];
  for await (const event of runStreamingAgent(input)) {
    events.push(event);
  }
  return events;
}

describe("streamingRunService diff.proposal handling", () => {
  it("persists a diff_proposal row + diff_card message when the adapter emits diff.proposal", async () => {
    const rootPath = createTempRoot();
    const filePath = "src/App.tsx";
    const absoluteFile = path.join(rootPath, filePath);
    fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
    fs.writeFileSync(absoluteFile, "hello\n", "utf8");

    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgentManually({
      workspaceId: workspace.id,
      name: "Code Agent",
      provider: "mock",
      description: "Propose code diffs."
    });
    expect(agent.tools.writeDiff).toBe(true);

    const unifiedDiff = buildUnifiedDiff(filePath, "hello", "hello world");
    const events: AgentRunEvent[] = [];
    let capturedMessageId: string | null = null;

    const adapter = fakeAdapter(async function* (input) {
      const messageId = `msg-${input.runId}`;
      capturedMessageId = messageId;
      yield makeEvent(input.runId, input.conversationId, 0, "message.started", { messageId });
      yield makeEvent(input.runId, input.conversationId, 1, "message.delta", {
        messageId,
        delta: "I'll update the file.\n"
      });
      const proposalPayload: DiffProposalPayload = {
        proposalId: `prop-${input.runId}`,
        messageId,
        files: [
          { path: filePath, status: "modified", unifiedDiff }
        ]
      };
      yield makeEvent(input.runId, input.conversationId, 2, "diff.proposal", proposalPayload);
      yield makeEvent(input.runId, input.conversationId, 3, "message.completed", { messageId });
      yield makeEvent(input.runId, input.conversationId, 4, "run.completed", {
        messageId,
        status: "completed"
      });
    });

    const out: AgentRunEvent[] = [];
    for await (const event of runStreamingAgent(
      {
        workspaceId: workspace.id,
        agent,
        conversationId: conversation.id,
        rootPath,
        workspaceContextId: null,
        systemPrompt: "test",
        userMessage: "edit App.tsx",
        maxIterations: 1,
        silent: true,
        adapter
      }
    )) {
      out.push(event);
    }

    expect(capturedMessageId).not.toBeNull();
    expect(out.at(-1)?.type).toBe("run.completed");

    const proposals = getDiffProposalsByConversation(conversation.id);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].filePath).toBe(filePath);
    expect(proposals[0].diffContent).toBe(unifiedDiff);
    expect(proposals[0].newContent).toBe("hello world\n");

    const messages = getMessagesByConversation(conversation.id);
    const diffCard = messages.find((m) => m.messageType === "diff_card");
    expect(diffCard).toBeDefined();
    expect(diffCard?.content).toMatchObject({
      diffProposalId: proposals[0].id,
      filePath
    });

    // Regression: the message_artifact must still be created on the
    // streaming assistant message (not the new diff_card message).
    const assistantMessage = messages.find(
      (m) =>
        m.messageType === "text" &&
        typeof m.content === "object" &&
        m.content !== null &&
        "text" in m.content &&
        typeof (m.content as { text?: unknown }).text === "string" &&
        (m.content as { text: string }).text.includes("I'll update the file.")
    );
    expect(assistantMessage).toBeDefined();
    const artifacts = getArtifactsByMessage(assistantMessage!.id);
    const diffArtifact = artifacts.find((a) => a.type === "diff_proposal");
    expect(diffArtifact).toBeDefined();
  });

  it("creates one diff_card message per file for multi-file proposals", async () => {
    const rootPath = createTempRoot();
    const fileA = "src/A.tsx";
    const fileB = "src/B.tsx";
    fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, fileA), "A\n", "utf8");
    fs.writeFileSync(path.join(rootPath, fileB), "B\n", "utf8");

    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgentManually({
      workspaceId: workspace.id,
      name: "Code Agent",
      provider: "mock",
      description: "Propose code diffs."
    });

    const adapter = fakeAdapter(async function* (input) {
      const messageId = `msg-${input.runId}`;
      yield makeEvent(input.runId, input.conversationId, 0, "message.started", { messageId });
      yield makeEvent(input.runId, input.conversationId, 1, "diff.proposal", {
        proposalId: `prop-${input.runId}`,
        messageId,
        files: [
          { path: fileA, status: "modified", unifiedDiff: buildUnifiedDiff(fileA, "A", "A!") },
          { path: fileB, status: "modified", unifiedDiff: buildUnifiedDiff(fileB, "B", "B!") }
        ]
      });
      yield makeEvent(input.runId, input.conversationId, 2, "message.completed", { messageId });
      yield makeEvent(input.runId, input.conversationId, 3, "run.completed", {
        messageId,
        status: "completed"
      });
    });

    await drainRun({
      workspaceId: workspace.id,
      agent,
      conversationId: conversation.id,
      rootPath,
      workspaceContextId: null,
      systemPrompt: "test",
      userMessage: "edit A and B",
      maxIterations: 1,
      silent: true,
      adapter
    });

    const proposals = getDiffProposalsByConversation(conversation.id);
    expect(proposals).toHaveLength(2);
    const diffCardMessages = getMessagesByConversation(conversation.id).filter(
      (m) => m.messageType === "diff_card"
    );
    expect(diffCardMessages).toHaveLength(2);
    const proposalIds = new Set(proposals.map((p) => p.id));
    for (const message of diffCardMessages) {
      const content = message.content as { diffProposalId: string; filePath: string };
      expect(proposalIds.has(content.diffProposalId)).toBe(true);
    }
  });

  it("skips files whose diff does not apply and continues with the rest", async () => {
    const rootPath = createTempRoot();
    const goodFile = "src/Good.tsx";
    const badFile = "src/Bad.tsx";
    fs.mkdirSync(path.join(rootPath, "src"), { recursive: true });
    fs.writeFileSync(path.join(rootPath, goodFile), "ok\n", "utf8");
    fs.writeFileSync(path.join(rootPath, badFile), "untouched\n", "utf8");

    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgentManually({
      workspaceId: workspace.id,
      name: "Code Agent",
      provider: "mock",
      description: "Propose code diffs."
    });

    const brokenDiff = buildUnifiedDiff(badFile, "completely-different-content", "X");

    const adapter = fakeAdapter(async function* (input) {
      const messageId = `msg-${input.runId}`;
      yield makeEvent(input.runId, input.conversationId, 0, "message.started", { messageId });
      yield makeEvent(input.runId, input.conversationId, 1, "diff.proposal", {
        proposalId: `prop-${input.runId}`,
        messageId,
        files: [
          { path: goodFile, status: "modified", unifiedDiff: buildUnifiedDiff(goodFile, "ok", "ok!") },
          { path: badFile, status: "modified", unifiedDiff: brokenDiff }
        ]
      });
      yield makeEvent(input.runId, input.conversationId, 2, "message.completed", { messageId });
      yield makeEvent(input.runId, input.conversationId, 3, "run.completed", {
        messageId,
        status: "completed"
      });
    });

    const events = await drainRun({
      workspaceId: workspace.id,
      agent,
      conversationId: conversation.id,
      rootPath,
      workspaceContextId: null,
      systemPrompt: "test",
      userMessage: "edit Good and Bad",
      maxIterations: 1,
      silent: true,
      adapter
    });

    // Run should still complete cleanly even though one patch didn't apply.
    expect(events.at(-1)?.type).toBe("run.completed");

    const proposals = getDiffProposalsByConversation(conversation.id);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].filePath).toBe(goodFile);

    const diffCardMessages = getMessagesByConversation(conversation.id).filter(
      (m) => m.messageType === "diff_card"
    );
    expect(diffCardMessages).toHaveLength(1);
  });

  it("does not create a proposal when the diff.proposal event has no files", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgentManually({
      workspaceId: workspace.id,
      name: "Code Agent",
      provider: "mock",
      description: "Propose code diffs."
    });

    const adapter = fakeAdapter(async function* (input) {
      const messageId = `msg-${input.runId}`;
      yield makeEvent(input.runId, input.conversationId, 0, "message.started", { messageId });
      yield makeEvent(input.runId, input.conversationId, 1, "diff.proposal", {
        proposalId: `prop-${input.runId}`,
        messageId,
        files: []
      });
      yield makeEvent(input.runId, input.conversationId, 2, "message.completed", { messageId });
      yield makeEvent(input.runId, input.conversationId, 3, "run.completed", {
        messageId,
        status: "completed"
      });
    });

    await drainRun({
      workspaceId: workspace.id,
      agent,
      conversationId: conversation.id,
      rootPath,
      workspaceContextId: null,
      systemPrompt: "test",
      userMessage: "no-op",
      maxIterations: 1,
      silent: true,
      adapter
    });

    expect(getDiffProposalsByConversation(conversation.id)).toEqual([]);
    expect(
      getMessagesByConversation(conversation.id).filter((m) => m.messageType === "diff_card")
    ).toEqual([]);
  });

  it("auto-creates an artifact_preview when the LLM adds an .html file via diff.proposal", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgentManually({
      workspaceId: workspace.id,
      name: "Preview Agent",
      provider: "mock",
      description: "Produce preview HTML."
    });

    const filePath = "previews/intro.html";
    const htmlContent = "<h1>Slide 1</h1>\n<p>hello</p>";
    const unifiedDiff = buildAddedFileUnifiedDiff(filePath, htmlContent);

    const adapter = fakeAdapter(async function* (input) {
      const messageId = `msg-${input.runId}`;
      yield makeEvent(input.runId, input.conversationId, 0, "message.started", { messageId });
      yield makeEvent(input.runId, input.conversationId, 1, "diff.proposal", {
        proposalId: `prop-${input.runId}`,
        messageId,
        files: [{ path: filePath, status: "added", unifiedDiff }]
      });
      yield makeEvent(input.runId, input.conversationId, 2, "message.completed", { messageId });
      yield makeEvent(input.runId, input.conversationId, 3, "run.completed", {
        messageId,
        status: "completed"
      });
    });

    await drainRun({
      workspaceId: workspace.id,
      agent,
      conversationId: conversation.id,
      rootPath,
      workspaceContextId: null,
      systemPrompt: "test",
      userMessage: "make a preview",
      maxIterations: 1,
      silent: true,
      adapter
    });

    const messages = getMessagesByConversation(conversation.id);
    const assistantMessage = messages.find(
      (m) => m.senderType === "agent" && m.messageType === "text"
    );
    expect(assistantMessage).toBeDefined();
    const artifacts = getArtifactsByMessage(assistantMessage!.id);
    const previewArtifact = artifacts.find((a) => a.type === "artifact_preview");
    expect(previewArtifact).toBeDefined();
    const payload = previewArtifact!.payload as {
      title: string;
      artifactType: string;
      renderMode: string;
      filePath: string;
    };
    expect(payload.title).toBe(filePath);
    expect(payload.artifactType).toBe("html");
    expect(payload.renderMode).toBe("html_iframe");
    expect(payload.filePath).toBe(filePath);
  });

  it("does not auto-create an artifact_preview for modified HTML files (only added files)", async () => {
    const rootPath = createTempRoot();
    const filePath = "src/existing.html";
    const absoluteFile = path.join(rootPath, filePath);
    fs.mkdirSync(path.dirname(absoluteFile), { recursive: true });
    fs.writeFileSync(absoluteFile, "<p>old</p>\n", "utf8");

    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgentManually({
      workspaceId: workspace.id,
      name: "Editor Agent",
      provider: "mock",
      description: "Edit files."
    });

    const adapter = fakeAdapter(async function* (input) {
      const messageId = `msg-${input.runId}`;
      yield makeEvent(input.runId, input.conversationId, 0, "message.started", { messageId });
      yield makeEvent(input.runId, input.conversationId, 1, "diff.proposal", {
        proposalId: `prop-${input.runId}`,
        messageId,
        files: [
          { path: filePath, status: "modified", unifiedDiff: buildUnifiedDiff(filePath, "<p>old</p>", "<p>new</p>") }
        ]
      });
      yield makeEvent(input.runId, input.conversationId, 2, "message.completed", { messageId });
      yield makeEvent(input.runId, input.conversationId, 3, "run.completed", {
        messageId,
        status: "completed"
      });
    });

    await drainRun({
      workspaceId: workspace.id,
      agent,
      conversationId: conversation.id,
      rootPath,
      workspaceContextId: null,
      systemPrompt: "test",
      userMessage: "edit",
      maxIterations: 1,
      silent: true,
      adapter
    });

    const messages = getMessagesByConversation(conversation.id);
    const assistantMessage = messages.find(
      (m) => m.senderType === "agent" && m.messageType === "text"
    );
    expect(assistantMessage).toBeDefined();
    const artifacts = getArtifactsByMessage(assistantMessage!.id);
    const previewArtifact = artifacts.find((a) => a.type === "artifact_preview");
    expect(previewArtifact).toBeUndefined();
  });

  it("does not auto-create an artifact_preview for added non-HTML files", async () => {
    const rootPath = createTempRoot();
    initializeDatabase({ dbPath: path.join(rootPath, "agenthub.db") });
    const { workspace } = await createWorkspaceFromFolder({
      rootPath,
      mainAgentRuntimeProvider: "mock"
    });
    const { agent, conversation } = createSubAgentManually({
      workspaceId: workspace.id,
      name: "Code Agent",
      provider: "mock",
      description: "Write code."
    });

    const filePath = "src/util.py";
    const content = "def hello():\n    return 1\n";
    const unifiedDiff = buildAddedFileUnifiedDiff(filePath, content);

    const adapter = fakeAdapter(async function* (input) {
      const messageId = `msg-${input.runId}`;
      yield makeEvent(input.runId, input.conversationId, 0, "message.started", { messageId });
      yield makeEvent(input.runId, input.conversationId, 1, "diff.proposal", {
        proposalId: `prop-${input.runId}`,
        messageId,
        files: [{ path: filePath, status: "added", unifiedDiff }]
      });
      yield makeEvent(input.runId, input.conversationId, 2, "message.completed", { messageId });
      yield makeEvent(input.runId, input.conversationId, 3, "run.completed", {
        messageId,
        status: "completed"
      });
    });

    await drainRun({
      workspaceId: workspace.id,
      agent,
      conversationId: conversation.id,
      rootPath,
      workspaceContextId: null,
      systemPrompt: "test",
      userMessage: "write util",
      maxIterations: 1,
      silent: true,
      adapter
    });

    const messages = getMessagesByConversation(conversation.id);
    const assistantMessage = messages.find(
      (m) => m.senderType === "agent" && m.messageType === "text"
    );
    expect(assistantMessage).toBeDefined();
    const artifacts = getArtifactsByMessage(assistantMessage!.id);
    const previewArtifact = artifacts.find((a) => a.type === "artifact_preview");
    expect(previewArtifact).toBeUndefined();
  });
});
