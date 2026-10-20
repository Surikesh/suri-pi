import React from "react";
import { Icon } from "../../components/ui.js";

export function UtilityDialog({
  utilityPanel,
  setUtilityPanel,
}: {
  utilityPanel: { title: string; rows: Array<[string, string]> } | undefined;
  setUtilityPanel: (value: undefined) => void;
}) {
  return (
    <>
      {utilityPanel && (
        <div className="modal-backdrop">
          <section
            className="modal utility-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="utility-title"
          >
            <div className="detail-top">
              <h2 id="utility-title">{utilityPanel.title}</h2>
              <button
                autoFocus
                aria-label="Close information"
                onClick={() => setUtilityPanel(undefined)}
              >
                <Icon name="close" />
              </button>
            </div>
            <dl>
              {utilityPanel.rows.map(([label, value]) => (
                <React.Fragment key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </React.Fragment>
              ))}
            </dl>
          </section>
        </div>
      )}
    </>
  );
}
