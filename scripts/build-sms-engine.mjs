import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "dist-mobile-engine");
const bundleName = "fuloos-sms-engine.js";

/**
 * Strips transitive React imports (pulled in via domain.ts -> i18n.ts) so the
 * headless Android JavaScriptSandbox bundle contains zero DOM/React/Node code.
 */
const stripReactPlugin = {
  name: "fuloos-strip-react-for-headless",
  resolveId(id) {
    if (id === "react" || id.startsWith("react/")) {
      return "\0headless-react-stub";
    }
    return null;
  },
  load(id) {
    if (id === "\0headless-react-stub") {
      return [
        "export const createContext = () => ({});",
        "export const createElement = () => null;",
        "export const useCallback = (fn) => fn;",
        "export const useContext = () => ({});",
        "export const useEffect = () => {};",
        "export const useMemo = (fn) => fn();",
        "export const useState = (v) => [v, () => {}];",
        "export default {};",
      ].join("\n");
    }
    return null;
  },
};

await build({
  configFile: false,
  root,
  logLevel: "info",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  plugins: [stripReactPlugin],
  build: {
    outDir,
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    target: "es2020",
    lib: {
      entry: resolve(root, "src/mobile/headlessEntry.ts"),
      name: "FuloosSmsEngineBundle",
      formats: ["iife"],
      fileName: () => bundleName,
    },
  },
});

const builtFile = resolve(outDir, bundleName);
const androidAssetsDir = resolve(root, "android/app/src/main/assets");
if (existsSync(resolve(root, "android/app/src/main"))) {
  mkdirSync(androidAssetsDir, { recursive: true });
  copyFileSync(builtFile, resolve(androidAssetsDir, bundleName));
  console.log(`Copied ${bundleName} -> android/app/src/main/assets/${bundleName}`);
} else {
  console.log(`Built ${builtFile} (run cap add android to copy into Android assets).`);
}
