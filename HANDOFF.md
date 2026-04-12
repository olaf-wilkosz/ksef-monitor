# KSeF Monitor – Handoff v1.0.3

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

| Plik              | Opis                                                        |
| ----------------- | ----------------------------------------------------------- |
| `background.js`   | Service Worker: polling, alarmy, obsługa wiadomości z popup |
| `storage.js`      | Warstwa danych: chrome.storage.local + session              |
| `popup.js`        | Logika UI popup                                             |
| `popup.html`      | Widoki popup + CSS                                          |
| `onboarding.js`   | Kreator pierwszego uruchomienia (ES module)                 |
| `onboarding.html` | HTML kreatora                                               |
| `ksef-api.js`     | Klient KSeF API 2.0 (auth + query)                          |
| `crypto-utils.js` | AES-256-GCM, RSA-OAEP, PBKDF2 (ES module)                   |
| `manifest.json`   | MV3, permissions, ikony, version, gecko.id                  |

Uwaga: `onboarding.html` używa `type="module"` i importuje `encryptToken` bezpośrednio z `crypto-utils.js`. Firefox bundle spłaszcza tylko `background.js` – pozostałe pliki trafiają do `dist-firefox/` bez zmian.

---

## Architektura

### KSeF API 2.0

- Base URL prod: `https://api.ksef.mf.gov.pl/v2`
- Base URL demo: `https://api-demo.ksef.mf.gov.pl/v2`
- Base URL test: `https://api-test.ksef.mf.gov.pl/v2`
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

### Storage schema

```js
// chrome.storage.local (browser.storage.local w Firefox)
config: {
  nip:                  string,
  companyName:          string | null,
  environment:          "production" | "demo" | "test",
  pollIntervalMinutes:  number,
  pendingDaysThreshold: "month" | number,  // UI oferuje: month | 7 | 14 | 30
  notificationsEnabled: boolean,
}

encryptedToken: { ciphertext: string, iv: string, salt: string }

authState: {
  // accessToken przeniesiony do session storage (v1.0.2) – nie leży na dysku
  refreshToken:        string | null,
  refreshTokenExpiry:  number,   // ms timestamp
}

pollState: {
  lastPollTime:      string | null,
  lastSuccessTime:   string | null,
  consecutiveErrors: number,
  backoffUntil:      string | null,
  needsPin:          boolean,      // crypto-lock: refresh token wygasł lub brak session po restarcie
  needsNewToken:     boolean,      // HTTP 450: token unieważniony
  lastError:         string | null,
}

invoiceState: {
  allSeenIds:       string[],   // rośnie bez limitu – deduplikacja przy pollu
  pendingInvoices:  Invoice[],  // wszystkie nieprzejrzane; renderowane po 10 z "Pokaż kolejne"
  recentArchive:    Invoice[],  // przejrzane; TTL 90 dni, bez limitu ilościowego
  lastQueryTime:    string | null,
}

pinLockout: {
  attempts:    number,
  lockedUntil: number | null,  // ms timestamp
}

archiveUndoBuffer: Invoice | null
errorLog: Array<{ time: string, code: string, message: string }>  // maks. 50
```

```js
// chrome.storage.session (RAM, czyszczony przy zamknięciu przeglądarki)
{
  ksefTokenPlain:   string,                                       // odszyfrowany token KSeF
  accessTokenState: { accessToken: string, accessTokenExpiry: number }
}
```

```js
// Invoice (znormalizowana – pola zweryfikowane na produkcji)
{
  id: string, ksefRef: string, invoiceNumber: string,
  issueDate: string, sellerName: string, sellerNip: string,
  grossAmount: number, currency: string, fetchedAt: string,
}
```

### Hierarchia auth (getOrRefreshAccessToken)

1. `accessToken` z session storage (~15 min)
2. `refreshToken` z local storage → `POST /auth/token/refresh` z Bearer header (ważny 7 dni)
3. `ksefTokenPlain` z session storage → pełna re-auth bez PIN (dostępny gdy przeglądarka otwarta)
4. `needsPin=true` → polling staje, badge `!`

### Kluczowe decyzje projektowe

- **UI-lock (4h)** → popup wymaga PIN po 4h braku aktywności; weryfikuje kryptograficznie przez `VERIFY_PIN` w background
- **PIN lockout** → 5 błędnych prób → 30s blokada z odliczaniem; reset po sukcesie lub wygaśnięciu
- **`clearAuthState` NIE jest wywoływane przy AUTH_REQUIRED** → refreshToken musi przeżyć błędne próby PIN
- **`CLEAR_BACKOFF` NIE jest wysyłane przed `POLL_NOW`** przy crypto-lock → kasowałoby `needsPin`
- **`POLL_NOW` zwraca realny status** → `{ok: !needsPin && !needsNewToken}` po pollu
- **needsNewToken=true** → HTTP 450, token unieważniony, viewNewToken
- **Retry przy refresh** → tylko błędy sieci i 5xx; 401/403 jest finalne
- **Rate limit 429** → backoff + RESTORE_ALARM (nie setTimeout – SW może zasnąć)
- **NIP** → zawsze wyciągany z tokenu (`|nip-XXXXXXXXXX|`), pole readonly
- **Walidacja tokenu** → regex oparty na jednej próbce JDG; format dla spółek/pieczęci nieznany
- **onboarding jako popup window** → `chrome.windows.create`, prawy górny róg okna przeglądarki
- **Kolory KSeF** → `#dc0032` czerwień, `#013f71` granat
- **Firefox background** → bundlowany przez esbuild (IIFE) bo FF MV3 nie obsługuje ES modules w SW

### Widoki popup

```
viewSetup      – brak tokenu (pierwszy raz lub po clearAll)
viewPin        – PIN (needsPin=true lub UI-lock 4h)
viewNewToken   – nowy token (HTTP 450: token unieważniony)
viewMain       – lista faktur z paginacją (10 na start, "Pokaż kolejne")
viewSettings   – konfiguracja
viewError      – błąd krytyczny (PRD)
viewLogs       – log błędów
```

---

## Stores

### Chrome Web Store

- Konto: ksef-monitor@pm.me (devconsole)
- Store URL: https://chromewebstore.google.com/detail/ksef-monitor/adfieckbhbajegaomloplmkiimcgamgk
- Status: v1.0.2 opublikowane

### Firefox Add-on Store (AMO)

- Konto: konto Mozilla (addons.mozilla.org)
- Store URL: https://addons.mozilla.org/pl/firefox/addon/ksef-monitor/
- gecko.id: `ksef-monitor@pm.me`
- strict_min_version: 140.0
- Status: v1.0.2 w weryfikacji
- Uwaga: polityka prywatności wklejona inline w panelu AMO – aktualizować ręcznie przy zmianach

### Materiały wspólne

- Privacy policy: https://olaf-wilkosz.github.io/ksef-monitor/privacy-policy.html
- Screenshoty: `store/screenshots/` (5 screenshotów + 2 banery)

---

## Backlog

### 🔴 Aktywne

- Multi-NIP – priorytet po 1.0.3; wymaga refaktoru storage, polling loop i popup UI

### 🟡 Polish

- Date range picker dla progu „oczekujących" (cross-platform)
- Wskaźnik dostępności KSeF w UI (aktualnie błędy tylko w logach)

### 🟡 Techniczny

- Weryfikacja regex tokenu na tokenach spółek/pieczęć elektroniczna (format zweryfikowany tylko na 1 próbce JDG)

### 💰 Monetyzacja

- Ko-fi / GitHub Sponsors – przyjmujemy datki, warto skonfigurować przed wzrostem bazy użytkowników

---

## Jak testować

### Chrome / Brave

1. `chrome://extensions` → Tryb dewelopera → Załaduj rozpakowane → wskaż `extension/`
2. Po zmianie kodu: kliknij 🔄 na karcie rozszerzenia
3. Logi SW: kliknij „Service Worker" w `chrome://extensions`
4. Logi popup: kliknij prawym na ikonę rozszerzenia → Zbadaj

### Firefox / Zen Browser

1. `about:debugging` → "Ten Firefox" → "Załaduj tymczasowy dodatek" → wskaż `dist-firefox/manifest.json`
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

// Test refresh tokenu (konsola SW po zalogowaniu):
const s = await chrome.storage.session.get('accessTokenState');
s.accessTokenState.accessTokenExpiry = Date.now() - 1000;
await chrome.storage.session.set(s);
```

## Jak zacząć nową sesję

Powiedz: _„Kontynuujemy KSeF Monitor"_ i wskaż punkt z backlogu lub opisz co chcesz zrobić.
