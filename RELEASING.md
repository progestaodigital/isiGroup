# Como publicar uma nova versão (deploy)

O app avisa o usuário quando há uma versão nova, consultando as **Releases** do
repositório `progestaodigital/isiGroup`. Para publicar:

## 1. Suba a versão nos arquivos
Atualize o número da versão (mesmo valor nos dois):
- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`

(O app lê a versão do `tauri.conf.json` para comparar com a Release.)

## 2. Commit + tag + push
```bash
git add -A
git commit -m "vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
```

## 3. O GitHub Actions cuida do resto
O push da tag dispara `.github/workflows/release.yml`, que:
- builda o app (front + Tauri),
- gera o instalador Windows,
- cria a **Release** `isiGroup vX.Y.Z` com o `.exe` anexado.

## 4. Aviso automático no app
Os apps em versão anterior, ao abrir a **Visão geral**, mostram o banner
"Nova versão disponível" com **Baixar** (link direto do instalador) e
**Ver mudanças** (corpo da release).

> Dica: edite o corpo da Release no GitHub para listar as mudanças — é isso que
> aparece em "Ver mudanças".

---

## ⚠️ Pré-requisito: empacotamento do sidecar (Fase 6)
Hoje, em desenvolvimento, o app roda o sidecar Node a partir de `./sidecar`.
Para o **instalador** funcionar na máquina do usuário, o sidecar (Node embarcado
ou binário) precisa ser empacotado junto — isso é a **Fase 6 (Hardening)**.
Antes disso, as releases geram instalador, mas o app instalado ainda não sobe o
sidecar. A primeira release **funcional** sai com a Fase 6.
