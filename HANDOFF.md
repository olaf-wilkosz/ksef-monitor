# KSeF Monitor – Handoff v1.1.0

MV3 WebExtension monitorująca faktury zakupowe w KSeF API 2.0. Działa w Chrome i Firefox.
Repo: `github.com/olaf-wilkosz/ksef-monitor`

---

## Struktura repo

```
ksef-monitor/
├── extension/          ← źródło; Chrome: ZIP z tego folderu; Firefox: przez build-firefox.mjs
│   ├── manifest.json
│   ├── background.js
│   ├── storage.js
│   ├── popup.html / popup.js
│   ├── onboarding.html / onboarding.js
│   ├── ksef-api.js
│   ├── crypto-utils.js
│   └── icons/          (icon16.png, icon48.png, icon128.png, icon.svg)
├── store/              ← materiały CWS, nie wchodzą do ZIP
│   ├── listing.md      (opisy PL + EN, krótkie + długie)
│   ├── cws-badge.png   (oficjalny badge Chrome Web Store z obramowaniem)
│   └── screenshots/    (slide-1..5.html + screenshot-1..5.png + promo-440x280 + promo-1400x560)
├── docs/               ← GitHub Pages
│   └── privacy-policy.html
├── build-firefox.mjs   ← buduje dist-firefox/ + ZIP dla Firefox (esbuild bundle)
├── package.json        ← devDependencies: esbuild, archiver
├── pnpm-lock.yaml
├── .gitattributes      ← LF normalizacja
├── .gitignore
├── README.md
└── HANDOFF.md
```

Budowanie ZIP Chrome:

```bash
cd extension
zip -r ../ksef-monitor-{version}-chrome.zip . --exclude="*.DS_Store"
```

Budowanie ZIP Firefox:

```bash
pnpm install
node build-firefox.mjs
# → ksef-monitor-{version}-firefox.zip
```

Oba ZIP-y buduje automatycznie GitHub Actions przy pushu taga `v*`.

---

## Pliki extension/

| Plik              | Opis                                                                |
| ----------------- | ------------------------------------------------------------------- |
| `background.js`   | Service Worker: polling per NIP, alarmy, obsługa wiadomości z popup |
| `storage.js`      | Warstwa danych: chrome.storage.local + session, migracja do v1.1    |
| `popup.js`        | Logika UI popup                                                     |
| `popup.html`      | Widoki popup + CSS                                                  |
| `onboarding.js`   | Kreator pierwszego uruchomienia i tryb add (`?mode=add`)            |
| `onboarding.html` | HTML kreatora                                                       |
| `ksef-api.js`     | Klient KSeF API 2.0 (auth + query)                                  |
| `crypto-utils.js` | AES-256-GCM, RSA-OAEP, PBKDF2 (ES module)                           |
| `manifest.json`   | MV3, permissions, ikony, version, gecko.id                          |

Uwaga: `onboarding.html` używa `type="module"` i importuje `encryptToken` bezpośrednio z `crypto-utils.js`. Firefox bundle spłaszcza tylko `background.js` – pozostałe pliki trafiają do `dist-firefox/` bez zmian.

---

## Architektura

### KSeF API 2.0

- Base URL prod: `https://api.ksef.mf.gov.pl/v2`
- Środowisko hardcoded jako `production` – wybór środowiska usunięty z UI (Demo/Test to narzędzia integratorów, nie podatników)
- Auth flow:
    1. `GET /security/public-key-certificates` → klucz publiczny RSA
    2. `POST /auth/challenge` → `{challenge, timestamp}`
    3. RSA-OAEP encrypt(`"token|timestampMs"`) → base64
    4. `POST /auth/ksef-token` → `{referenceNumber}`
    5. Polling `GET /auth/{refNo}` aż status = AUTHORISED
    6. `POST /auth/token/redeem` → `{accessToken: {token, validUntil}, refreshToken: {token, validUntil}, ...}`
- Refresh: `POST /auth/token/refresh`
    - refreshToken przekazywany w nagłówku `Authorization: Bearer <token>` (nie w body!)
    - Odpowiedź: `{accessToken: {token, validUntil}}` – **brak nowego refreshToken, zostaje ten sam**
- Faktury: `POST /invoices/query/metadata`
- Kluczowe pola faktury (zweryfikowane na produkcji): `ksefNumber`, `invoiceReferenceNumber`, `invoicingDate`, `seller.name`, `seller.nip`, `grossAmount`, `currency`

### Czasy życia tokenów (zweryfikowane na produkcji)

- `accessToken` → ~15 minut (pole `validUntil` w odpowiedzi, nie tylko `exp` z JWT)
- `refreshToken` → **7 dni** (pole `refreshToken.validUntil` w odpowiedzi `redeemToken`)
- `refreshToken` przy `/auth/token/refresh` → nie jest odnawiany, zostaje ten sam przez całe 7 dni
- Token KSeF (długoterminowy) → ważny do ręcznego unieważnienia w portalu, możliwość generowania wygasa 31.12.2026

### Storage schema v1.1 (multi-NIP)

```js
// chrome.storage.local (browser.storage.local w Firefox)
accounts: {
  [nip: string]: {
    encryptedToken:  { ciphertext: string, iv: string, salt: string },
    companyName:     string | null,
    environment:     "production",   // hardcoded, zawsze production
    pollOffset:      number,         // ms opóźnienia startu pollu – równomierne rozłożenie per NIP
    authState: {
      refreshToken:       string | null,
      refreshTokenExpiry: number,    // ms timestamp
    },
    pollState: {
      lastPollTime:      string | null,
      lastSuccessTime:   string | null,
      consecutiveErrors: number,
      backoffUntil:      string | null,
      needsPin:          boolean,
      needsNewToken:     boolean,
      lastError:         string | null,
    },
    invoiceState: {
      allSeenIds:      string[],    // rośnie bez limitu – deduplikacja przy pollu
      pendingInvoices: Invoice[],   // nieprzejrzane; renderowane po 10 z "Pokaż kolejne"
      recentArchive:   Invoice[],   // przejrzane; TTL 90 dni
      lastQueryTime:   string | null,
    },
  }
}

activeNip:   string | null          // aktywnie wyświetlany NIP w popup
config: {
  pollIntervalMinutes:  number,
  pendingDaysThreshold: "month" | number,   // UI: month | 7 | 14 | 30
  notificationsEnabled: boolean,
}
pinLockout:  { attempts: number, lockedUntil: number | null }
errorLog:    Array<{ time: string, code: string, message: string }>   // maks. 50
archiveUndoBuffer: { nip: string, invoice: Invoice } | null
```

```js
// chrome.storage.session (RAM, czyszczony przy zamknięciu przeglądarki)
// Per NIP – klucze z sufiksem NIP
accessTokenState_{nip}: { accessToken: string, accessTokenExpiry: number }
ksefTokenPlain_{nip}:   string
```

```js
// Invoice (znormalizowana – pola zweryfikowane na produkcji)
{
  id: string, ksefRef: string, invoiceNumber: string,
  issueDate: string, sellerName: string, sellerNip: string,
  grossAmount: number, currency: string, fetchedAt: string,
}
```

### Migracja storage

`migrateToMultiNip()` wywoływana przy każdym starcie SW – idempotentna. Przenosi stary schemat (pojedynczy NIP w `config`) do nowego (`accounts`).

### Multi-NIP – kluczowe decyzje

- **Jeden PIN** dla wszystkich NIP-ów
- **Polling offset** = `index * (intervalMs / totalNIPs)` – równomierne rozłożenie w czasie
- **Badge** = zagregowana suma `pendingCount` ze wszystkich kont
- **Blokada duplikatów** – ten sam NIP nie może być dodany dwa razy
- **Usunięcie ostatniego NIP-a** → PIN kasowany, `viewSetup`
- **Tryb add** (`?mode=add`) – weryfikuje istniejący PIN przed szyfrowaniem nowego tokenu
- **OPEN_ONBOARDING delegowany do SW** – fix MV3: popup zamknąłby się przed `window.create`
- **NipSelector**: 2–3 NIP-y → przyciski w kolumnie; 4+ → `<select>` dropdown

### Hierarchia auth (getOrRefreshAccessToken) – per NIP

1. `accessToken` z session storage (`accessTokenState_{nip}`) – ~15 min
2. `refreshToken` z `accounts[nip].authState` → `POST /auth/token/refresh` z Bearer header – 7 dni
3. `ksefTokenPlain_{nip}` z session storage → pełna re-auth bez PIN
4. `needsPin=true` → polling staje, badge `!`

### Kluczowe decyzje projektowe

- **UI-lock (4h)** → popup wymaga PIN po 4h braku aktywności
- **PIN lockout** → 5 błędnych prób → 30s blokada z odliczaniem; reset po sukcesie
- **`clearAuthState` NIE jest wywoływane przy AUTH_REQUIRED** → refreshToken przeżywa błędne próby PIN
- **`POLL_NOW` zwraca realny status** → `{ok: !needsPin && !needsNewToken}` po pollu
- **needsNewToken=true** → HTTP 450, token unieważniony, viewNewToken
- **Retry przy refresh** → tylko błędy sieci i 5xx; 401/403 jest finalne
- **Rate limit 429** → backoff + RESTORE_ALARM
- **NIP** → zawsze wyciągany z tokenu (`|nip-XXXXXXXXXX|`), pole readonly
- **onboarding jako popup window** → `chrome.windows.create`, prawy górny róg okna
- **Kolory KSeF** → `#dc0032` czerwień, `#013f71` granat
- **Firefox background** → bundlowany przez esbuild (IIFE) bo FF MV3 nie obsługuje ES modules w SW
- **Chrome popup limit 600px** → dynamiczna kompensacja: lista faktur i settings-wrap mają ustalone wysokości przez JS żeby suma nie przekroczyła 600px

### Widoki popup

```
viewSetup      – brak tokenów (pierwszy raz lub po usunięciu ostatniego NIP-a)
viewPin        – PIN (needsPin=true lub UI-lock 4h)
viewNewToken   – nowy token (HTTP 450: token unieważniony)
viewMain       – lista faktur z NipSelector (2+ NIP-y), paginacja 10+
viewSettings   – konfiguracja; NIP-y u góry, polling/faktury/powiadomienia poniżej;
                 sticky sekcja Zapisz/Odśwież/Wróć przyklejona do dołu
viewError      – błąd krytyczny
viewLogs       – log błędów
```

### Popup – wysokości (hardcoded stałe z pomiarów)

```js
// renderMainView – lista faktur
const HEADER = 42,
	FOOTER = 30,
	BTN_ROW = 53,
	WRAP_FIXED = 90,
	MAX_H = 600;
// listH = MAX_H - HEADER - WRAP_FIXED - nipH - BTN_ROW - FOOTER

// showSettingsView – settings-wrap
minHeight = maxHeight = '400px'; // 600 - 42 - 30 - 128(actions) = 400
```

Jeśli zmienią się marginesy/paddingi elementów – zaktualizuj stałe.

---

## Stores

### Chrome Web Store

- Konto: ksef-monitor@pm.me (devconsole)
- Store URL: https://chromewebstore.google.com/detail/ksef-monitor/adfieckbhbajegaomloplmkiimcgamgk
- Status: v1.0.3 opublikowane; v1.1.0 pending

### Firefox Add-on Store (AMO)

- Konto: konto Mozilla (addons.mozilla.org)
- Store URL: https://addons.mozilla.org/pl/firefox/addon/ksef-monitor/
- gecko.id: `ksef-monitor@pm.me`
- strict_min_version: 140.0
- Status: v1.0.3 opublikowane; od v1.1.0 automatyczne przez GitHub Actions (`web-ext sign`)
- Secrets: `AMO_ISSUER`, `AMO_SECRET` w GitHub Secrets
- Uwaga: polityka prywatności wklejona inline w panelu AMO – aktualizować ręcznie przy zmianach

### Materiały wspólne

- Privacy policy: https://olaf-wilkosz.github.io/ksef-monitor/privacy-policy.html
- Screenshoty: `store/screenshots/` (5 screenshotów + 2 banery) – **wymagają aktualizacji dla multi-NIP UI**

---

## Backlog

### 🟡 Do zrobienia przed/po release v1.1.0

- Screenshoty – obecne pokazują stary single-NIP UI; odświeżyć dla multi-NIP

### 🟡 Polish

- Collapsible lista NIP-ów w ustawieniach dla 5+ NIP-ów (edge case)
- Date range picker dla progu „oczekujących" (cross-platform)
- Wskaźnik dostępności KSeF w UI

### 🟡 Techniczny

- Weryfikacja regex tokenu na tokenach spółek/pieczęć elektroniczna (zweryfikowany tylko na 1 próbce JDG)

### 💰 Monetyzacja

- Ko-fi / GitHub Sponsors – przed wzrostem bazy użytkowników

---

## Jak testować

### Chrome / Brave

1. `chrome://extensions` → Tryb dewelopera → Załaduj rozpakowane → wskaż `extension/`
2. Po zmianie kodu: kliknij 🔄 na karcie rozszerzenia
3. Logi SW: kliknij „Service Worker" w `chrome://extensions`
4. Logi popup: kliknij prawym na ikonę rozszerzenia → Zbadaj

### Firefox / Zen Browser

1. `about:debugging` → „Ten Firefox" → „Załaduj tymczasowy dodatek" → wskaż `dist-firefox/manifest.json`
2. Po zmianie kodu: `node build-firefox.mjs` → kliknij 🔄 w `about:debugging`
3. Logi SW: kliknij „Zbadaj" przy rozszerzeniu

### Testy manualne

```js
// Test UI-lock (konsola SW):
chrome.storage.local.set({
	pollState: {
		lastSuccessTime: new Date(Date.now() - 5 * 3600000).toISOString(),
		consecutiveErrors: 0,
		backoffUntil: null,
		needsPin: false,
		needsNewToken: false,
		lastError: null,
	},
});

// Test PIN lockout: wpisz 5 błędnych PINów → 30s blokada z odliczaniem

// Test multi-NIP: dodaj drugi NIP przez Ustawienia → + Dodaj NIP
// (potrzebny drugi token KSeF dla innego NIP-a)
```

## Jak zacząć nową sesję

Powiedz: _„Kontynuujemy KSeF Monitor"_ i wskaż co chcesz zrobić. Pomocne: przeczytaj ten plik i aktualny `git log --oneline -20`.
