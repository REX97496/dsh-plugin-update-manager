import fs from 'node:fs';
const p = 'C:/Users/Administrator/AppData/Local/Programs/DSH NEXT/resources/app.asar';
const fd = fs.openSync(p,'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const size = head.readUInt32LE(12);
const buf = Buffer.alloc(size);
fs.readSync(fd, buf, 0, size, 16);
const header = JSON.parse(buf.toString('utf8').replace(/\0+$/,''));
// walk for package.json files of interest
const want = ['@deepseek-ai/dsh','@deepseek-ai/dsh-app-boot','@deepseek-ai/dsh-client-ui-primitives','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-ui-settings-plugins'];
function walk(node, path, out){
  for (const [k,v] of Object.entries(node.files||{})) {
    const np = path ? path+'/'+k : k;
    if (k==='package.json') out.push(np);
    if (v.files) walk(v, np, out);
  }
}
const out=[]; walk(header,'',out);
console.log('total package.json in asar:', out.length);
for (const w of want) {
  const f = out.find(x=> x === w.replace('@deepseek-ai/','')+'/package.json' || x.includes('/'+w+'/package.json') || x === 'node_modules/'+w+'/package.json');
  console.log(w, '->', f||'NOT FOUND');
}
fs.closeSync(fd);
