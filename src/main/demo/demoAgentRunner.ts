import type { Artifact } from "../../shared/artifact";
import type { DiffProposal } from "../../shared/diff";
import type { Message } from "../../shared/domain";
import { getDatabase, type AgentHubDatabase } from "../db";
import { getArtifactsByWorkspace } from "../db/repositories/artifactRepo";
import { getMessagesByConversation } from "../db/repositories/messageRepo";
import { createArtifact } from "../services/artifactService";
import { createDiffProposal, DiffServiceError } from "../services/diffService";
import { createMessage } from "../services/messageService";
import { readWorkspaceFile } from "../services/fileService";
import { DEMO_APP_RELATIVE_PATH } from "./demoFixtures";

export type MockAgentTaskInput = {
  workspaceId: string;
  agentId: string;
  conversationId: string;
  userMessage: string;
};

export type MockAgentTaskOutput = {
  messages: Message[];
  diffProposal?: DiffProposal;
  artifacts?: Artifact[];
};

const TARGET_FILE_MISSING_TEXT = "请选择包含 src/App.tsx 的 React 项目后再运行 Demo。";
const TARGET_BUTTON_MISSING_TEXT = "Mock Demo 需要 src/App.tsx 中包含一个 button 元素。";

function createBlueButtonPreviewHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <style>
      body {
        display: grid;
        min-height: 100vh;
        margin: 0;
        place-items: center;
        background: #f8fafc;
        font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      }

      .preview {
        display: grid;
        gap: 16px;
        text-align: center;
      }

      button {
        min-height: 44px;
        padding: 0 18px;
        border: 1px solid #1d4ed8;
        border-radius: 8px;
        color: #ffffff;
        background: #2563eb;
        font-weight: 800;
      }
    </style>
  </head>
  <body>
    <main class="preview">
      <strong>Preview artifact</strong>
      <button type="button">Start demo</button>
    </main>
  </body>
</html>`;
}

function hasButtonStyleIntent(userMessage: string): boolean {
  return /button|按钮|蓝|blue|style|样式|首页/i.test(userMessage);
}

function applyBlueButtonStyle(content: string): string | null {
  const buttonMatch = content.match(/<button\b([^>]*)>/i);

  if (!buttonMatch || buttonMatch.index === undefined) {
    return null;
  }

  const attrs = buttonMatch[1] ?? "";
  const styleAttribute =
    'style={{ backgroundColor: "#2563eb", color: "#ffffff", borderColor: "#1d4ed8" }}';
  const nextAttrs = /\sstyle=\{\{[^}]*\}\}/.test(attrs)
    ? attrs.replace(/\sstyle=\{\{[^}]*\}\}/, ` ${styleAttribute}`)
    : `${attrs} ${styleAttribute}`;
  const nextButtonTag = `<button${nextAttrs}>`;

  return `${content.slice(0, buttonMatch.index)}${nextButtonTag}${content.slice(
    buttonMatch.index + buttonMatch[0].length
  )}`;
}

function getNewRecords<T extends { id: string }>(before: T[], after: T[]): T[] {
  const beforeIds = new Set(before.map((item) => item.id));
  return after.filter((item) => !beforeIds.has(item.id));
}

function createAgentTextMessage(
  input: MockAgentTaskInput,
  text: string,
  db: AgentHubDatabase
): Message {
  return createMessage(
    {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      senderType: "agent",
      senderId: input.agentId,
      messageType: "text",
      content: {
        text
      }
    },
    db
  );
}

function toTargetFileMessage(error: unknown): string {
  if (error instanceof DiffServiceError && error.code === "FILE_NOT_FOUND") {
    return TARGET_FILE_MISSING_TEXT;
  }

  if (error instanceof Error && /does not exist|enoent|not found/i.test(error.message)) {
    return TARGET_FILE_MISSING_TEXT;
  }

  return error instanceof Error ? error.message : "Mock Agent failed to generate a diff.";
}

export async function runMockAgentTask(
  input: MockAgentTaskInput,
  db: AgentHubDatabase = getDatabase()
): Promise<MockAgentTaskOutput> {
  const messagesBefore = getMessagesByConversation(input.conversationId, db);
  const artifactsBefore = getArtifactsByWorkspace(input.workspaceId, db);

  if (!hasButtonStyleIntent(input.userMessage)) {
    const message = createAgentTextMessage(
      input,
      "Mock Runner 已就绪。请输入“把首页按钮改成蓝色”来生成固定 Diff。",
      db
    );

    return {
      messages: [message]
    };
  }

  try {
    const file = await readWorkspaceFile(
      {
        workspaceId: input.workspaceId,
        relativePath: DEMO_APP_RELATIVE_PATH
      },
      db
    );
    const newContent = applyBlueButtonStyle(file.content);

    if (!newContent) {
      return {
        messages: [
          createAgentTextMessage(input, TARGET_BUTTON_MISSING_TEXT, db)
        ]
      };
    }

    createAgentTextMessage(
      input,
      "已读取 src/App.tsx，并准备生成按钮改为蓝色的 DiffProposal。",
      db
    );

    const proposal = await createDiffProposal(
      {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        filePath: DEMO_APP_RELATIVE_PATH,
        newContent
      },
      db
    );

    const previewArtifact = createArtifact(
      {
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        type: "html",
        title: "Blue button preview",
        content: createBlueButtonPreviewHtml(),
        language: "html",
        filePath: "src/App.tsx"
      },
      db
    );

    return {
      messages: getNewRecords(
        messagesBefore,
        getMessagesByConversation(input.conversationId, db)
      ),
      diffProposal: proposal,
      artifacts: [
        previewArtifact,
        ...getNewRecords(artifactsBefore, getArtifactsByWorkspace(input.workspaceId, db)).filter(
          (artifact) => artifact.id !== previewArtifact.id
        )
      ]
    };
  } catch (error) {
    createAgentTextMessage(input, toTargetFileMessage(error), db);

    return {
      messages: getNewRecords(
        messagesBefore,
        getMessagesByConversation(input.conversationId, db)
      )
    };
  }
}
