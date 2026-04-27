#!/usr/bin/env node
/**
 * Import-graph audit for the Forensic PPG monitor.
 *
 * Goals:
 *   1. Resolve every static + dynamic import correctly:
 *        - relative ('./x', '../x')
 *        - alias '@/...'  -> 'src/...'
 *        - extensions .ts .tsx .js .jsx .mjs .cjs
 *        - directory index files (index.ts/tsx/js/jsx)
 *   2. Build the reachable set from runtime entries (main.tsx, App.tsx,
 *      index.html script tags) AND from test entries (vitest globs).
 *   3. Classify every src/ file as one of:
 *        KEEP_PRODUCTION | KEEP_TEST | KEEP_DOC | KEEP_TYPES
 *        DELETE_DEAD     | MERGE_DUPLICATE | REWRITE_REQUIRED
 *      and write a machine-readable manifest to
 *      .audit/import-graph.json.
 *   4. Fail (exit 1) only on DELETE_DEAD / MERGE_DUPLICATE /
 *      REWRITE_REQUIRED. KEEP_* are informational.
 */

import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT_DIR  = join(__dirname, '..');
const SRC_DIR   = join(ROOT_DIR, 'src');
const OUT_DIR   = join(ROOT_DIR, '.audit');

/* ---------------------------------------------------------------------- */
/*  Configuration                                                          */
/* ---------------------------------------------------------------------- */

const RUNTIME_ENTRIES = ['src/main.tsx', 'src/App.tsx'];
const TEST_GLOBS      = ['src/**/__tests__/**/*.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'];

const SCAN_EXTENSIONS  = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const RESOLVE_ATTEMPTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
                          '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

// Files that legitimately exist but are NOT reached by static graph traversal.
// Each entry is a substring match against the normalised path.
const ALLOWLIST = [
  'src/types/',           // ambient type declarations
  'src/vite-env.d.ts',
  'src/index.css',        // imported from main.tsx but not a JS module
  'src/tailwind.config.lov.json', // Lovable visual editor metadata
];

/* ---------------------------------------------------------------------- */
/*  Helpers                                                                */
/* ---------------------------------------------------------------------- */

const norm = (p) => p.replace(/\\/g, '/');

function tryResolve(basePath) {
  for (const ext of RESOLVE_ATTEMPTS) {
    const candidate = basePath + ext;
    if (existsSync(join(ROOT_DIR, candidate))) {
      const stat = statSync(join(ROOT_DIR, candidate));
      if (stat.isFile()) return norm(candidate);
    }
  }
  return null;
}

function resolveImport(spec, fromFile) {
  const clean = spec.replace(/^['"]|['"]$/g, '').split('?')[0];

  if (clean.startsWith('.')) {
    const base = norm(join(dirname(fromFile), clean));
    return tryResolve(base);
  }
  if (clean.startsWith('@/')) {
    const base = norm(join('src', clean.slice(2)));
    return tryResolve(base);
  }
  // Bare specifier -> external dependency, ignore.
  return null;
}

function extractImports(content, filePath) {
  const found = new Set();

  // ES static imports / re-exports
  const reEs = /(?:^|\s)(?:import|export)(?:\s+[^'"]*?\s+from)?\s*['"]([^'"]+)['"]/g;
  // CommonJS require
  const reCjs = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  // Dynamic import
  const reDyn = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  for (const re of [reEs, reCjs, reDyn]) {
    let m;
    while ((m = re.exec(content)) !== null) {
      const spec = m[1];
      if (spec.startsWith('node:')) continue;
      const r = resolveImport(spec, filePath);
      if (r) found.add(r);
    }
  }
  return [...found];
}

function walk(dir, base, out) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel  = norm(join(base, entry));
    const st   = statSync(full);
    if (st.isDirectory()) walk(full, rel, out);
    else out.push(rel);
  }
}

function isAllowlisted(p) {
  return ALLOWLIST.some((s) => p.includes(s));
}

function classifyTestFile(p) {
  return p.includes('__tests__/') || /\.(test|spec)\.[jt]sx?$/.test(p);
}

/* ---------------------------------------------------------------------- */
/*  Graph traversal                                                        */
/* ---------------------------------------------------------------------- */

function traverseFrom(entries) {
  const queue   = [...entries];
  const visited = new Set();
  const graph   = new Map();

  while (queue.length) {
    const cur = queue.shift();
    if (visited.has(cur)) continue;
    visited.add(cur);

    const full = join(ROOT_DIR, cur);
    if (!existsSync(full)) continue;
    const ext = extname(cur);
    if (!SCAN_EXTENSIONS.has(ext)) continue;

    const content = readFileSync(full, 'utf-8');
    const imports = extractImports(content, cur);
    graph.set(cur, imports);
    for (const dep of imports) if (!visited.has(dep)) queue.push(dep);
  }
  return { visited, graph };
}

/* ---------------------------------------------------------------------- */
/*  Main                                                                   */
/* ---------------------------------------------------------------------- */

console.log('🔍 PPG Import Graph Audit\n');

// 1. Inventory
const allFiles = [];
walk(SRC_DIR, 'src', allFiles);
const allSrcModules = allFiles
  .filter((p) => SCAN_EXTENSIONS.has(extname(p)) || p.endsWith('.d.ts') || p.endsWith('.json') || p.endsWith('.css'))
  .map(norm)
  .sort();
console.log(`📁 src/ inventory: ${allSrcModules.length} files`);

// 2. Reachable from runtime
const runtime = traverseFrom(RUNTIME_ENTRIES);
console.log(`🔗 reachable from runtime: ${runtime.visited.size}`);

// 3. Reachable from tests (manual collection: vitest entries are every test file)
const testEntries = allSrcModules.filter(classifyTestFile);
const tests = traverseFrom(testEntries);
console.log(`🧪 reachable from tests:   ${tests.visited.size}`);

// 4. Classify
const classification = {};
for (const f of allSrcModules) {
  if (f.endsWith('.d.ts'))                       classification[f] = 'KEEP_TYPES';
  else if (classifyTestFile(f))                  classification[f] = 'KEEP_TEST';
  else if (runtime.visited.has(f))               classification[f] = 'KEEP_PRODUCTION';
  else if (tests.visited.has(f))                 classification[f] = 'KEEP_TEST';
  else if (isAllowlisted(f))                     classification[f] = 'KEEP_DOC';
  else                                           classification[f] = 'DELETE_DEAD';
}

// 5. Duplicate detection (same basename + identical SHA-like length+head signature)
const byBase = new Map();
for (const f of allSrcModules) {
  if (!SCAN_EXTENSIONS.has(extname(f))) continue;
  const k = f.split('/').pop();
  if (!byBase.has(k)) byBase.set(k, []);
  byBase.get(k).push(f);
}
for (const [, group] of byBase) {
  if (group.length < 2) continue;
  // Compare content; mark identical ones MERGE_DUPLICATE
  const contents = group.map((g) => readFileSync(join(ROOT_DIR, g), 'utf-8'));
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      if (contents[i] === contents[j]) {
        classification[group[i]] = 'MERGE_DUPLICATE';
        classification[group[j]] = 'MERGE_DUPLICATE';
      }
    }
  }
}

// 6. Report
const buckets = {};
for (const [f, tag] of Object.entries(classification)) {
  (buckets[tag] ||= []).push(f);
}
for (const tag of Object.keys(buckets).sort()) {
  console.log(`\n[${tag}]  (${buckets[tag].length})`);
  for (const f of buckets[tag].sort()) console.log(`   - ${f}`);
}

// 7. Persist manifest
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, 'import-graph.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runtimeEntries: RUNTIME_ENTRIES,
      testEntries,
      counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
      classification,
    },
    null,
    2,
  ),
);
console.log(`\n📝 Manifest written: .audit/import-graph.json`);

// 8. Exit policy
const blocking = ['DELETE_DEAD', 'MERGE_DUPLICATE', 'REWRITE_REQUIRED']
  .flatMap((t) => buckets[t] || []);

if (blocking.length) {
  console.log(`\n❌ AUDIT FAILED: ${blocking.length} files require action`);
  process.exit(1);
}
console.log('\n✅ AUDIT PASSED');
process.exit(0);
