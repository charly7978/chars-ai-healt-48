#!/usr/bin/env node
/**
 * Import-graph audit for the Forensic PPG monitor.
 *
 * The audit is intentionally conservative: unresolved local imports and
 * unclassified source modules fail the run. Bare package imports are inventoried
 * as externals and are not treated as graph edges.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "fs";
import { dirname, extname, join, relative } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const SRC_DIR = join(ROOT_DIR, "src");
const OUT_DIR = join(ROOT_DIR, ".audit");

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const SRC_EXTENSIONS = new Set([...CODE_EXTENSIONS, ".d.ts", ".css", ".json"]);
const RESOLVE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx"];
const INDEX_FILES = ["index.ts", "index.tsx", "index.js", "index.jsx"];
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", "build", ".vite", "coverage"]);

const EXPECTED_RUNTIME_ENTRY = "src/main.tsx";

const ROOT_KEEP_DOC = new Set([
  "README.md",
]);

const ROOT_KEEP_PRODUCTION = new Set([
  "index.html",
  "package.json",
  "package-lock.json",
  "components.json",
  "vite.config.ts",
  "vitest.config.ts",
  "tailwind.config.ts",
  "postcss.config.js",
  "eslint.config.js",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
]);

const KEEP_DOC_PREFIXES = [
  ".github/",
  ".githooks/",
  ".lovable/",
  ".vscode/",
  "docs/archive/",
  "docs/",
];

const KEEP_PRODUCTION_PREFIXES = ["scripts/"];
const GENERATED_PREFIXES = [".audit/"];
const TYPES_ALLOWLIST = ["src/types/", "src/vite-env.d.ts"];

const norm = (p) => p.replace(/\\/g, "/");

function walk(dir, base = "") {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const rel = norm(base ? join(base, entry) : entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out.sort();
}

function readText(rel) {
  return readFileSync(join(ROOT_DIR, rel), "utf-8");
}

function isCodeFile(path) {
  return CODE_EXTENSIONS.has(extname(path));
}

function isSourceInventoryFile(path) {
  return path.startsWith("src/") && (SRC_EXTENSIONS.has(extname(path)) || path.endsWith(".d.ts"));
}

function tryResolve(basePath) {
  const normalizedBase = norm(basePath);
  for (const ext of RESOLVE_EXTENSIONS) {
    const candidate = normalizedBase + ext;
    const full = join(ROOT_DIR, candidate);
    if (existsSync(full) && statSync(full).isFile()) return norm(candidate);
  }

  const asDirectory = join(ROOT_DIR, normalizedBase);
  if (existsSync(asDirectory) && statSync(asDirectory).isDirectory()) {
    for (const indexFile of INDEX_FILES) {
      const candidate = norm(join(normalizedBase, indexFile));
      const full = join(ROOT_DIR, candidate);
      if (existsSync(full) && statSync(full).isFile()) return candidate;
    }
  }

  return null;
}

function resolveImport(spec, fromFile) {
  const clean = spec.split("?")[0].split("#")[0];
  if (clean.startsWith(".")) return tryResolve(join(dirname(fromFile), clean));
  if (clean.startsWith("@/")) return tryResolve(join("src", clean.slice(2)));
  return null;
}

function extractImportSpecifiers(content) {
  const specs = [];
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];

  for (const re of patterns) {
    let match;
    while ((match = re.exec(content)) !== null) specs.push(match[1]);
  }
  return [...new Set(specs)];
}

function extractExports(content) {
  const exports = [];
  const patterns = [
    /\bexport\s+(?:default\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /\bexport\s*\{([^}]+)\}/g,
  ];

  let match;
  while ((match = patterns[0].exec(content)) !== null) exports.push(match[1]);
  while ((match = patterns[1].exec(content)) !== null) {
    for (const raw of match[1].split(",")) {
      const token = raw.trim().split(/\s+as\s+/i).pop()?.trim();
      if (token) exports.push(token);
    }
  }
  if (/\bexport\s+default\b/.test(content)) exports.push("default");
  return [...new Set(exports)].sort();
}

function resolveImportsForFile(file) {
  const imports = [];
  const external = [];
  const unresolved = [];
  const content = readText(file);

  for (const spec of extractImportSpecifiers(content)) {
    if (spec.startsWith("node:")) {
      external.push(spec);
      continue;
    }

    const resolved = resolveImport(spec, file);
    if (resolved) {
      imports.push({ specifier: spec, resolved });
    } else if (spec.startsWith(".") || spec.startsWith("@/")) {
      unresolved.push({ specifier: spec, from: file });
    } else {
      external.push(spec);
    }
  }

  return { imports, external: [...new Set(external)].sort(), unresolved };
}

function htmlEntries() {
  const htmlPath = "index.html";
  if (!existsSync(join(ROOT_DIR, htmlPath))) return [];
  const content = readText(htmlPath);
  const entries = [];
  const re = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["'][^>]*>/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const src = match[1].replace(/^\//, "");
    const resolved = tryResolve(src);
    if (resolved) entries.push(resolved);
  }
  return entries;
}

function traverse(entries, fileImports) {
  const queue = [...entries];
  const visited = new Set();
  const edges = {};

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);

    if (!isCodeFile(current)) continue;
    const imports = fileImports[current]?.imports ?? [];
    edges[current] = imports.map((entry) => entry.resolved);
    for (const { resolved } of imports) {
      if (!visited.has(resolved)) queue.push(resolved);
    }
  }

  return { visited, edges };
}

function isTestFile(path) {
  return path.includes("__tests__/") || /\.(test|spec)\.[jt]sx?$/.test(path);
}

function classifyRepoFile(file, srcClassification) {
  if (srcClassification[file]) return srcClassification[file];
  if (GENERATED_PREFIXES.some((prefix) => file.startsWith(prefix))) return "KEEP_DOC";
  if (ROOT_KEEP_PRODUCTION.has(file)) return "KEEP_PRODUCTION";
  if (ROOT_KEEP_DOC.has(file)) return "KEEP_DOC";
  if (KEEP_DOC_PREFIXES.some((prefix) => file.startsWith(prefix))) return "KEEP_DOC";
  if (KEEP_PRODUCTION_PREFIXES.some((prefix) => file.startsWith(prefix))) return "KEEP_PRODUCTION";
  if (file.endsWith(".tsbuildinfo")) return "KEEP_DOC";
  if (file.endsWith("/.gitkeep")) return "KEEP_DOC";
  if (file.endsWith(".txt")) return "KEEP_DOC";
  if (file.startsWith("src/")) return "REWRITE_REQUIRED";
  return "KEEP_DOC";
}

function detectDuplicateFiles(files) {
  const byContent = new Map();
  for (const file of files.filter(isCodeFile)) {
    const content = readText(file);
    const key = `${content.length}:${content}`;
    const group = byContent.get(key) ?? [];
    group.push(file);
    byContent.set(key, group);
  }
  return [...byContent.values()].filter((group) => group.length > 1);
}

console.log("PPG Import Graph Audit\n");

const allFiles = walk(ROOT_DIR);
const allSrcModules = allFiles.filter(isSourceInventoryFile);
const codeFiles = allFiles.filter(isCodeFile);

const fileImports = {};
const fileExports = {};
const unresolvedImports = [];
for (const file of codeFiles) {
  const resolved = resolveImportsForFile(file);
  fileImports[file] = resolved;
  unresolvedImports.push(...resolved.unresolved);
  fileExports[file] = extractExports(readText(file));
}

const runtimeEntries = [...new Set([...htmlEntries(), EXPECTED_RUNTIME_ENTRY])].filter((entry) =>
  existsSync(join(ROOT_DIR, entry)),
);
const testEntries = allSrcModules.filter(isTestFile);
const runtime = traverse(runtimeEntries, fileImports);
const tests = traverse(testEntries, fileImports);

const srcClassification = {};
for (const file of allSrcModules) {
  if (TYPES_ALLOWLIST.some((entry) => file.includes(entry))) srcClassification[file] = "KEEP_TEST";
  else if (isTestFile(file)) srcClassification[file] = "KEEP_TEST";
  else if (runtime.visited.has(file)) srcClassification[file] = "KEEP_PRODUCTION";
  else if (tests.visited.has(file)) srcClassification[file] = "KEEP_TEST";
  else if (file.endsWith(".css") && runtime.visited.has(file)) srcClassification[file] = "KEEP_PRODUCTION";
  else srcClassification[file] = "DELETE_DEAD";
}

const duplicateGroups = detectDuplicateFiles(allSrcModules);
for (const group of duplicateGroups) {
  for (const file of group) srcClassification[file] = "MERGE_DUPLICATE";
}

const classification = {};
for (const file of allFiles) {
  classification[file] = classifyRepoFile(file, srcClassification);
}

const buckets = {};
for (const [file, tag] of Object.entries(classification)) (buckets[tag] ??= []).push(file);

console.log(`Files inventoried: ${allFiles.length}`);
console.log(`Code files:        ${codeFiles.length}`);
console.log(`Runtime entries:   ${runtimeEntries.join(", ") || "(none)"}`);
console.log(`Test entries:      ${testEntries.length}`);
console.log(`Runtime reachable: ${runtime.visited.size}`);
console.log(`Test reachable:    ${tests.visited.size}`);
console.log(`Unresolved imports:${unresolvedImports.length}`);

for (const tag of Object.keys(buckets).sort()) {
  console.log(`\n[${tag}] (${buckets[tag].length})`);
  for (const file of buckets[tag].sort()) console.log(`  - ${file}`);
}

if (unresolvedImports.length > 0) {
  console.log("\n[UNRESOLVED_IMPORTS]");
  for (const issue of unresolvedImports) {
    console.log(`  - ${issue.from} -> ${issue.specifier}`);
  }
}

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "import-graph.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      entrypoints: {
        html: ["index.html"],
        runtime: runtimeEntries,
        tests: testEntries,
        packageScripts: JSON.parse(readText("package.json")).scripts ?? {},
      },
      imports: fileImports,
      exports: fileExports,
      graphs: {
        runtime: runtime.edges,
        tests: tests.edges,
      },
      reachableFromRuntime: [...runtime.visited].sort(),
      reachableFromTests: [...tests.visited].sort(),
      unresolvedImports,
      duplicateGroups,
      counts: Object.fromEntries(Object.entries(buckets).map(([key, value]) => [key, value.length])),
      classification,
    },
    null,
    2,
  ),
);
console.log("\nManifest written: .audit/import-graph.json");

const blockingTags = new Set(["DELETE_DEAD", "MERGE_DUPLICATE", "REWRITE_REQUIRED"]);
const blockingFiles = Object.entries(classification)
  .filter(([, tag]) => blockingTags.has(tag))
  .map(([file]) => file);

if (unresolvedImports.length > 0 || blockingFiles.length > 0) {
  console.log(
    `\nAUDIT FAILED: ${blockingFiles.length} classified files and ${unresolvedImports.length} unresolved imports require action`,
  );
  process.exit(1);
}

console.log("\nAUDIT PASSED");
