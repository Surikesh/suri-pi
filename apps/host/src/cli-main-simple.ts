import { preflight } from "./preflight.js";
import { assets, CliFailure, helper, root } from "./cli-env.js";
import { control } from "./cli-control.js";

export async function runServe() {
  const checked = await preflight({ assets, helper });
  if (!checked.ok) throw new CliFailure(checked);
  const { startHost } = await import("./host.js");
  const host = await startHost({
    root,
    assets,
    helper,
    port: process.env.SURI_PORT ? Number(process.env.SURI_PORT) : undefined,
    validation: process.env.SURI_VALIDATION === "1",
    uiCheckout: process.env.SURI_UI_CHECKOUT,
    simulated: process.env.SURI_SIMULATED === "1",
    modernUpdates: process.env.SURI_MODERN_UPDATES === "1",
  });
  process.on("SIGTERM", () => {
    void host.close().then(
      () => process.exit(0),
      () => {
        process.exitCode = 1;
      },
    );
  });
  return;
}

export async function runDoctor() {
  const checked = await preflight({ assets, helper });
  let host: unknown = { present: false };
  try {
    host = { present: true, health: await control(root, { type: "health" }) };
  } catch (error) {
    if (error instanceof CliFailure)
      host = { present: false, control: error.detail };
    else host = { present: false };
  }
  console.log(JSON.stringify({ preflight: checked, host }));
  if (!checked.ok) process.exitCode = 1;
  return;
}

export async function runStatus() {
  try {
    console.log(
      JSON.stringify({
        present: true,
        health: await control(root, { type: "health" }),
      }),
    );
  } catch (error) {
    if (
      error instanceof CliFailure &&
      error.detail.code === "CONTROL_UNAVAILABLE"
    )
      console.log(JSON.stringify({ present: false }));
    else throw error;
  }
  return;
}
