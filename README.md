# Șeptică 3v3 Online

## Pornire locală
1. Instalează Node.js 18+.
2. Deschide terminalul în folder.
3. Rulează `npm install`.
4. Rulează `npm start`.
5. Deschide `http://localhost:3000`.

## Joc pe 6 telefoane
Ca să meargă din locuri diferite, proiectul trebuie publicat pe un serviciu care rulează Node.js + WebSockets, de exemplu Render, Railway sau Fly.io.

Host-ul creează camera și trimite codul de 6 cifre celorlalți 5 jucători.

## Reguli implementate în prototip
- 6 jucători: J1/J3/J5 vs J2/J4/J6.
- 7 taie orice carte.
- O carte cu aceeași valoare ca prima carte din mână taie.
- Ultimul jucător care taie câștigă mâna.
- As și 10 valorează câte 1 punct.
- Pentru versiunea inițială se împart 5 cărți fiecărui jucător; cele 2 cărți rămase nu sunt folosite.

Notă: există variante regionale de Șeptică. Dacă vrei regula exactă cu refacerea mâinii după tăiere sau cu talon, aceasta trebuie ajustată în server.js.
