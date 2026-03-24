# KSeF Monitor – Handoff v1.0.2

Chrome extension MV3 monitorująca faktury zakupowe w KSeF API 2.0.
Repo: `github.com/olaf-wilkosz/ksef-monitor`

---

## Struktura repo

```
ksef-monitor/
├── extension/          ← ZIP z tego folderu → upload do Chrome Web Store
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
│   └── privacy-policy.html   https://olaf-wilkosz.github.io/ksef-monitor/privacy-policy.html
├── .gitattributes      ← LF normalizacja
├── README.md
├── HANDOFF.md
└── .gitignore
```

ZIP do Store:

```bash
cd extension
zip -r ../ksef-monitor-1.0.2.zip . --exclude="*.DS_Store"
```

---

## Pliki extension/

| Plik              | Opis                                                        |
| ----------------- | ----------------------------------------------------------- |
| `background.js`   | Service Worker: polling, alarmy, obsługa wiadomości z popup |
| `storage.js`      | Warstwa danych: cały dostęp do chrome.storage.local         |
| `popup.js`        | Logika UI popup                                             |
| `popup.html`      | Widoki popup + CSS                                          |
| `onboarding.js`   | Kreator pierwszego uruchomienia (ES module)                 |
| `onboarding.html` | HTML kreatora                                               |
| `ksef-api.js`     | Klient KSeF API 2.0 (auth + query)                          |
| `crypto-utils.js` | AES-256-GCM, RSA-OAEP, PBKDF2 (ES module)                   |
| `manifest.json`   | MV3, permissions, ikony, version                            |

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
    6. `POST /auth/token/redeem` → `{accessToken, refreshToken, ...}`
- Faktury: `POST /invoices/query/metadata`
- Kluczowe pola faktury: `ksefNumber`, `invoiceNumber`, `issueDate`, `seller.name`, `seller.nip`, `grossAmount`, `currency`

### Czasy życia tokenów (zweryfikowane na produkcji)

- `accessToken` → ~15 minut (exp z JWT)
- `refreshToken` → **7 dni** (pole `refreshToken.validUntil` w odpowiedzi `redeemToken`)
- `refreshToken` przy `/auth/token/refresh` → format odpowiedzi niezbadany, fallback 24h (patrz backlog)
- Token KSeF (długoterminowy) → ważny do ręcznego unieważnienia, możliwość generowania wygasa 31.12.2026

### Storage schema

```js
// chrome.storage.local
config: {
  nip:                  string,
  companyName:          string | null,
  environment:          "production" | "demo" | "test",
  pollIntervalMinutes:  number,
  pendingDaysThreshold: "month" | number,  // UI: month | 7 | 14 | 30
  notificationsEnabled: boolean,
}

encryptedToken: { ciphertext: string, iv: string, salt: string }

authState: {
  // accessToken przeniesiony do session storage (v1.0.2)
  refreshToken:        string | null,
  refreshTokenExpiry:  number,   // ms timestamp
}

pollState: {
  lastPollTime:      string | null,
  lastSuccessTime:   string | null,
  consecutiveErrors: number,
  backoffUntil:      string | null,
  needsPin:          boolean,
  needsNewToken:     boolean,
  lastError:         string | null,
}

invoiceState: {
  allSeenIds:       string[],   // rośnie bez limitu – patrz backlog
  pendingInvoices:  Invoice[],
  recentArchive:    Invoice[],  // maks. 5
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
  ksefTokenPlain:   string,
  accessTokenState: { accessToken: string, accessTokenExpiry: number }
}
```

```js
// Invoice (znormalizowana)
{
  id: string, ksefRef: string, invoiceNumber: string,
  issueDate: string, sellerName: string, sellerNip: string,
  grossAmount: number, currency: string, fetchedAt: string,
}
```

### Kluczowe decyzje projektowe

- **Hierarchia auth** (`getOrRefreshAccessToken`):
    1. `accessToken` z session storage (~15 min)
    2. `refreshToken` z local storage → silent refresh (7 dni)
    3. `ksefTokenPlain` z session storage → pełna re-auth bez PIN
    4. `needsPin=true` → polling staje, badge `!`
- **UI-lock (4h)** → od v1.0.2 weryfikuje PIN kryptograficznie przez `VERIFY_PIN`; wcześniej dowolny PIN przechodził gdy refresh token był ważny
- **PIN lockout** → 5 błędnych prób → 30s blokada z odliczaniem; reset po sukcesie lub wygaśnięciu
- **needsNewToken=true** → HTTP 450, token unieważniony, viewNewToken
- **Retry przy refresh** → tylko błędy sieci i 5xx; 401/403 jest finalne (od v1.0.2)
- **Rate limit 429** → backoff + RESTORE_ALARM
- **NIP** → zawsze wyciągany z tokenu, pole readonly
- **Walidacja tokenu** → regex oparty na jednej próbce JDG; format dla spółek nieznany
- **refreshTokenExpiry** → czytamy `data.refreshToken.validUntil`; przy refresh endpoint fallback 24h
- **onboarding jako popup window** → `chrome.windows.create`, prawy górny róg
- **Kolory** → `#dc0032` czerwień, `#013f71` granat

### Widoki popup

```
viewSetup      – brak tokenu
viewPin        – PIN (needsPin=true lub UI-lock 4h)
viewNewToken   – nowy token (HTTP 450)
viewMain       – lista faktur
viewSettings   – konfiguracja
viewError      – błąd krytyczny (PRD)
viewLogs       – log błędów
```

---

## Chrome Web Store

- Konto: ksef-monitor@pm.me (devconsole)
- Store URL: https://chromewebstore.google.com/detail/ksef-monitor/adfieckbhbajegaomloplmkiimcgamgk
- Privacy policy: https://olaf-wilkosz.github.io/ksef-monitor/privacy-policy.html
- Status: v1.0.0 opublikowane (16.03.2026), v1.0.1 w recenzji, v1.0.2 w przygotowaniu
- Materiały: `store/listing.md`, `store/screenshots/`

---

## Backlog

### 🔴 Priorytetowe

- `refreshTokenExpiry` przy `/auth/token/refresh` – zbadać format odpowiedzi gdy przyjdzie faktura; fallback 24h może skracać żywotność sesji
- `allSeenIds` pruning – rośnie bez ograniczeń; przy 500+ faktur/rok zacznie wpływać na performance

### 🟡 Polish

- Sticky nagłówki sekcji w liście faktur (przy 20+ fakturach)
- Date range picker dla progu „oczekujących"
- ARIA: `confirmModal` bez `role="dialog"`, `aria-modal="true"` i focus trap

### 🟡 Techniczny

- Weryfikacja regex tokenu na tokenach spółek/pieczęć
- crypto-shared.js refactor (niski priorytet)

### 🔴 Post-1.0

- Firefox port (Zen Browser jako cel)
- Multi-firma/NIP
- Monetyzacja (Ko-fi / GitHub Sponsors)

---

## Jak testować

1. `chrome://extensions` → Tryb dewelopera → Załaduj rozpakowane → wskaż `extension/`
2. Po zmianie: kliknij 🔄 na karcie rozszerzenia
3. Logi SW: kliknij „Service Worker" w `chrome://extensions`
4. Logi popup: DevTools → prawy klik → Zbadaj
5. Test UI-lock: w konsoli SW: `chrome.storage.local.set({pollState: {lastSuccessTime: new Date(Date.now()-5*3600000).toISOString(), consecutiveErrors:0, backoffUntil:null, needsPin:false, needsNewToken:false, lastError:null}})`
6. Test lockout PIN: 5 błędnych PINów → 30s blokada z odliczaniem

## Jak zacząć nową sesję

Powiedz: _„Kontynuujemy KSeF Monitor"_ i wskaż punkt z backlogu lub opisz co chcesz zrobić.
