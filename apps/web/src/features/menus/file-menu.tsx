import React from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { Icon } from "../../components/ui.js";
import { type useFileMenu } from "./use-menus.js";

type FileMenuState = ReturnType<typeof useFileMenu>["fileMenu"];

export function FileMenu({
  fileMenu,
  fileMenuStatus,
  fileMenuWorkspace,
  closeFileMenu,
  setLinkedFile,
  pinChange,
  setDetails,
  setRequestedFile,
  fileAction,
}: {
  fileMenu: FileMenuState;
  fileMenuStatus: string;
  fileMenuWorkspace: Data | undefined;
  closeFileMenu: () => void;
  setLinkedFile: (value: Data) => void;
  pinChange: (path: string) => void;
  setDetails: (value: boolean) => void;
  setRequestedFile: (value: { path: string; requestId: number }) => void;
  fileAction: (
    path: string,
    type: "open" | "openWith" | "reveal" | "copy" | "copyPath",
    targetWorkspace?: Data,
    absolutePath?: string,
  ) => Promise<void>;
}) {
  return (
    <>
      {fileMenu && (
        <div
          className="session-menu file-context-menu"
          role="menu"
          aria-label={`Actions for ${fileMenu.path}`}
          style={{ left: fileMenu.x, top: fileMenu.y }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              closeFileMenu();
            }
          }}
        >
          <strong title={fileMenu.path}>{fileMenu.path}</strong>
          {(fileMenuStatus || !fileMenuWorkspace) && (
            <p role="status" className="file-menu-status">
              {fileMenuStatus ||
                "External files require confirmation before Suri reads them."}
            </p>
          )}
          <button
            autoFocus
            role="menuitem"
            onClick={() => {
              if (
                !fileMenuWorkspace &&
                !window.confirm(
                  `Allow Suri to read this file?\n\n${fileMenu.absolutePath}`,
                )
              )
                return;
              setLinkedFile({
                workspaceId: fileMenuWorkspace?.id,
                path: fileMenuWorkspace ? fileMenu.path : fileMenu.absolutePath,
              });
              closeFileMenu();
            }}
          >
            Preview
          </button>
          {fileMenu.source === "changes" && (
            <button
              role="menuitem"
              onClick={() => {
                pinChange(fileMenu.path);
                closeFileMenu();
              }}
            >
              Review changes
            </button>
          )}
          <button
            role="menuitem"
            onClick={() => {
              if (fileMenuWorkspace) {
                setDetails(true);
                setRequestedFile({
                  path: fileMenu.path,
                  requestId: performance.now(),
                });
                closeFileMenu();
              } else {
                void fileAction(
                  fileMenu.path,
                  "open",
                  undefined,
                  fileMenu.absolutePath,
                );
              }
            }}
          >
            {fileMenuWorkspace ? "Open" : "Open in default app"}
          </button>
          <button
            role="menuitem"
            onClick={() =>
              void fileAction(
                fileMenu.path,
                "openWith",
                fileMenuWorkspace,
                fileMenu.absolutePath,
              )
            }
          >
            Open With…
          </button>
          <button
            role="menuitem"
            onClick={() =>
              void fileAction(
                fileMenu.path,
                "copy",
                fileMenuWorkspace,
                fileMenu.absolutePath,
              )
            }
          >
            <Icon name="copy" />
            Copy file contents
          </button>
          <button
            role="menuitem"
            onClick={() =>
              void fileAction(
                fileMenu.path,
                "copyPath",
                fileMenuWorkspace,
                fileMenu.absolutePath,
              )
            }
          >
            <Icon name="copy" />
            Copy path
          </button>
          <button
            role="menuitem"
            onClick={() =>
              void fileAction(
                fileMenu.path,
                "reveal",
                fileMenuWorkspace,
                fileMenu.absolutePath,
              )
            }
          >
            <Icon name="finder" />
            Reveal in Finder
          </button>
        </div>
      )}
    </>
  );
}
