import os
import sys
import zipfile

SRC = sys.argv[1] if len(sys.argv) > 1 else "CoideVoice-main.zip"
OUT = sys.argv[2] if len(sys.argv) > 2 else "contexto.txt"

IGNORAR = {"node_modules", "target", "dist", ".git", "gen", "icons"}
ARVORES = ("src/", "src-tauri/src/")
IMPORTANTES = {
    "lib.rs", "main.rs", "main.js", "main.ts", "App.jsx", "App.tsx",
    "App.vue", "index.html", "package.json", "Cargo.toml", "tauri.conf.json",
}
MAX_CHARS = 60000


def carregar(origem):
    arquivos = {}
    if os.path.isfile(origem) and origem.lower().endswith(".zip"):
        with zipfile.ZipFile(origem) as z:
            nomes = [n for n in z.namelist() if not n.endswith("/")]
            raiz = nomes[0].split("/")[0] + "/" if nomes else ""
            if not all(n.startswith(raiz) for n in nomes):
                raiz = ""
            for n in nomes:
                arquivos[n[len(raiz):]] = z.read(n)
    else:
        for base, _, fs in os.walk(origem):
            for f in fs:
                p = os.path.join(base, f)
                rel = os.path.relpath(p, origem).replace(os.sep, "/")
                with open(p, "rb") as fh:
                    arquivos[rel] = fh.read()
    return {k: v for k, v in arquivos.items()
            if not (set(k.split("/")) & IGNORAR)}


def texto(b):
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return None


def main():
    arqs = carregar(SRC)
    saida = []

    saida.append("=== ESTRUTURA DE PASTAS ===")
    for prefixo in ARVORES:
        saida.append(f"\n[{prefixo}]")
        for p in sorted(arqs):
            if p.startswith(prefixo):
                saida.append("  " + p)

    saida.append("\n\n=== ARQUIVOS IMPORTANTES ===")
    for p in sorted(arqs):
        if os.path.basename(p) in IMPORTANTES:
            conteudo = texto(arqs[p])
            if conteudo is None:
                continue
            if len(conteudo) > MAX_CHARS:
                conteudo = conteudo[:MAX_CHARS] + "\n... [TRUNCADO]"
            saida.append(f"\n----- {p} -----\n{conteudo}")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(saida))
    print(f"Gerado: {OUT} ({len(arqs)} arquivos lidos)")


if __name__ == "__main__":
    main()
