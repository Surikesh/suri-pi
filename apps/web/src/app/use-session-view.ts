import { useMemo } from "react";
import {
  activePhases,
  initialProjection,
  type Data,
  type Message,
} from "../../../../packages/protocol/src/index.js";
import type { State } from "../store.js";
import { changedFilesByMessage } from "../change-review.js";
import { LIVE_TRANSCRIPT_MESSAGE_LIMIT } from "../features/transcript/index.js";
import {
  copyableMessageText,
  mergeTranscriptMessages,
  transcriptEntries,
} from "../domain/presentation.js";

export function useSessionView({
  state,
  visibleOlder,
}: {
  state: State;
  visibleOlder: Message[];
}) {
  const session = state.catalog.sessions.find(
    (s: Data) => s.id === state.selected,
  );
  const projection =
    state.projections[state.selected ?? ""] ?? initialProjection();
  const conversationMessages = useMemo(
    () =>
      projection.messages.filter(
        (message) => message.role === "user" || message.role === "assistant",
      ),
    [projection.messages],
  );
  const transcriptMessages = useMemo(
    () =>
      mergeTranscriptMessages(
        visibleOlder,
        conversationMessages.slice(-LIVE_TRANSCRIPT_MESSAGE_LIMIT),
      ),
    [visibleOlder, conversationMessages],
  );
  const transcriptItems = useMemo(
    () => transcriptEntries(transcriptMessages),
    [transcriptMessages],
  );
  const turnMarks = useMemo(
    () =>
      transcriptItems.flatMap((entry) => {
        if (entry.kind !== "message" || entry.message.role !== "user")
          return [];
        return [
          {
            id: entry.message.messageId,
            preview:
              copyableMessageText(entry.message.blocks)
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 96) || "Attachment",
          },
        ];
      }),
    [transcriptItems],
  );
  const running = activePhases.has(projection.phase);
  const queueable = ["starting", "running", "waiting", "retrying"].includes(
    projection.phase,
  );
  const workspace = state.catalog.workspaces.find(
    (w: Data) => w.id === session?.workspaceId,
  );
  const currentProject = state.catalog.projects.find(
    (project: Data) => project.id === workspace?.projectId,
  );
  const changedByMessage = useMemo(
    () =>
      changedFilesByMessage(
        conversationMessages,
        projection.tools,
        workspace?.root,
      ),
    [conversationMessages, projection.tools, workspace?.root],
  );
  return {
    session,
    projection,
    conversationMessages,
    transcriptMessages,
    transcriptItems,
    turnMarks,
    running,
    queueable,
    workspace,
    currentProject,
    changedByMessage,
  };
}

export type SessionView = ReturnType<typeof useSessionView>;
