import type { CreateArtifactDiffInput } from "../../shared/artifact";
import type { DiffProposal } from "../../shared/diff";
import { getDatabase, type AgentHubDatabase } from "../db";
import { getArtifactById } from "../db/repositories/artifactRepo";
import { createDiffProposal } from "./diffService";

export async function createDiffProposalFromArtifact(
  input: CreateArtifactDiffInput,
  db: AgentHubDatabase = getDatabase()
): Promise<DiffProposal> {
  const artifact = getArtifactById(input.artifactId, db);

  if (!artifact) {
    throw new Error("Artifact not found.");
  }

  if (!artifact.filePath) {
    throw new Error("Artifact has no file path to diff against.");
  }

  return createDiffProposal(
    {
      workspaceId: artifact.workspaceId,
      agentId: input.agentId ?? artifact.agentId,
      conversationId: artifact.conversationId,
      filePath: artifact.filePath,
      newContent: artifact.content
    },
    db
  );
}
