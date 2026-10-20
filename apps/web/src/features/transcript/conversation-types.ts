import type React from "react";
import type {
  Data,
  Message,
  initialProjection,
} from "../../../../../packages/protocol/src/index.js";
import type { useFileMenu } from "../menus/index.js";
import type { State } from "../../store.js";
import type { createScrollPositionWriter } from "../../scroll-position.js";
import type { TranscriptEntry } from "../../domain/presentation.js";

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export interface ConversationProps {
  state: State;
  session: Data | undefined;
  workspace: Data | undefined;
  projection: ReturnType<typeof initialProjection>;
  historyOwner: string | undefined;
  restoringScroll: { current: boolean };
  readingAnchors: { current: Map<string, { id: string; offset: number }> };
  scroll: React.RefObject<HTMLDivElement | null>;
  lastScrollMetrics: {
    current: { height: number; top: number } | undefined;
  };
  latestRef: { current: boolean };
  scrollWriter: {
    current: ReturnType<typeof createScrollPositionWriter> | undefined;
  };
  cancelScrollRestoration: { current: (() => void) | undefined };
  setAtLatest: (value: boolean) => void;
  jumpToLatest: React.RefObject<HTMLButtonElement | null>;
  composerRail: React.RefObject<HTMLDivElement | null>;
  visibleHistoryCursor: number | null | undefined;
  visibleOlder: Message[];
  historyLoading: boolean;
  setHistoryLoading: Setter<boolean>;
  historyRequest: { current: number };
  latestJumpGeneration: { current: number };
  historyCache: {
    current: Map<
      string,
      { messages: Message[]; cursor: number | null | undefined }
    >;
  };
  setOlder: Setter<Message[]>;
  setHistoryCursor: Setter<number | null | undefined>;
  transcriptMessages: Message[];
  transcriptItems: TranscriptEntry[];
  turnMarks: Array<{ id: string; preview: string }>;
  changedByMessage: Map<string, string[]>;
  previewImage: (asset: Data, trigger: HTMLElement) => void;
  executeInTerminal: (text: string) => void;
  pinChange: (path: string) => void;
  fileAction: (
    path: string,
    type: "open" | "openWith" | "reveal" | "copy" | "copyPath",
    targetWorkspace?: Data,
    absolutePath?: string,
  ) => Promise<void>;
  setFileMenu: ReturnType<typeof useFileMenu>["setFileMenu"];
  setFileMenuStatus: (value: string) => void;
  draft: string;
  setDraft: Setter<string>;
  dismissedNotices: Set<string>;
  setDismissedNotices: Setter<Set<string>>;
  act: (fn: () => Promise<unknown>) => Promise<unknown>;
  create: (workspaceId?: string) => Promise<unknown>;
  children?: React.ReactNode;
}
