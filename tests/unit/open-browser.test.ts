import { describe, expect, test, vi } from "vitest";
import { openBrowser } from "../../scripts/open-browser.mjs";
const clientInstanceId = "00000000-0000-4000-8000-000000000001";
const url = "http://127.0.0.1:4312/#nonce=PRIVATE_LAUNCH_SENTINEL";
const found = {
  stdout: JSON.stringify({ state: "found", tabId: "42", clientInstanceId }),
};
describe("working browser launcher", () => {
  test("reuses the inspected exact-origin tab only after checkpoint acknowledgment", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce(found)
      .mockResolvedValueOnce({ stdout: "reused" });
    const checkpoint = vi.fn().mockResolvedValue(true);
    expect(
      await openBrowser(url, { platform: "darwin", execFile, checkpoint }),
    ).toBe("reused");
    expect(checkpoint).toHaveBeenCalledWith(clientInstanceId);
    expect(execFile).toHaveBeenCalledTimes(2);
    expect(execFile.mock.calls[1][1]).toContain("42");
    expect(execFile.mock.calls[1][2]).toEqual({ input: url });
    for (const call of execFile.mock.calls)
      expect(JSON.stringify(call[1])).not.toContain("PRIVATE_LAUNCH_SENTINEL");
    expect(execFile.mock.calls[0][1][3]).toContain("activeTab");
  });
  test("opens only after positive missing-tab inspection, with launch material on stdin", async () => {
    const execFile = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '{"state":"missing"}' })
      .mockResolvedValueOnce({ stdout: "opened" });
    expect(await openBrowser(url, { platform: "darwin", execFile })).toBe(
      "opened",
    );
    expect(execFile.mock.calls[1][1]).toContain("open");
    expect(execFile.mock.calls[1][2]).toEqual({ input: url });
    expect(
      JSON.stringify(execFile.mock.calls.map((call) => call[1])),
    ).not.toContain("PRIVATE_LAUNCH_SENTINEL");
  });
  test("automation denial never falls back to another tab", async () => {
    const execFile = vi.fn().mockRejectedValue(Error("automation denied"));
    await expect(
      openBrowser(url, { platform: "darwin", execFile }),
    ).rejects.toThrow("BROWSER_REUSE_UNAVAILABLE: inspect");
    expect(execFile).toHaveBeenCalledOnce();
  });
  test("uncheckpointed legacy tab is not replaced or duplicated", async () => {
    const execFile = vi.fn().mockResolvedValue(found);
    await expect(
      openBrowser(url, {
        platform: "darwin",
        execFile,
        checkpoint: async () => false,
      }),
    ).rejects.toThrow("BROWSER_REUSE_UNAVAILABLE: checkpoint");
    expect(execFile).toHaveBeenCalledOnce();
  });
  test("explicit new-tab failure identifies open boundary without exposing launch material", async () => {
    const execFile = vi
      .fn()
      .mockRejectedValue(Error("PRIVATE_LAUNCH_SENTINEL"));
    await expect(
      openBrowser(url, { platform: "darwin", execFile, newTab: true }),
    ).rejects.toThrow("BROWSER_REUSE_UNAVAILABLE: open");
    expect(execFile).toHaveBeenCalledOnce();
  });
  test("explicit new-tab request does not inspect or replace existing tabs", async () => {
    const execFile = vi.fn().mockResolvedValue({ stdout: "opened" });
    expect(
      await openBrowser(url, { platform: "darwin", execFile, newTab: true }),
    ).toBe("opened");
    expect(execFile).toHaveBeenCalledOnce();
    expect(execFile.mock.calls[0][1]).toContain("open");
  });
});
