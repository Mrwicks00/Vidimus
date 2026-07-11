#!/usr/bin/env node
// Baked into the sandbox image. Walks the read-only workspace and type-checks every .ts/.tsx
// file as a single Program (so cross-file imports within the delivery resolve too) via the
// TypeScript compiler API directly - noEmit, no execution, structured diagnostics with real
// error codes (so TS2307 "cannot find module" is distinguishable from a genuine type error
// without parsing free-text CLI output). Prints one JSON line to stdout: { ok, errors, fileCount }.
"use strict";
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const root = process.argv[2] || "/workspace";
const exts = new Set([".ts", ".tsx"]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (exts.has(path.extname(entry.name)) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
}

const files = [];
walk(root, files);

if (files.length === 0) {
  process.stdout.write(JSON.stringify({ ok: true, errors: [], fileCount: 0 }));
  process.exit(0);
}

const program = ts.createProgram(files, {
  noEmit: true,
  strict: false,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  skipLibCheck: true,
  esModuleInterop: true,
  // Delivered files live under /workspace, unrelated to this script's own directory, so TS's
  // default upward @types search (which starts from the compiled files' own directory) would
  // never find our locally-installed @types/node - point it here explicitly so builtins like
  // `node:test`/`node:assert` aren't misclassified as missing external dependencies.
  typeRoots: [path.join(__dirname, "node_modules", "@types")],
  types: ["node"],
});

const diagnostics = ts.getPreEmitDiagnostics(program);
const errors = diagnostics.map((d) => ({
  file: d.file ? path.relative(root, d.file.fileName) : "<unknown>",
  code: d.code,
  message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
}));

process.stdout.write(JSON.stringify({ ok: errors.length === 0, errors, fileCount: files.length }));
