# Stadt Tracker (Webapp)

Markiert per GPS jede Straße, auf der du warst. Läuft im Browser, lässt sich am iPhone zum Home-Bildschirm hinzufügen.

## Starten

Die Dateien in diesem Ordner auf einen beliebigen statischen Webspace mit **HTTPS** legen (z. B. GitHub Pages). Ohne HTTPS gibt der Browser keinen Standort frei.

Zum Ausprobieren am Mac: im Ordner `python3 -m http.server 8000` starten und `http://localhost:8000` öffnen.

Am iPhone: Seite in Safari öffnen → Teilen → **Zum Home-Bildschirm**. Dann „Straßendaten laden“ und auf der Karte „Start“.

## Konto, Freunde, geteilte Karten

Optional. Die Einrichtung steht in `SETUP.md`. Ohne sie läuft die App rein lokal.

## Grenzen einer Webapp

- Aufzeichnung nur, solange die Seite offen und der Bildschirm an ist. Während der Aufzeichnung hält die App den Bildschirm wach.
- Strecken aus anderen Apps lassen sich als GPX importieren (Einstellungen).
- Alle Daten liegen im Browser-Speicher dieses Geräts. Regelmäßig eine GPX-Sicherung exportieren.

## Anpassen

Stadt, Straßentypen, Radius und Schwellen stehen oben in `core.js` unter `CFG`.
