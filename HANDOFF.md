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
│   └── privacy-policy.html
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
| `storage.js`      | Warstwa danych: chrome.storage.local + session              |
| `popup.js`        | Logika UI popup                                             |
| `popup.html`      | Widoki popup + CSS                                          |
| `onboarding.js`   | Kreator pierwszego uruchomienia (ES module)                 |
| `onboarding.html` | HTML kreatora                                               |
| `ksef-api.js`     | Klient KSeF API 2.0 (auth + query)                          |
| `crypto-utils.js` | AES-256-GCM, RSA-OAEP, PBKDF2 (ES module)                   |
| `manifest.json`   | MV3, permissions, ikony, version                            |

Uwaga: `onboarding.html` używa `type="module"` i importuje `encryptToken` bezpośrednio z `crypto-utils.js`.

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
- Kluczowe pola faktury: `ksefNumber`, `invoiceNumber`, `issueDate`, `seller.name`, `seller.nip`, `grossAmount`, `currency`

### Czasy życia tokenów (zweryfikowane na produkcji)

- `accessToken` → ~15 minut (pole `validUntil` w odpowiedzi, nie tylko `exp` z JWT)
- `refreshToken` → **7 dni** (pole `refreshToken.validUntil` w odpowiedzi `redeemToken`)
- `refreshToken` przy `/auth/token/refresh` → nie jest odnawiany, zostaje ten sam przez całe 7 dni
- Token KSeF (długoterminowy) → ważny do ręcznego unieważnienia w portalu, możliwość generowania wygasa 31.12.2026

### Storage schema

```js
// chrome.storage.local
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
  ksefTokenPlain:   string,                                       // odszyfrowany token KSeF
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

### Hierarchia auth (getOrRefreshAccessToken)

1. `accessToken` z session storage (~15 min)
2. `refreshToken` z local storage → `POST /auth/token/refresh` z Bearer header (ważny 7 dni)
3. `ksefTokenPlain` z session storage → pełna re-auth bez PIN (dostępny gdy przeglądarka otwarta)
4. `needsPin=true` → polling staje, badge `!`

### Kluczowe decyzje projektowe

- **UI-lock (4h)** → popup wymaga PIN po 4h braku aktywności; weryfikuje kryptograficznie przez `VERIFY_PIN` w background (od v1.0.2 – wcześniej dowolny PIN przechodził gdy refresh token był ważny)
- **PIN lockout** → 5 błędnych prób → 30s blokada z odliczaniem; reset po sukcesie lub wygaśnięciu
- **`clearAuthState` NIE jest wywoływane przy AUTH_REQUIRED** → refreshToken musi przeżyć błędne próby PIN i restart przeglądarki; czyścimy tylko przy HTTP 450 i świadomej zmianie tokenu
- **`CLEAR_BACKOFF` NIE jest wysyłane przed `POLL_NOW`** przy crypto-lock → kasowałoby `needsPin` zanim poll dostanie szansę użyć PINu przez właściwą ścieżkę
- **`POLL_NOW` zwraca realny status** → `{ok: !needsPin && !needsNewToken}` po pollu, nie zawsze `ok: true`
- **needsNewToken=true** → HTTP 450, token unieważniony, viewNewToken
- **Retry przy refresh** → tylko błędy sieci i 5xx; 401/403 jest finalne (nie retryujemy)
- **Rate limit 429** → backoff + RESTORE_ALARM (nie setTimeout – SW może zasnąć)
- **NIP** → zawsze wyciągany z tokenu (`|nip-XXXXXXXXXX|`), pole readonly
- **Walidacja tokenu** → regex oparty na jednej próbce JDG; format dla spółek/pieczęci nieznany
- **onboarding jako popup window** → `chrome.windows.create`, prawy górny róg okna przeglądarki
- **Kolory KSeF** → `#dc0032` czerwień, `#013f71` granat

### Widoki popup

```
viewSetup      – brak tokenu (pierwszy raz lub po clearAll)
viewPin        – PIN (needsPin=true lub UI-lock 4h)
viewNewToken   – nowy token (HTTP 450: token unieważniony)
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
- Status: v1.0.1 opublikowane (21.03.2026), v1.0.2 w przygotowaniu
- Materiały: `store/listing.md` (opisy PL+EN), `store/screenshots/` (5 screenshotów + 2 banery)

---

## Backlog

### 🔴 Przed releasem 1.0.2

- Zbumpować `manifest.json` do `1.0.2`

### 🟡 Polish

- Sticky nagłówki sekcji w liście faktur (przy 20+ fakturach)
- Date range picker dla progu „oczekujących" (cross-platform, bez native `<input type="date">`)
- ARIA: `confirmModal` bez `role="dialog"`, `aria-modal="true"` i focus trap przy nawigacji klawiaturą

### 🟡 Techniczny

- `allSeenIds` pruning – rośnie bez ograniczeń; przy 500+ faktur/rok zacznie wpływać na performance `updateInvoices` (liniowe po rozmiarze kolekcji)
- Weryfikacja regex tokenu na tokenach spółek/pieczęć elektroniczna (format zweryfikowany tylko na 1 próbce JDG)

### 🔴 Post-1.0

- Firefox port (Zen Browser jako cel testowy; różnice `browser.*` vs `chrome.*`, SW lifecycle)
- Multi-firma/NIP
- Monetyzacja (Ko-fi / GitHub Sponsors)

---

## Jak testować

1. `chrome://extensions` → Tryb dewelopera → Załaduj rozpakowane → wskaż `extension/`
2. Po zmianie kodu: kliknij 🔄 na karcie rozszerzenia
3. Logi SW: kliknij „Service Worker" w `chrome://extensions` – konsola musi być otwarta zanim wykonasz akcję
4. Logi popup: kliknij prawym na ikonę rozszerzenia → Zbadaj
5. **Test UI-lock** (konsola SW):

```js
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
```

6. **Test PIN lockout**: wpisz 5 błędnych PINów → 30s blokada z odliczaniem
7. **Test refresh tokenu** (konsola SW po zalogowaniu):

```js
const s = await chrome.storage.session.get('accessTokenState');
s.accessTokenState.accessTokenExpiry = Date.now() - 1000;
await chrome.storage.session.set(s);
```

Następnie "Sprawdź teraz" – powinno odświeżyć bez PINu, badge powinien zostać.

## Jak zacząć nową sesję

Powiedz: _„Kontynuujemy KSeF Monitor"_ i wskaż punkt z backlogu lub opisz co chcesz zrobić.
