# Como publicar uma nova versão (deploy)

A partir da **v0.1.2** o app tem **auto-updater nativo (assinado)**: ele consulta o
manifesto `latest.json` da Release `latest` do repo `progestaodigital/isiGroup`,
e — se houver versão nova — **baixa, valida a assinatura, instala e reinicia**
dentro do próprio app (botão "Atualizar agora" na Visão geral).

Para isso funcionar, **toda release precisa de 2 coisas**: o instalador `.exe`
**assinado** e o arquivo **`latest.json`** anexados à Release.

---

## ⚠️ Pré-requisito: chave de assinatura (NÃO perca)

A atualização só é aceita pelo app se estiver assinada com a **chave privada** que
corresponde à **pubkey** em `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).

- **Arquivo da chave privada:** `isigroup-updater.key` (raiz do projeto, **fora do Git** — está no `.gitignore`).
- **Senha:** `isigroup-updater-2026`.
- **Se perder a chave OU a senha, o auto-update quebra para todos** (não dá mais para assinar updates que o app aceite). Faça backup num cofre/gerenciador de senhas.
- Gerada uma vez com: `pnpm tauri signer generate -w isigroup-updater.key -p <senha>`.

---

## 1. Suba a versão (mesmo número nos 3 arquivos)

- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `version`

(O app lê a versão do `tauri.conf.json` para comparar com o `latest.json`.)

## 2. Commit + push

```bash
git add -A
git commit -m "vX.Y.Z"
git push origin main
```

## 3. Build assinado

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "isigroup-updater.key" -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "isigroup-updater-2026"
pnpm tauri build
```

Saída: `src-tauri/target/release/bundle/nsis/isigroup_X.Y.Z_x64-setup.exe` **+** `.exe.sig`.

> **Se o build terminar mas reclamar "no private key"** (o bundler às vezes não lê
> a env), assine o `.exe` já gerado — gera o mesmo `.sig`:
> ```powershell
> pnpm tauri signer sign -f "isigroup-updater.key" -p "isigroup-updater-2026" `
>   "src-tauri/target/release/bundle/nsis/isigroup_X.Y.Z_x64-setup.exe"
> ```

## 4. Gerar o `latest.json`

```bash
node scripts/make-latest-json.mjs
```

Lê a versão + a assinatura (`.exe.sig`) e escreve
`src-tauri/target/release/bundle/latest.json` apontando para o `.exe` da release.

## 5. Publicar a Release (com os DOIS assets)

```powershell
$base = "src-tauri/target/release/bundle"
gh release create vX.Y.Z `
  "$base/nsis/isigroup_X.Y.Z_x64-setup.exe" `
  "$base/latest.json" `
  --repo progestaodigital/isiGroup `
  --title "isiGroup vX.Y.Z" `
  --notes-file notes.md
```

O `latest.json` **precisa** se chamar exatamente `latest.json` (o app busca em
`/releases/latest/download/latest.json`).

> **CI redundante:** criar a tag dispara `.github/workflows/release.yml`. Como o
> build oficial é o manual (assinado + validado), **cancele esse run** para não
> sobrescrever o asset:
> ```bash
> gh run list --repo progestaodigital/isiGroup --limit 1
> gh run cancel <id> --repo progestaodigital/isiGroup
> ```

## 6. Conferir

```powershell
# o manifesto que o app vai ler:
Invoke-RestMethod "https://github.com/progestaodigital/isiGroup/releases/latest/download/latest.json"
```
Deve mostrar a versão nova, a `url` do `.exe` e a `signature`.

---

## Como os usuários recebem

Apps numa versão **anterior** (com updater, ou seja ≥ 0.1.2), ao abrir a **Visão
geral**, mostram "Nova versão disponível" → **Atualizar agora** baixa, valida,
instala e reinicia. **Ver mudanças** mostra as notas (`body`/`notes`).

> A **v0.1.2 é a primeira com auto-update**. Quem está em 0.1.1 ou anterior precisa
> instalar a 0.1.2 **uma vez manualmente**; daí em diante é automático.

---

## Opcional: automatizar pelo GitHub Actions

Para o `release.yml` assinar e gerar o `latest.json` sozinho no push da tag,
adicione como **secrets** do repo e configure o `tauri-action` (`includeUpdaterJson: true`):

- `TAURI_SIGNING_PRIVATE_KEY` — conteúdo do `isigroup-updater.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — a senha

Enquanto isso não estiver configurado, **use o fluxo manual acima** (e cancele o run do CI).
