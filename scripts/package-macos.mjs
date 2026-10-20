import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, cp, writeFile, readFile, rename, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";
if (process.arch !== "arm64")
  throw Error("This package profile requires arm64.");
execFileSync(
  "/usr/bin/swift",
  ["build", "--package-path", "apps/macos", "-c", "release"],
  { stdio: "inherit" },
);
const finalBundle = resolve(".build/Suri Pi.app");
const stamp = String(Date.now());
const bundle = resolve(`.build/package-${stamp}/Suri Pi.app`);
execFileSync(
  "/usr/bin/swift",
  [
    "scripts/app-icon.swift",
    resolve(".build/SuriPi.iconset"),
    resolve("apps/web/public/icon.svg"),
  ],
  { stdio: "inherit" },
);
execFileSync(
  "/usr/bin/iconutil",
  [
    "-c",
    "icns",
    resolve(".build/SuriPi.iconset"),
    "-o",
    resolve(".build/SuriPi.icns"),
  ],
  { stdio: "inherit" },
);
const resources = bundle + "/Contents/Resources";
await mkdir(bundle + "/Contents/MacOS", { recursive: true });
await mkdir(resources + "/app/bin", { recursive: true });
await cp("apps/macos/.build/release/SuriPi", bundle + "/Contents/MacOS/SuriPi");
await cp(
  ".runtime/node/node-v24.15.0-darwin-arm64/bin/node",
  resources + "/app/bin/node",
);
await writeFile(
  resources + "/app/source-manifest.json",
  JSON.stringify(
    {
      bootstrapNavigationSource: createHash("sha256")
        .update(
          await readFile("apps/macos/Sources/SuriPi/BootstrapNavigation.swift"),
        )
        .digest("hex"),
      swiftSource: createHash("sha256")
        .update(await readFile("apps/macos/Sources/SuriPi/main.swift"))
        .digest("hex"),
      shellLifecycleSource: createHash("sha256")
        .update(
          await readFile("apps/macos/Sources/SuriPi/ShellLifecycle.swift"),
        )
        .digest("hex"),
    },
    null,
    2,
  ) + "\n",
);
await cp("dist", resources + "/app/dist", { recursive: true });
await cp("package.json", resources + "/app/package.json");
await cp(".build/SuriPi.icns", resources + "/SuriPi.icns");
const lock = JSON.parse(await readFile("package-lock.json", "utf8"));
await cp("node_modules", resources + "/app/node_modules", {
  recursive: true,
  dereference: true,
  filter: (source) => {
    const path = relative(resolve("."), resolve(source)).split(sep).join("/");
    if (path.startsWith("node_modules/.bin")) return false;
    const item = lock.packages[path];
    return !item?.dev && !item?.link;
  },
});
await cp("THIRD_PARTY_NOTICES.md", resources + "/THIRD_PARTY_NOTICES.md");
await cp("package-lock.json", resources + "/app/package-lock.json");
await writeFile(
  bundle + "/Contents/Info.plist",
  `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Suri Pi</string><key>CFBundleDisplayName</key><string>Suri Pi</string><key>CFBundleIdentifier</key><string>dev.suri.pi</string><key>CFBundleIconFile</key><string>SuriPi</string><key>CFBundleExecutable</key><string>SuriPi</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLName</key><string>dev.suri.pi.session</string><key>CFBundleURLSchemes</key><array><string>suri-pi</string></array></dict></array><key>LSMinimumSystemVersion</key><string>14.0</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`,
);
execFileSync(
  "/usr/bin/codesign",
  ["--force", "--deep", "--sign", "-", bundle],
  { stdio: "inherit" },
);
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
  stdio: "inherit",
});
const running = execFileSync("/bin/ps", ["-axo", "comm="], { encoding: "utf8" })
  .split("\n")
  .some((line) => line.includes(finalBundle + "/Contents/"));
if (running)
  throw Error(
    "A Suri process is using the previous bundle. The new signed candidate was retained at " +
      bundle,
  );
try {
  await stat(finalBundle);
  await mkdir(".build/archive", { recursive: true });
  await rename(finalBundle, resolve(`.build/archive/SuriPi-${stamp}.app`));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await rename(bundle, finalBundle);
console.log("Local bundle assembled and signature verified: " + finalBundle);
