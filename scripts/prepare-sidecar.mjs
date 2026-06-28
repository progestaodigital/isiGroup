// Empacotamento do sidecar (Fase 6).
// Copia o runtime Node + o código do sidecar + as dependências de produção
// (node_modules plano via npm) para src-tauri/resources, que o Tauri embute no
// instalador. Assim o app instalado roda o sidecar sem Node na máquina do usuário.

import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const res = join(root, 'src-tauri', 'resources');
const sidecarSrc = join(root, 'sidecar');
const sidecarDst = join(res, 'sidecar');

console.log('[bundle] limpando', res);
rmSync(res, { recursive: true, force: true });
mkdirSync(sidecarDst, { recursive: true });
// Mantém o placeholder versionado (o glob de recursos do Tauri precisa casar sempre).
writeFileSync(join(res, 'keep.txt'), 'Placeholder. Conteúdo real gerado por scripts/prepare-sidecar.mjs.\n');

// 1) Runtime Node embarcado (o mesmo que está rodando este script).
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
console.log('[bundle] copiando node:', process.execPath);
cpSync(process.execPath, join(res, nodeName));

// 2) Código do sidecar.
for (const f of ['index.mjs', 'package.json']) {
  cpSync(join(sidecarSrc, f), join(sidecarDst, f));
}
for (const d of ['src', 'migrations']) {
  cpSync(join(sidecarSrc, d), join(sidecarDst, d), { recursive: true });
}

// 2b) Sincroniza a versão do sidecar com a do app (o /health reporta esta
// versão na tela "Sidecar"). Assim o bundle nunca defasa da versão publicada.
const appVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const pkgPath = join(sidecarDst, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.version = appVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('[bundle] versão do sidecar sincronizada:', appVersion);

// 3) Dependências de produção em node_modules plano (npm, sem symlinks do pnpm).
console.log('[bundle] instalando dependências de produção do sidecar...');
execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', {
  cwd: sidecarDst,
  stdio: 'inherit',
});

console.log('[bundle] sidecar empacotado em', sidecarDst);
