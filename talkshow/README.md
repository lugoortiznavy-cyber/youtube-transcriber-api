# La Hora del Vacilón 🎙️

Talk show satírico estilo radio de Puerto Rico, con dos personajes **ficticios**
— **Papi** (el veterano) y **Wiwi** (el joven memero) — que se vacilan, comentan
la actualidad y le tiran al gobierno con humor. Las voces son **sintéticas de
personajes inventados**: no imitan a ninguna persona real, solo el *concepto* de
la radio boricua.

## Archivos

| Archivo | Qué es |
|---------|--------|
| `personajes.md` | Biblia de los personajes Papi y Wiwi (voz, muletillas, tono) |
| `guion_piloto.md` | Guion legible + rundown de la hora completa |
| `guion.json` | El guion que lee la máquina (líneas por personaje + voces) |
| `generar_audio.py` | Convierte el guion en un MP3 con dos voces |

## Cómo generar el audio (gratis)

Corre esto **en tu computadora** (o en tu deploy de Railway). No necesita API
key ni pago: usa `edge-tts`, el motor de voz de Microsoft.

```bash
cd talkshow
pip install edge-tts
python generar_audio.py
```

Resultado: `talkshow/la_hora_del_vacilon.mp3`

> **Nota:** en el entorno de Claude en la web la red de esta sesión **bloquea**
> el servidor de voz de Microsoft (política de la organización), por eso el MP3
> hay que generarlo desde tu máquina o tu Railway, no desde aquí. El código ya
> queda listo y probado para que solo sea correr el comando.

### Opcional: mejor calidad de unión

Si instalas **ffmpeg**, el script inserta pausas reales entre líneas y produce
un MP3 más limpio. Sin ffmpeg, une los audios directo (funciona igual en la
mayoría de reproductores).

## Cambiar las voces

Edita el bloque `voices` en `guion.json`:

```json
"voices": {
  "PAPI": { "voice": "es-PR-VictorNeural", "rate": "-8%", "pitch": "-3Hz" },
  "WIWI": { "voice": "es-DO-EmilioNeural", "rate": "+6%", "pitch": "+0Hz" }
}
```

- Voces de Puerto Rico: `es-PR-VictorNeural` (masc), `es-PR-KarinaNeural` (fem).
- Ver todas: `edge-tts --list-voices`
- `rate` acelera/ralentiza; `pitch` sube/baja el tono → así diferencias a los dos.

## Estirar a la hora completa

El piloto (Segmentos 1–2) ya está en `guion.json`. El `guion_piloto.md` tiene el
rundown de los 6 segmentos de la hora. Para completar la hora, se le agregan más
objetos `{ "speaker": ..., "text": ... }` al arreglo `lines`.

Pídeme **"expande el segmento 3 y 4"** (o los que quieras) y los escribo
completos para llenar los ~60 minutos.
