/* Verbindung zum Server für Konto, Freunde und geteilte Karten (siehe SETUP.md).
   Beide Werte stehen im Supabase-Dashboard unter Project Settings → API.
   Der Schlüssel hier ist der öffentliche ("anon" / "publishable") – er darf im Browser stehen,
   weil die Datenbank selbst jeden Zugriff prüft. NIEMALS den "service_role"- oder "secret"-Schlüssel eintragen. */
window.ST_CONFIG = {
  supabaseUrl: 'https://uukoniyxroxpjfcobhxg.supabase.co',
  supabaseKey: 'sb_publishable_FjQ1uet8ZMBvlV4lc1MxCQ_L9qemVD_'
};
