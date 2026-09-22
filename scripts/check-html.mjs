#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const matches = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
if (!matches.length) throw new Error('No inline script found in public/index.html');
for (const [index, match] of matches.entries()) {
  new vm.Script(match[1], { filename: `public/index.html:inline-script-${index + 1}.js` });
}
console.log(`Validated ${matches.length} inline script(s).`);
