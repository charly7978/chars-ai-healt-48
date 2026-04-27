import { readFileSync } from 'fs';

const content = readFileSync('src/main.tsx', 'utf-8');
const regex = /import\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"];?/g;
let match;
console.log('Imports found in main.tsx:');
while ((match = regex.exec(content)) !== null) {
  console.log(' -', match[1]);
}

// Now test the resolve function
function resolveImport(importPath, fromFile) {
  // Clean up the import path (remove quotes if any)
  const cleanPath = importPath.replace(/^['"]|['"]$/g, '');
  
  console.log(`\nResolving: "${cleanPath}" from "${fromFile}"`);
  
  // Handle relative imports
  if (cleanPath.startsWith('.')) {
    console.log('  -> Detected as relative import');
    const dir = fromFile.substring(0, fromFile.lastIndexOf('/'));
    const basePath = dir + '/' + cleanPath;
    console.log(`  -> dir="${dir}", basePath="${basePath}"`);
    return basePath;
  }
  
  return null;
}

// Reset regex
regex.lastIndex = 0;
while ((match = regex.exec(content)) !== null) {
  const resolved = resolveImport(match[1], 'src/main.tsx');
  console.log(`  -> Resolved to: ${resolved}\n`);
}
