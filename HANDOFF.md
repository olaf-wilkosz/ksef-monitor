# KSeF Monitor – Handoff v1.0.0

Chrome extension MV3 monitorująca faktury zakupowe w KSeF API 2.0.
Lokalizacja plików: `/mnt/user-data/outputs/ksef-monitor/`

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
│   ├── screenshots/    (slide-1..5.html + screenshot-1..5.png)
├── docs/               ← GitHub Pages
│   └── privacy-policy.html   https://olaf-wilkosz.github.io/ksef-monitor/privacy-policy.html
├── README.md
├── HANDOFF.md
└── .gitignore
```

ZIP do Store:

```bash
cd extension
zip -r ../ksef-monitor-1.0.0.zip . --exclude="*.DS_Store"
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

Uwaga: `crypto-utils-compat.js` został usunięty w v0.9.2. `onboarding.html` używa `type="module"` i importuje `encryptToken` bezpośrednio z `crypto-utils.js`.

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
    6. `POST /auth/token/redeem` → `{sessionToken, refreshToken, ...}`
- Faktury: `POST /invoices/query/metadata`
- Kluczowe pola faktury: `ksefNumber`, `invoiceNumber`, `issueDate`, `seller.name`, `seller.nip`, `grossAmount`, `currency`

### Storage schema (`chrome.storage.local`)

```js
config: {
  nip:                  string,
  companyName:          string | null,
  environment:          "production" | "demo" | "test",
  pollIntervalMinutes:  number,
  pendingDaysThreshold: "week" | "month" | "quarter" | "year" | number,
  notificationsEnabled: boolean,
}

encryptedToken: { ciphertext: string, iv: string, salt: string }

authState: {
  accessToken:         string | null,
  accessTokenExpiry:   number,   // ms timestamp
  refreshToken:        string | null,
  refreshTokenExpiry:  number,   // ms timestamp
}

pollState: {
  lastPollTime:      string | null,
  lastSuccessTime:   string | null,
  consecutiveErrors: number,
  backoffUntil:      string | null,
  needsPin:          boolean,      // crypto-lock: refresh token wygasł (~24h)
  needsNewToken:     boolean,      // HTTP 450: token unieważniony
  lastError:         string | null,
}

invoiceState: {
  allSeenIds:       string[],
  pendingInvoices:  Invoice[],
  recentArchive:    Invoice[],   // maks. 5
  lastQueryTime:    string | null,
}

archiveUndoBuffer: Invoice | null
errorLog: Array<{ time: string, code: string, message: string }>  // maks. 50
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

- **needsPin=true** → crypto-lock (refresh token wygasł ~24h), background zatrzymuje polling, badge `!`
- **PIN_TIMEOUT_MS (4h)** → UI-lock tylko w popup, background polluje normalnie przez refresh token. NIE weryfikuje PIN kryptograficznie – świadoma decyzja.
- **needsNewToken=true** → HTTP 450, token unieważniony, viewNewToken
- **Refresh retry** → 3× z 5s przerwą przed ustawieniem needsPin; łapie chwilowy brak sieci przy wybudzeniu
- **Rate limit 429** → backoff + RESTORE_ALARM (nie setTimeout)
- **Jeden listener onAlarm** obsługuje ALARM_NAME (poll) i RESTORE_ALARM
- **NIP** → zawsze wyciągany z tokenu (`|nip-XXXXXXXXXX|`), pole readonly, brak ręcznego wpisywania
- **onboarding jako popup window** → chrome.windows.create, prawy górny róg okna przeglądarki
- **Kolory KSeF** → `#dc0032` czerwień, `#013f71` granat
- **Pasek postępu onboardingu** → `{ 1: 20, 2: 60, 3: 100 }`

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
- Privacy policy: https://olaf-wilkosz.github.io/ksef-monitor/privacy-policy.html
- Status (marzec 2026): **przesłane do recenzji**, publikacja automatyczna po akceptacji
- Po akceptacji: zaktualizować link w README (podmienić `*(wkrótce)*`)
- Materiały: `store/listing.md` (opisy PL+EN), `store/screenshots/` (5 screenshotów + 2 banery), `store/store-checklist.md`

---

## Backlog

### 🔴 Po akceptacji Store

- Podmiana `*(wkrótce)*` na prawdziwy link w README
- Banery promocyjne w README (pliki w `store/screenshots/promo-440x280.png`, `promo-1400x560.png`)

### ✅ Zrobione (v1.0.0)

- Badge po restarcie przeglądarki i po UI-lock: `restoreBadgeFromState()`, `onStartup` listener
- Progress bar onboarding krok 1: `width:20%` w HTML + `PROGRESS[1]=20` w JS
- Data wygenerowania tokenu w onboardingu: regex `^(\d{4})(\d{2})(\d{2})` z prefiksu tokenu, fade-in `opacity 0.3s`

### 🟡 Polish

- Niestandardowa nazwa firmy dla JDG (nadpisanie `companyName` w ustawieniach)
- Date range picker dla progu "oczekujących"

### 🟡 Techniczny

- Krótszy backoff dla NETWORK_ERROR vs auth error przy wybudzeniu
- crypto-shared.js refactor (niska priorytet)

### 🔴 Post-1.0

- Firefox port (Zen Browser jako cel testowy; różnice `browser.*` vs `chrome.*`, SW lifecycle)
- Multi-firma/NIP
- Monetyzacja (Ko-fi / GitHub Sponsors)

---

## Jak testować

1. `chrome://extensions` → Tryb dewelopera → Załaduj rozpakowane → wskaż `extension/`
2. Po zmianie: kliknij 🔄 na karcie rozszerzenia
3. Logi SW: kliknij "Service Worker" w `chrome://extensions`
4. Logi popup: DevTools → prawy klik → Zbadaj
5. Test UI-lock: w konsoli SW ustaw `lastSuccessTime` na 5h temu

## Jak zacząć nową sesję

1. Załaduj transkrypt z `/mnt/transcripts/` (patrz `journal.txt`)
2. Powiedz: _"Kontynuujemy KSeF Monitor v1.0.0"_
3. Wskaż punkt z backlogu
