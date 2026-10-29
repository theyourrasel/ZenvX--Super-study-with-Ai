const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('public/index.html', 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
let checked = 0;
for (const [, attrs, source] of scripts) {
  if (/\bsrc\s*=/.test(attrs) || !source.trim()) continue;
  new vm.Script(source, { filename: `public/index.html:inline-script-${++checked}` });
}
if (!checked) throw new Error('No inline scripts found to check.');
console.log(`Syntax OK: server.js plus ${checked} inline script(s).`);
