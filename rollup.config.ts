import commonjs from "@rollup/plugin-commonjs";
import inject from "@rollup/plugin-inject";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import terser from "@rollup/plugin-terser";
import path from "node:path";
import type { OutputOptions, RollupOptions } from "rollup";
import { defineConfig } from "rollup";

interface DefineOptionsArgs {
  file: string;
  name: string;
  amdId: string;
}

function defineOptions({
  file,
  name,
  amdId,
}: DefineOptionsArgs): RollupOptions[] {
  const sourceDir = "src";
  const targetDir = "dist";
  const commonOptions = {
    input: path.join(sourceDir, `${file}.js`),
    plugins: [commonjs(), nodeResolve()],
  } satisfies RollupOptions;

  const umdOutput: OutputOptions = {
    format: "umd",
    name,
    amd: { id: amdId },
  };

  return [
    // Modern ES module variant, with externalized dependencies.
    {
      ...commonOptions,
      output: [
        {
          file: path.join(targetDir, `${file}.mjs`),
        },
      ],
      external: ["@noble/hashes", "jwt-decode"],
    },
    // Legacy Universal Module Definition, or “UMD”, with inlined dependencies.
    {
      ...commonOptions,
      output: [
        {
          ...umdOutput,
          file: path.join(targetDir, `${file}.js`),
        },
        {
          ...umdOutput,
          file: path.join(targetDir, `${file}.min.js`),
          sourcemap: true,
          sourcemapExcludeSources: true,
          plugins: [terser()],
        },
      ],
      plugins: [
        ...commonOptions.plugins,
        inject({
          Promise: ["es6-promise/dist/es6-promise.min.js", "Promise"],
        }),
      ],
    },
  ];
}

export default defineConfig([
  ...defineOptions({
    file: "keycloak",
    name: "Keycloak",
    amdId: "keycloak",
  }),
]);
