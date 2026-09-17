# Analysequalität – Arbeitsliste

Diese Liste setzt die gewünschte Weiterentwicklung der KI-Pipeline um. Die
Punkte sind bewusst technisch und testbar formuliert; sie behaupten keine
medizinische Validierung oder Diagnosefähigkeit.

## Budget und Modellprofile

- [x] Analyseprofile (`schnell`, `standard`, `tief`, `benutzerdefiniert`) mit Bild-, Pixel-, Runden- und Antwortbudget
- [x] Provider-unabhängige Modellfähigkeiten: Kontextfenster, reservierte Ausgabe, Vision-Fähigkeit und Bildobergrenze
- [x] Vorabprüfung mit Token-/Pixel-Schätzung und automatischer Anpassung an das verfügbare Budget
- [x] Ollama mit konfigurierbarem `num_ctx` und `num_predict` ansteuern
- [x] Profilabhängige statt global fester Bildobergrenze

## Bildauswahl und Bilddaten

- [x] DICOM-Export über Cornerstones gerenderte Anzeige ausführen, mit robuster Fallback-Implementierung
- [x] Mehrere CT-Fenster als Auswahlziel des Planers unterstützen
- [x] Globale Übersichts- plus fokussierte Detailauswahl statt rein gleichmäßigem Sampling
- [x] Lokale Qualitätsprüfung: Scouts, Duplikate, ungültige Geometrie, Kontrast und Abdeckungswarnungen
- [x] Übersichtsmontage der ausgewählten/gesamten Serie als räumlicher Kontext

## Adaptive Planung

- [x] Planer um Abdeckung, Bildbudget und gewünschte Fenster erweitern
- [x] Lokale Planvalidierung inklusive Serienqualität und Budget
- [x] Plan im UI editierbar machen und Abdeckung sichtbar erläutern
- [x] Strukturierte Nachforderung weiterer Bilder durch das Auswertungsmodell
- [x] Kontrollierte Planer-/Auswertungs-Schleife mit höchstens zwei Ergänzungsrunden

## Evidenz, Ausgaben und Qualitätssicherung

- [x] Jede exportierte Bildreferenz mit Serie, Instanz, Position, Fenster, Größe und Runde protokollieren
- [x] Strukturierte Analyseausgabe mit Evidenzen, Unsicherheit, Einschränkungen und Bildnachforderungen
- [x] Lesbaren Markdown-Befund aus der strukturierten Ausgabe erzeugen
- [x] Vergleichsprotokoll für Modell, Budget, Laufzeit, Plan und Ergebnis
- [x] Unit- und Browser-Tests für Budget, Planreparatur, Bildnachforderung und Rundenlimit
