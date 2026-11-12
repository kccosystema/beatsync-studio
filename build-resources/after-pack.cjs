/**
 * electron-builder strips node_modules from extraResources, but the bundled Next.js
 * server needs its node_modules. Copy app-build/server into the app ourselves.
 * Runs after packing and BEFORE signing, so the signature covers these files.
 */
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function afterPack(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const dest = path.join(context.appOutDir, appName, "Contents", "Resources", "server");
  const src = path.join(__dirname, "..", "app-build", "server");
  if (!fs.existsSync(path.join(src, "server.js"))) throw new Error("app-build/server missing — run npm run app:assemble");
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  if (!fs.existsSync(path.join(dest, "node_modules", "next"))) throw new Error("server node_modules did not copy");
  console.log(`  • copied server (with node_modules) → ${path.relative(process.cwd(), dest)}`);
};
