import { it, expect } from "vitest";
import { browserHost } from "../support/browser-host.js";

it("persists Pi-observed model and thinking selections instead of optimistic requests", async () => {
  const fixture = await browserHost();
  try {
    const sessionId = fixture.session.id;
    let session = fixture.host.store.get("session", sessionId);

    const model = await fixture.execute(
      "model.set",
      { provider: "synthetic", id: "normalized-request" },
      sessionId,
      session.revision,
    );
    // The command result also reports the revision the host persisted.
    const { revision: modelRevision, ...selectedModel } = model;
    expect(selectedModel).toEqual({ provider: "synthetic", id: "normalized" });
    session = fixture.host.store.get("session", sessionId);
    expect(modelRevision).toBe(session.revision);
    expect(session.model).toEqual(selectedModel);
    const modelProcessPid = session.processPid;

    let project = fixture.host.store.get("project", fixture.project.id);
    expect(project.lastModelByRuntime[fixture.runtime.id]).toEqual(
      selectedModel,
    );

    const thinking = await fixture.execute(
      "thinking.set",
      { level: "maximum" },
      sessionId,
      session.revision,
    );
    session = fixture.host.store.get("session", sessionId);
    expect(thinking).toEqual({ level: "high", revision: session.revision });
    expect(session.thinkingLevel).toBe("high");

    project = fixture.host.store.get("project", fixture.project.id);
    expect(project.lastThinkingByRuntime[fixture.runtime.id]).toBe("high");

    expect(session.processPid).toBe(modelProcessPid);
  } finally {
    await fixture.close();
  }
});

it("does not persist a model selection rejected by Pi", async () => {
  const fixture = await browserHost();
  try {
    const sessionId = fixture.session.id;
    const before = fixture.host.store.get("session", sessionId);
    const projectBefore = fixture.host.store.get("project", fixture.project.id);

    await expect(
      fixture.execute(
        "model.set",
        { provider: "synthetic", id: "rejected" },
        sessionId,
        before.revision,
      ),
    ).rejects.toThrow("Pi rejected the operation");

    const after = fixture.host.store.get("session", sessionId);
    const projectAfter = fixture.host.store.get("project", fixture.project.id);
    // Starting the child may discover its existing model, but the rejected
    // request must never be recorded as the selected/default model.
    expect(after.model).not.toEqual({ provider: "synthetic", id: "rejected" });
    expect(projectAfter.lastModelByRuntime).toEqual(
      projectBefore.lastModelByRuntime,
    );
  } finally {
    await fixture.close();
  }
});
