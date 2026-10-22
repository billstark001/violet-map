import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const execute = promisify(execFile);
const project = fileURLToPath(new URL('../../', import.meta.url));

test('boundary checker rejects type/reexport/dynamic/relative imports and optional-peer loading escapes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'violet-boundaries-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const name of ['core', 'render', 'storage', 'resources', 'server', 'web', 'admin', 'cli']) {
    const dest = path.join(root, 'packages', name);
    await fs.mkdir(dest, { recursive: true });
    await fs.copyFile(path.join(project, 'packages', name, 'package.json'), path.join(dest, 'package.json'));
    await fs.cp(path.join(project, 'packages', name, 'src'), path.join(dest, 'src'), { recursive: true });
  }
  const run = () => execute(process.execPath, [path.join(project, 'scripts/check-boundaries.mjs')], { cwd: root });
  await run();
  for (const [owner, code, error] of [
    ['core', 'import type { ObjectStorage } from "@violet-map/storage";', /forbidden dependency/],
    ['server', 'export * from "@violet-map/render";', /forbidden dependency/],
    ['storage', 'import "@violet-map/resources";', /forbidden dependency/],
    ['storage', 'import "pngjs";', /resource generator dependency/],
    ['storage', 'import "@msgpack/msgpack";', /resource generator dependency/],
    ['resources', 'import "node:sqlite";', /explicit catalog sub-entry/],
    ['resources', 'import "@violet-map/server/app";', /forbidden dependency/],
    ['resources', 'import "@violet-map/render";', /forbidden dependency/],
    ['resources', 'process.env.DATA_DIR;', /platform global/],
    ['render', 'const fs = import("node:fs");', /platform implementation/],
    ['render', 'document.createElement("canvas");', /platform global/],
    ['web', 'import "../../server/src/app.js";', /cross-package relative import/],
    ['web', 'import "preact/compat";', /React compatibility/],
    ['web', 'import "react";', /React compatibility/],
    ['web', 'import "@radix-ui/themes";', /React compatibility/],
    ['admin', 'import "@violet-map/core/nbt";', /heavy admin entry/],
    ['cli', 'export * from "@violet-map/render";', /static optional runtime export/],
    ['cli', 'import {} from "@violet-map/render";', /static optional runtime import/],
    ['cli', 'import renderer, { type Rgb } from "@violet-map/render";', /static optional runtime import/],
    ['cli', 'const renderer = import("@violet-map/render");', /capability loader/],
    ['cli', 'const resources = import("@violet-map/resources");', /capability loader/],
    ['cli', 'const renderer = import(packageName);', /statically checkable/],
  ]) {
    const file = path.join(root, 'packages', owner, 'src/boundary-probe.ts');
    await fs.writeFile(file, code);
    await assert.rejects(run(), error);
    await fs.unlink(file);
  }
  for (const [file, code, error] of [
    [
      'scheduling/boundary-probe.ts',
      'import type { OverlayDisplay } from "../runtime/overlayDisplay";',
      /scheduler depends/,
    ],
    ['scheduling/boundary-probe.ts', 'export * from "../resources/download";', /scheduler depends/],
    ['scheduling/boundary-probe.ts', 'const clock = performance.now();', /platform global in pure viewer/],
    ['scheduling/boundary-probe.ts', 'const browser = globalThis.navigator;', /platform global in pure viewer/],
    ['scheduling/boundary-probe.ts', 'const send = fetch;', /platform global in pure viewer/],
    ['scheduling/boundary-probe.ts', 'const { now } = performance;', /platform global in pure viewer/],
    ['scheduling/boundary-probe.ts', 'const clock = performance["now"]();', /platform global in pure viewer/],
    ['view/boundary-probe.ts', 'import "../logger";', /view contract depends/],
    ['runtime/boundary-probe.ts', 'import type { ChunkScene } from "../render/chunkScene";', /depends on GPU/],
    ['resources/boundary-probe.ts', 'import "../render/overlayMedia";', /depends on GPU/],
    ['render/boundary-probe.ts', 'const io = import("../api");', /depends on HTTP transport/],
  ]) {
    const probe = path.join(root, 'packages/web/src', file);
    await fs.mkdir(path.dirname(probe), { recursive: true });
    await fs.writeFile(probe, code);
    await assert.rejects(run(), error);
    await fs.unlink(probe);
  }
});
