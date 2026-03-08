# KSeF Watcher – Handoff v0.9.1

Chrome extension MV3 monitorująca faktury zakupowe w KSeF API 2.0.
Lokalizacja plików: `/mnt/user-data/outputs/ksef-watcher/`

---

## Pliki projektu

| Plik | Opis |
|------|------|
| `background.js` | Service Worker: polling, alarmy, obsługa wiadomości z popup |
| `storage.js` | Warstwa danych: cały dostęp do chrome.storage.local |
| `popup.js` | Logika UI popup |
| `popup.html` | Widoki popup + CSS |
| `onboarding.js` | Kreator pierwszego uruchomienia (bez ES modules) |
| `onboarding.html` | HTML kreatora |
| `ksef-api.js` | Klient KSeF API 2.0 (auth + query) |
| `crypto-utils.js` | AES-256-GCM, RSA-OAEP, PBKDF2 (ES module, używany przez background) |
| `crypto-utils-compat.js` | Duplikacja logiki crypto dla onboarding.js (nie ES module). UWAGA: przy zmianie parametrów kryptograficznych aktualizuj OBA pliki. Docelowo: wydzielić crypto-shared.js. |
| `manifest.json` | MV3, permissions, ikony |
| `icons/` | PNG 16/48/128 + icon.svg (źródło prawdy) |

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
- **onboarding jako popup window** → chrome.windows.create, prawy górny róg okna przeglądarki
- **Kolory KSeF** → `#dc0032` czerwień, `#013f71` granat
- **crypto-utils-compat.js** → duplikacja (nie wrapper), wymagana bo onboarding nie może używać ES modules

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

## Backlog

### 🔴 Web Store (przed publikacją)
- Opisy PL + EN (krótki ≤132 znaków, długi ≤16k)
- Privacy policy HTML
- Screenshoty 1280×800 (min. 1, maks. 5)
- Konto deweloperskie $5 → https://chrome.google.com/webstore/devconsole

### 🟡 Polish
- Niestandardowa nazwa firmy dla JDG
- Data generowania tokenu z prefiksu `20260304`
- Date range picker dla progu "oczekujących"

### 🟡 Techniczny
- Krótszy backoff dla NETWORK_ERROR vs auth error przy wybudzeniu
- crypto-utils-compat.js → refactor do crypto-shared.js

### 🔴 Post-1.0
- Firefox (browser.* API, SW lifecycle)
- Multi-firma/NIP

---

## Jak testować

1. `chrome://extensions` → Tryb dewelopera → Załaduj rozpakowane
2. Po zmianie: kliknij 🔄 na karcie rozszerzenia
3. Logi SW: kliknij "Service Worker" w `chrome://extensions`
4. Logi popup: DevTools → prawy klik → Zbadaj
5. Test UI-lock: w konsoli SW ustaw `lastSuccessTime` na 5h temu

## Jak zacząć nową sesję

1. Załaduj transkrypt z `/mnt/transcripts/` (patrz `journal.txt`)
2. Powiedz: *"Kontynuujemy KSeF Watcher v0.9.1"*
3. Wskaż punkt z backlogu
