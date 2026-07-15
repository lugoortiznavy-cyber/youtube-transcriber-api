#!/usr/bin/env python3
"""
Generador de audio para "La Hora del Vacilon".

Lee un guion en JSON (speaker + text por linea), sintetiza cada linea con la voz
asignada usando edge-tts (gratis, sin API key) y une todo en un solo MP3.

Uso:
    pip install edge-tts
    python generar_audio.py                 # usa guion.json -> la_hora_del_vacilon.mp3
    python generar_audio.py otro.json salida.mp3

Notas:
- edge-tts usa el motor de voz de Microsoft por internet. Es gratis.
- Voces de Puerto Rico: es-PR-VictorNeural (masc), es-PR-KarinaNeural (fem).
  Lista completa: `edge-tts --list-voices`.
- Si tienes ffmpeg instalado, la union queda mas limpia (con pausas reales).
  Sin ffmpeg, se hace una concatenacion binaria de los MP3 (funciona igual en
  la mayoria de reproductores).
"""

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile

try:
    import edge_tts
except ImportError:
    sys.exit("Falta edge-tts. Instala con:  pip install edge-tts")

AQUI = os.path.dirname(os.path.abspath(__file__))
DEFAULT_GUION = os.path.join(AQUI, "guion.json")
DEFAULT_SALIDA = os.path.join(AQUI, "la_hora_del_vacilon.mp3")
SEG_DIR = os.path.join(AQUI, "segmentos")

# Permite confiar en un CA bundle corporativo si TLS falla (proxies).
_ca = os.environ.get("SSL_CERT_FILE")
if _ca and os.path.exists(_ca):
    os.environ.setdefault("REQUESTS_CA_BUNDLE", _ca)


async def sintetizar_linea(texto, cfg, destino):
    """Genera un MP3 para una linea con la voz/rate/pitch dados."""
    comm = edge_tts.Communicate(
        text=texto,
        voice=cfg.get("voice", "es-PR-VictorNeural"),
        rate=cfg.get("rate", "+0%"),
        pitch=cfg.get("pitch", "+0Hz"),
    )
    await comm.save(destino)


def unir_con_ffmpeg(archivos, salida, pausa_ms):
    """Une los MP3 con ffmpeg insertando silencio entre lineas."""
    lista = os.path.join(tempfile.gettempdir(), "vacilon_concat.txt")
    silencio = os.path.join(tempfile.gettempdir(), "vacilon_silencio.mp3")
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i",
         "anullsrc=r=24000:cl=mono", "-t", str(max(pausa_ms, 1) / 1000.0),
         "-q:a", "9", silencio],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    with open(lista, "w") as f:
        for i, a in enumerate(archivos):
            f.write(f"file '{a}'\n")
            if i != len(archivos) - 1:
                f.write(f"file '{silencio}'\n")
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", lista,
         "-c:a", "libmp3lame", "-q:a", "4", salida],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )


def unir_binario(archivos, salida):
    """Concatenacion binaria simple de los MP3 (sin ffmpeg)."""
    with open(salida, "wb") as out:
        for a in archivos:
            with open(a, "rb") as f:
                shutil.copyfileobj(f, out)


async def main():
    guion_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_GUION
    salida = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_SALIDA

    with open(guion_path, encoding="utf-8") as f:
        guion = json.load(f)

    voices = guion.get("voices", {})
    lines = guion.get("lines", [])
    pausa_ms = int(guion.get("pausa_entre_lineas_ms", 350))
    if not lines:
        sys.exit("El guion no tiene lineas.")

    os.makedirs(SEG_DIR, exist_ok=True)
    archivos = []
    total = len(lines)
    for i, ln in enumerate(lines):
        speaker = ln.get("speaker", "").upper()
        texto = (ln.get("text") or "").strip()
        if not texto:
            continue
        cfg = voices.get(speaker, {})
        destino = os.path.join(SEG_DIR, f"{i:04d}_{speaker or 'X'}.mp3")
        print(f"[{i + 1}/{total}] {speaker}: {texto[:56]}...")
        # Reintenta un par de veces por si la red falla.
        for intento in range(3):
            try:
                await sintetizar_linea(texto, cfg, destino)
                break
            except Exception as e:
                if intento == 2:
                    raise
                print(f"   reintento ({e.__class__.__name__})...")
                await asyncio.sleep(2 * (intento + 1))
        archivos.append(destino)

    print(f"\nUniendo {len(archivos)} segmentos -> {salida}")
    if shutil.which("ffmpeg"):
        unir_con_ffmpeg(archivos, salida, pausa_ms)
        print("Union con ffmpeg (con pausas) lista.")
    else:
        unir_binario(archivos, salida)
        print("Union binaria lista (instala ffmpeg para pausas mas limpias).")

    print(f"\nListo: {salida}")


if __name__ == "__main__":
    asyncio.run(main())
