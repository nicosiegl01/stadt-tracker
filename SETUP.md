# Konto, Freunde und geteilte Karten einrichten

Ohne diese Einrichtung läuft die App weiter rein lokal. Für Login und Freunde braucht sie einen Server; vorgesehen ist Supabase (kostenloser Tarif reicht).

## 1. Supabase-Projekt anlegen

1. Auf supabase.com ein Konto anlegen und dort die Zwei-Faktor-Anmeldung einschalten.
2. Neues Projekt erstellen. Als Region eine in der EU wählen (z. B. Frankfurt). Das Datenbank-Passwort sicher aufbewahren; die App braucht es nicht.

## 2. Datenbank einrichten

Im Dashboard den **SQL Editor** öffnen, den gesamten Inhalt von `supabase.sql` einfügen und ausführen. Das legt Tabellen, Zugriffsregeln und Funktionen an.

## 3. Anmeldung einstellen

Unter **Authentication → URL Configuration** als Site URL die Adresse deiner App eintragen.

Supabase verschickt im kostenlosen Tarif einen Anmeldelink (die E-Mail-Vorlagen lassen sich nur mit eigenem SMTP-Dienst ändern). Die App kommt damit zurecht: Link antippen, oder – in der App am Home-Bildschirm – den Link kopieren und im Anmeldefeld einfügen.

## 4. App verbinden

Unter **Project Settings → API** die **Project URL** und den **öffentlichen Schlüssel** (anon / publishable) kopieren und in `config.js` eintragen:

```js
window.ST_CONFIG = {
  supabaseUrl: 'https://DEINPROJEKT.supabase.co',
  supabaseKey: 'DEIN_ÖFFENTLICHER_SCHLÜSSEL'
};
```

Niemals den `service_role`- oder `secret`-Schlüssel eintragen. Der umgeht alle Zugriffsregeln.

Danach alle Dateien wieder auf den Webspace laden.

## 5. Erstes Konto

Öffne die App, Tab **Freunde**, melde dich an und lege dein Profil an. Der erste Nutzer braucht keinen Einladungscode. Alle weiteren brauchen einen Code, den du (oder ein anderer Nutzer) im Tab Freunde erstellst.

## Gut zu wissen

- Der eingebaute E-Mail-Versand von Supabase ist auf wenige E-Mails pro Stunde begrenzt. Für mehr als eine Handvoll Nutzer einen eigenen SMTP-Dienst in den Auth-Einstellungen hinterlegen.
- Wer deinen Webspace (z. B. das GitHub-Konto) übernimmt, kann die App verändern. Sichere auch dieses Konto mit Zwei-Faktor-Anmeldung.
- Sobald andere Personen die App nutzen, verarbeitest du deren personenbezogene Daten (E-Mail-Adresse, besuchte Straßen). Dafür gelten die Pflichten der DSGVO, etwa eine Datenschutzerklärung.

## Was auf dem Server liegt

- E-Mail-Adresse (nur für die Anmeldung, für andere Nutzer nie sichtbar)
- Nutzername, Sichtbarkeit, Freundschaften, Einladungscodes
- Bei Sichtbarkeit „Freunde“ oder „Alle“: die Mittelpunkte der besuchten Straßenstücke und drei Kennzahlen (Meter, Gesamtmeter, fertige Straßen)

Nicht auf dem Server: GPS-Aufzeichnung, Zeitpunkte, aktueller Standort. Bei Sichtbarkeit „Privat“ wird die Karte gar nicht hochgeladen und eine vorhandene gelöscht.
