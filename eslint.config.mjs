import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Vendored Essentia.js builds (third-party, minified)
    "public/workers/*.umd.js",
    ".beatsync-data/**",
    // Mac app build output
    "app-build/**",
    "dist/**",
  ]),
  {
    // Electron main process + electron-builder hooks are CommonJS by design.
    files: ["electron/**/*.cjs", "build-resources/**/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    // Tests poke at loosely-typed ffprobe JSON and parametrised presets.
    files: ["tests/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
]);

export default eslintConfig;
