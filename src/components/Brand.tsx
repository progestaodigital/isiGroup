// Logo isi (manual de marca v2): "isi" neutro na cor do texto, "ı" sem pingo
// com o pingo redondo na cor do produto, e o nome do produto na mesma cor.
// Nunca a letra "i" da fonte (pingo quadrado) nem o prefixo colorido.

function DotlessI() {
  return (
    <span className="isi-i">
      ı<span className="isi-dot" />
    </span>
  );
}

export function BrandLogo({ size = 30, white = false }: { size?: number; white?: boolean }) {
  return (
    <span className={`isi-logo${white ? " white" : ""}`} style={{ fontSize: size }} aria-label="isiGroup">
      <DotlessI />s<DotlessI />
      <span className="isi-name">Group</span>
    </span>
  );
}

// Ícone do app: "ıG" (pingo e "G" na cor) sobre preto, em quadrado arredondado.
// Mesmo desenho de src-tauri/icons (setup, executável e janela).
export function BrandIcon({ size = 96 }: { size?: number }) {
  return (
    <span className="isi-icon" style={{ width: size, height: size, fontSize: size * 0.625 }} aria-hidden>
      <DotlessI />
      <span className="isi-name">G</span>
    </span>
  );
}
