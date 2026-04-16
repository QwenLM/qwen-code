import fs from 'fs';
const c = fs.readFileSync('packages/core/src/utils/editor.test.ts', 'utf8');
let d = 0, o = 0;
for (let i = 0; i < c.length; i++) {
  if (c[i] === '{') d++;
  if (c[i] === '}') o++;
}
console.log('opens:', d, 'closes:', o, 'diff:', d - o);
