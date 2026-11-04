// Google Maps configuration for the Lab 2 prototype.
/*

  1. Create a key in Google Cloud Console (APIs & Services > Credentials).
  2. Enable: Maps JavaScript API, Places API (New), Routes API.
  3. Restrict the key:
       Application restriction: Websites
         https://marcoflesh.github.io/ (with a trailing wildcard, covers /Labs/)
         http://localhost (any port, for local testing)
       API restriction: the three APIs above.
  4. Paste the key below and push. Without a key the prototype runs in
     demo mode (schematic map, sample places) so the flow still works.

  A browser key is always visible in client code. The referrer and API
  restrictions above are what keep it safe.
*/
window.MAPS_CONFIG = {
  apiKey: "",
  mapId: "DEMO_MAP_ID",
  language: "en",
  region: "MX",
  origin: { name: "Ángel de la Independencia", address: "Paseo de la Reforma, CDMX", lat: 19.42696, lng: -99.16771 },
  destination: { name: "Coyoacán", address: "Jardín Centenario, CDMX", lat: 19.35003, lng: -99.16239 }
};
