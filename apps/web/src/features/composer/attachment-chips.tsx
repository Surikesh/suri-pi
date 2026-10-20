import React from "react";
import { Icon } from "../../components/ui.js";
import { viewStorage as localStorage } from "../../view-storage.js";
import { type State } from "../../store.js";
import { type ComposerState } from "./use-composer.js";

export function AttachmentChips({
  state,
  composerState,
}: {
  state: State;
  composerState: ComposerState;
}) {
  const {
    attachments,
    setAttachments,
    attachmentPreview,
    setAttachmentPreview,
  } = composerState;
  return (
    <>
      {attachments.length > 0 && (
        <div
          className="attachments"
          role="group"
          aria-label="Pending attachments"
        >
          {attachments.map((a) => {
            const image = a.mime.startsWith("image/");
            return (
              <span
                className={`attachment-card ${image ? "image" : "file"}`}
                title={a.name}
                key={a.id}
              >
                {image ? (
                  <button
                    className="attachment-preview"
                    aria-label={`Preview ${a.name}`}
                    title={a.name}
                    onClick={(event) =>
                      setAttachmentPreview({
                        asset: a,
                        trigger: event.currentTarget,
                      })
                    }
                  >
                    <img src={"/v1/assets/" + a.id} alt={a.name} />
                  </button>
                ) : (
                  <span className="attachment-name">{a.name}</span>
                )}
                <button
                  className="attachment-remove"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => {
                    if (attachmentPreview?.asset?.id === a.id)
                      setAttachmentPreview(undefined);
                    const next = attachments.filter((x) => x.id !== a.id);
                    setAttachments(next);
                    localStorage.setItem(
                      `suri.attachments.${state.selected}`,
                      JSON.stringify(next),
                    );
                  }}
                >
                  <Icon name="close" />
                </button>
              </span>
            );
          })}
        </div>
      )}
    </>
  );
}
