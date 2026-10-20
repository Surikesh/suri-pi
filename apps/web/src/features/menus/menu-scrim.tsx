import React from "react";

export function MenuScrim({
  sessionMenu,
  projectMenu,
  fileMenu,
  closeSessionMenu,
  closeProjectMenu,
  closeFileMenu,
  setViewOptions,
  viewOptionsTrigger,
}: {
  sessionMenu: unknown;
  projectMenu: unknown;
  fileMenu: unknown;
  closeSessionMenu: () => void;
  closeProjectMenu: () => void;
  closeFileMenu: () => void;
  setViewOptions: (value: boolean) => void;
  viewOptionsTrigger: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <>
      {(sessionMenu || projectMenu || fileMenu) && (
        <div
          className="menu-scrim"
          aria-hidden="true"
          onPointerDown={() => {
            if (sessionMenu) closeSessionMenu();
            else if (projectMenu) closeProjectMenu();
            else if (fileMenu) closeFileMenu();
            else {
              setViewOptions(false);
              viewOptionsTrigger.current?.focus();
            }
          }}
        />
      )}
    </>
  );
}
