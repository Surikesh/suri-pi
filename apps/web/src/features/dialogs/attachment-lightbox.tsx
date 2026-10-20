import React from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { Icon } from "../../components/ui.js";

export function AttachmentLightbox({
  attachmentPreview,
  closeAttachmentPreview,
}: {
  attachmentPreview: Data | undefined;
  closeAttachmentPreview: () => void;
}) {
  return (
    <>
      {attachmentPreview && (
        <div
          className="modal-backdrop attachment-lightbox-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAttachmentPreview();
          }}
        >
          <section
            className="attachment-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${attachmentPreview.asset.name}`}
          >
            <button
              autoFocus
              className="attachment-lightbox-close"
              aria-label="Close image preview"
              onClick={closeAttachmentPreview}
            >
              <Icon name="close" />
            </button>
            <img
              src={`/v1/assets/${attachmentPreview.asset.id}`}
              alt={attachmentPreview.asset.name}
            />
          </section>
        </div>
      )}
    </>
  );
}
