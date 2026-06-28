// Gera o latest.json do updater do Tauri a partir do instalador assinado.
//
// Pré-requisito: `pnpm tauri build` rodou COM as variáveis de assinatura
// (TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]), produzindo o .exe e o .exe.sig.
//
// Uso: node scripts/make-latest-json.mjs
// Saída: src-tauri/target/release/bundle/latest.json (anexar à release do GitHub).

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const conf = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const version = conf.version;
const tag = `v${version}`;
const repo = 'progestaodigital/isiGroup';

const nsisDir = join(root, 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const exeName = `isigroup_${version}_x64-setup.exe`;
const sig = readFileSync(join(nsisDir, `${exeName}.sig`), 'utf8').trim();

const manifest = {
  version,
  notes: `isiGroup ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: sig,
      url: `https://github.com/${repo}/releases/download/${tag}/${exeName}`,
    },
  },
};

const out = join(root, 'src-tauri', 'target', 'release', 'bundle', 'latest.json');
writeFileSync(out, JSON.stringify(manifest, null, 2));
console.log(`latest.json gerado para ${version}:\n${out}`);
