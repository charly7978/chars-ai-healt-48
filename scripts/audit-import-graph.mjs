#!/usr/bin/env node
/**
 * Audit script to detect unreachable code and orphaned files
 * 
 * - Partir desde src/main.tsx
 * - Listar archivos alcanzables
 * - Listar archivos no alcanzables
 * - Fallar si quedan archivos no alcanzables dentro de src salvo allowlist
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, extname, relative, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SRC_DIR = join(__dirname, '..', 'src');
const ROOT_DIR = join(__dirname, '..');

// Entry points
const ENTRY_POINTS = [
  'src/main.tsx',
  'src/App.tsx',
];

// Allowlist - files that are allowed to be unreachable from the runtime entry.
// We KEEP this list MINIMAL: anything genuinely used by the pipeline must be
// reachable through static imports.
const ALLOWLIST = new Set([
  // Type-only declarations
  'src/types/',
  'src/vite-env.d.ts',

  // Tests are intentionally not reached from the runtime entry — they have
  // their own runner (vitest). They MUST live under __tests__/.
  '__tests__/',
  '.test.',
  '.spec.',

  // Service workers / web workers (loaded at runtime, not via static import)
  'src/serviceWorker.ts',
  'src/sw.ts',
  'src/workers/',

  // Static assets imported dynamically
  'src/assets/',
]);

// Extensions to scan
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

let reachableFiles = new Set();
let allSourceFiles = new Set();
let importGraph = new Map();

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function resolveImport(importPath, fromFile) {
  // Clean up the import path (remove quotes if any)
  const cleanPath = importPath.replace(/^['"]|['"]$/g, '');
  
  // Handle relative imports
  if (cleanPath.startsWith('.')) {
    const dir = dirname(fromFile);
    const basePath = join(dir, cleanPath);
    
    // Try with extensions
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
    for (const ext of extensions) {
      const fullPath = basePath + ext;
      if (existsSync(join(ROOT_DIR, fullPath))) {
        return normalizePath(fullPath);
      }
    }
  }
  
  // Handle @/ alias (common in Vite projects)
  if (cleanPath.startsWith('@/')) {
    const basePath = join('src', cleanPath.substring(2));
    const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
    for (const ext of extensions) {
      const fullPath = basePath + ext;
      if (existsSync(join(ROOT_DIR, fullPath))) {
        return normalizePath(fullPath);
      }
    }
  }
  
  return null;
}

function extractImports(content, filePath) {
  const imports = [];
  
  // ES6 imports: import X from 'path' or import 'path'
  const es6Regex = /import\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"];?/g;
  let match;
  while ((match = es6Regex.exec(content)) !== null) {
    const importPath = match[1];
    // Skip pure node: protocol; let resolveImport decide for everything else
    // (it will return null for bare external packages).
    if (importPath.startsWith('node:')) continue;
    const resolved = resolveImport(importPath, filePath);
    if (resolved) {
      imports.push(resolved);
    }
  }
  
  // CommonJS requires
  const cjsRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = cjsRegex.exec(content)) !== null) {
    const importPath = match[1];
    if (!importPath.startsWith('node:')) {
      const resolved = resolveImport(importPath, filePath);
      if (resolved) {
        imports.push(resolved);
      }
    }
  }
  
  // Dynamic imports: import('path')
  const dynamicRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicRegex.exec(content)) !== null) {
    const importPath = match[1];
    const resolved = resolveImport(importPath, filePath);
    if (resolved) {
      imports.push(resolved);
    }
  }
  
  return imports;
}

function buildImportGraph(startFile) {
  const queue = [startFile];
  const visited = new Set();
  
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    
    const fullPath = join(ROOT_DIR, current);
    if (!existsSync(fullPath)) {
      console.warn(`   ⚠️  File not found: ${current}`);
      continue;
    }
    
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const imports = extractImports(content, current);
      importGraph.set(current, imports);
      
      for (const imp of imports) {
        if (!visited.has(imp)) {
          queue.push(imp);
        }
      }
    } catch (e) {
      console.warn(`   ⚠️  Failed to read ${current}: ${e.message}`);
    }
  }
  
  return visited;
}

function collectAllSourceFiles(dir, base = 'src') {
  const entries = readdirSync(dir);
  
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const relativePath = join(base, entry);
    const stat = statSync(fullPath);
    
    if (stat.isDirectory()) {
      collectAllSourceFiles(fullPath, relativePath);
    } else {
      const ext = extname(entry);
      if (SCAN_EXTENSIONS.has(ext)) {
        allSourceFiles.add(normalizePath(relativePath));
      }
    }
  }
}

function isAllowlisted(filePath) {
  for (const allowed of ALLOWLIST) {
    const needle = allowed.replace(/\/$/, '');
    // Path-prefix match (e.g. "src/types/") OR substring match
    // (e.g. "__tests__/", ".test.", ".spec.").
    if (filePath.startsWith(needle) || filePath.includes(needle)) {
      return true;
    }
  }
  return false;
}

// Main execution
console.log('🔍 PPG Import Graph Audit\n');

// Collect all source files
console.log('📁 Scanning source directory...');
collectAllSourceFiles(SRC_DIR);
console.log(`   Found ${allSourceFiles.size} source files`);

// Build import graph from entry points
console.log('\n🔗 Building import graph from entry points...');
for (const entry of ENTRY_POINTS) {
  console.log(`   Entry: ${entry}`);
  const reachable = buildImportGraph(entry);
  for (const file of reachable) {
    reachableFiles.add(file);
  }
}

// Find unreachable files
const unreachableFiles = [];
for (const file of allSourceFiles) {
  if (!reachableFiles.has(file) && !isAllowlisted(file)) {
    unreachableFiles.push(file);
  }
}

// Results
console.log(`\n📊 Results:`);
console.log(`   Reachable files: ${reachableFiles.size}`);
console.log(`   Unreachable files: ${unreachableFiles.length}`);
console.log(`   Allowlisted files: ${Array.from(allSourceFiles).filter(f => isAllowlisted(f)).length}`);

if (unreachableFiles.length > 0) {
  console.log(`\n❌ UNREACHABLE FILES (potentially dead code):`);
  unreachableFiles.sort().forEach(file => {
    console.log(`   - ${file}`);
  });
  
  console.log(`\n📝 SUGGESTED ACTIONS:`);
  console.log(`   1. Remove unused files`);
  console.log(`   2. Import them from reachable code`);
  console.log(`   3. Add to ALLOWLIST in audit-import-graph.mjs if intentionally unreachable`);
  
  console.log(`\n❌ AUDIT FAILED: ${unreachableFiles.length} unreachable files found`);
  process.exit(1);
} else {
  console.log(`\n✅ AUDIT PASSED: All source files are reachable`);
  console.log(`   (excluding ${Array.from(allSourceFiles).filter(f => isAllowlisted(f)).length} allowlisted files)`);
  process.exit(0);
}
