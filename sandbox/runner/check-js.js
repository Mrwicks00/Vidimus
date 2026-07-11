#!/usr/bin/env node
// Baked into the sandbox image (never delivered content, never mounted from /workspace). Walks
// the read-only workspace and syntax-checks every .js/.mjs/.cjs file via vm.Script, which
// *compiles* without executing any top-level code - "code.compiles" for JS never runs a single
// line of delivered code. Prints one JSON line to stdout: { ok, errors, fileCount }.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = process.argv[2] || "/workspace";
const exts = new Set([".js", ".mjs", ".cjs"]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (exts.has(path.extname(entry.name))) out.push(full);
  }
}

const files = [];
walk(root, files);

const errors = [];
for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  try {
    // eslint-disable-next-line no-new
    new vm.Script(content, { filename: path.relative(root, file) });
  } catch (err) {
    errors.push({ file: path.relative(root, file), message: err instanceof Error ? err.message : String(err) });
  }
}

process.stdout.write(JSON.stringify({ ok: errors.length === 0, errors, fileCount: files.length }));
