# Souffleuse

Eine kleine Web-App zum Textlernen für Theater und Musical. Die App liest die Rollen deiner Szenenpartner vor und lässt dir Pausen für deinen eigenen Text. Sie läuft im Handy-Browser, lässt sich wie eine App auf den Homescreen legen und funktioniert nach dem ersten Laden auch offline.

- Skript als PDF, Word-Datei (.docx) oder Text hinzufügen
- Rollen, Szenen, Lieder und Tonfall erkennen lassen: automatisch, mit Gemini oder mit einem beliebigen Chatbot
- Eigene Rolle markieren (wie mit Textmarker)
- Lernmodi: Pause für mich, Pause mit Auflösung, Warten bis ich tippe, nur Stichworte, Text verdecken
- Ganzes Stück anhören: alle Rollen inklusive der eigenen, automatisch Szene für Szene
- Drei Stimm-Quellen: Handy-Stimmen, Offline-KI (Piper) und Google Gemini
- Szenen als MP3 speichern, zum Hören mit gesperrtem Bildschirm
- Alles bleibt auf dem Gerät. Es gibt keinen Server und kein Konto.

## Auf GitHub Pages veröffentlichen

Du brauchst nur einen kostenlosen GitHub-Account. Einen Build-Schritt gibt es nicht.

### Variante A: im Browser (ohne Git)

1. Auf github.com oben rechts **+ → New repository** wählen, z. B. `souffleuse`. Sichtbarkeit: **Public** (Pages ist im kostenlosen Plan nur für öffentliche Repos verfügbar).
2. Im neuen Repo auf **uploading an existing file** (bzw. **Add file → Upload files**) klicken.
3. Den entpackten Ordner öffnen und **den Inhalt** (also `index.html`, `css`, `js`, `vendor` usw.) ins Browserfenster ziehen. `index.html` muss danach direkt im Repo liegen, nicht in einem Unterordner. Mit **Commit changes** bestätigen.
4. **Settings → Pages**: Bei *Source* „Deploy from a branch“ wählen, Branch `main` und Ordner `/ (root)`, dann **Save**.
5. Nach ein bis zwei Minuten läuft die App unter `https://DEIN-NAME.github.io/souffleuse/` (hier: https://erik14hede.github.io/souffleuse/).

Alle Dateien sind kleiner als 25 MB, deshalb klappt der Upload im Browser.

### Variante B: mit Git

```bash
cd souffleuse          # Ordner mit index.html
git init && git add . && git commit -m "Souffleuse"
git branch -M main
git remote add origin https://github.com/DEIN-NAME/souffleuse.git
git push -u origin main
```

Danach wie oben unter **Settings → Pages** den Branch `main` freigeben.

### Auf dem Handy installieren

- **iPhone:** Seite in Safari öffnen, auf **Teilen** und dann **Zum Home-Bildschirm** tippen.
- **Android:** Seite in Chrome öffnen, im Menü **App installieren** (oder „Zum Startbildschirm hinzufügen“) wählen.

### Updates

Geänderte Dateien einfach erneut hochladen. Die App holt sich Neuerungen beim nächsten Öffnen. Wenn du größere Änderungen machst, erhöhe in `sw.js` die `VERSION`, damit alte Dateien sicher ersetzt werden.

## Die drei Stimm-Quellen

| | Handy | Offline-KI (Piper) | Gemini |
|---|---|---|---|
| Kosten | kostenlos | kostenlos | kostenloses Tageskontingent |
| Natürlichkeit | je nach Gerät | gut | sehr gut, mit Schauspiel |
| Gefühle | über Tempo und Tonhöhe | „Thorsten emotional“ wechselt je Zeile das Gefühl | folgt der Regieanweisung jeder Zeile |
| Offline | ja | nach einmaligem Download (ca. 20–115 MB pro Stimme) | nein |
| MP3-Export | nein | ja | ja |

**Handy-Stimmen** nutzen die Vorlesefunktion des Browsers. Auf Android und am Computer (vor allem in Microsoft Edge) gibt es oft sehr natürliche Stimmen. Auf dem iPhone stellt Safari nur einfache Stimmen bereit.

**Offline-KI** sind die frei verfügbaren deutschen [Piper](https://github.com/rhasspy/piper)-Stimmen. Sie laufen direkt im Browser und werden beim ersten Gebrauch von Hugging Face geladen. Die Männerstimme „Thorsten“ ist die beste. Die Frauenstimmen sind etwas einfacher.

**Gemini** klingt am lebendigsten. Beachte: Laut Googles Bedingungen sind AI Studio und die Gemini-API für Entwickler gedacht, die damit beruflich oder geschäftlich arbeiten, nicht für private Nutzung. Wer das nicht ist, nimmt die Offline-KI-Stimmen und für die Aufbereitung den Chatbot-Weg. Für Gemini brauchst du einen kostenlosen API-Schlüssel:

1. [aistudio.google.com/apikey](https://aistudio.google.com/apikey) öffnen und mit einem Google-Konto anmelden.
2. „API-Schlüssel erstellen“, kopieren, in der App unter **Einstellungen → Gemini** einfügen.

Das kostenlose Kontingent erlaubt nur wenige Anfragen pro Minute und pro Tag. Die App geht sparsam damit um:

- Jede erzeugte Zeile wird gespeichert und nie doppelt angefragt.
- „Anfragen sparen“ bündelt aufeinanderfolgende Repliken von bis zu zwei Figuren in einer Anfrage.
- Beim Minutenlimit wartet die App automatisch und macht dann weiter.
- Ist das Tageskontingent eines Sprachmodells aufgebraucht, weicht sie auf ein anderes Gemini-Sprachmodell aus (jedes hat ein eigenes Kontingent).

Tipp: Eine Szene einmal als MP3 erstellen lassen. Danach sind alle Zeilen gespeichert und die Probe läuft ohne Wartezeiten.

Laut Googles Bedingungen gelten in der EU auch für das kostenlose Kontingent die Datenschutzregeln des Bezahltarifs. Außerhalb der EU darf Google kostenlose Anfragen zur Verbesserung seiner Dienste nutzen.

## Skript aufbereiten

Die App arbeitet mit einem einfachen Textformat. Du kannst es jederzeit unter **Skript** bearbeiten:

```
@ ANNA: weiblich, Mitte 20, verträumt
# 1. Akt
## Szene 1: Am Bahnhof
(Anna sitzt am Fenster.)
ANNA [traurig | sad, quiet]: Du gehst also?
MAX: Ja. (zögert) Vielleicht.
♪ ANNA [sehnsüchtig]: Eine gesungene Zeile
ANNA & MAX: Gemeinsam gesprochen
```

- `@` beschreibt eine Figur (das Geschlecht hilft bei der Stimmenwahl)
- `#` ist ein Akt, `##` eine Szene
- In eckigen Klammern steht der Tonfall: zuerst auf Deutsch, nach dem `|` optional eine englische Regieanweisung für Gemini
- Runde Klammern sind Regieanweisungen und werden nicht mitgesprochen. `(Pause)` erzeugt eine Sprechpause.
- `♪` markiert Gesang. Lieder können im Lernmodus übersprungen werden.

Die **automatische Erkennung** versteht übliche Skriptformate (`ANNA: Text`, `ANNA. Text` oder der Name allein über dem Text). Mit **Gemini** oder dem **Chatbot-Weg** werden außerdem Szenen, Lieder und Gefühle erkannt. Lange Skripte werden dabei aktweise verarbeitet. Eingescannte PDFs kann nur Gemini lesen.

## Datenschutz

Stücke, Einstellungen und erzeugte Audios liegen nur im Browser-Speicher deines Geräts. Über **Einstellungen → Alle Stücke sichern** kannst du sie als Datei exportieren und auf einem anderen Gerät wieder laden. Ins Internet geht nur Folgendes:

- Beim Download einer Offline-Stimme: eine Anfrage an Hugging Face
- Wenn du Gemini nutzt: Skripttext an Google

## Grenzen

- Singen kann keine der Stimmen. Liedtexte werden gesprochen oder übersprungen.
- Mit Handy-Stimmen kann der Browser keine MP3 aufnehmen. Unterwegs nimmst du Offline-KI oder Gemini.
- Die Bildschirmsperre unterbricht Handy-Stimmen. Für unterwegs ist der MP3-Export gedacht.

## Aufbau

```
index.html, manifest.webmanifest, sw.js   App-Hülle, Installierbarkeit, Offline-Cache
css/app.css                                Gestaltung
js/app.js                                  Ansichten und Bedienung
js/format.js                               Skriptformat, Erkennung, Aufteilung in Akte
js/importers.js                            PDF/Word/Text einlesen
js/ai.js                                   Prompt und Gemini-Aufbereitung
js/player.js                               Ablaufplan, Lernmodi, Wiedergabe, MP3
js/cast.js, js/emotion.js                  Stimmenzuordnung, Gefühle → Stimmparameter
js/engines/                                Handy-Stimmen, Piper (Worker), Gemini
vendor/                                    mitgelieferte Bibliotheken (siehe unten)
```

## Lizenzen der mitgelieferten Teile

- [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) 1.18: MIT
- piper-phonemize als WebAssembly ([@diffusionstudio/piper-wasm](https://www.npmjs.com/package/@diffusionstudio/piper-wasm)): MIT, enthält [espeak-ng](https://github.com/rhasspy/espeak-ng) (GPL-3.0)
- [pdf.js](https://github.com/mozilla/pdf.js): Apache-2.0
- [mammoth.js](https://github.com/mwilliamson/mammoth.js): BSD-2-Clause
- [lamejs](https://github.com/zhuker/lamejs): LGPL-3.0
- Schrift [Literata](https://github.com/googlefonts/literata): SIL Open Font License 1.1
- Piper-Stimmen werden zur Laufzeit von [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices) geladen. Die Lizenzen stehen in den jeweiligen Model-Cards, z. B. Thorsten-Voice: CC0.
