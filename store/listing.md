# KSeF Monitor – teksty do sklepów z rozszerzeniami

---

## KRÓTKI OPIS (do 132 znaków)

**PL:**
Monitoruj nowe faktury w KSeF bez logowania do portalu. Powiadomienie gdy pojawi się nowa faktura.

**EN:**
Monitor new invoices in Poland's KSeF system without logging into the portal. Get notified instantly.

---

## DŁUGI OPIS – POLSKI

KSeF Monitor to rozszerzenie przeglądarki, które sprawdza Krajowy System e-Faktur w tle i powiadamia Cię, gdy pojawi się nowa faktura zakupowa – bez konieczności logowania do portalu KSeF.

**Jak to działa**

Po jednorazowej konfiguracji (wklejenie tokenu KSeF, ustawienie PIN-u) rozszerzenie działa samodzielnie. Loguje się do KSeF API, sprawdza nowe faktury według ustalonego harmonogramu i wyświetla ich liczbę na ikonie w pasku przeglądarki. Kliknięcie ikony pokazuje listę z nazwą wystawcy, numerem faktury i kwotą.

**Główne funkcje**

• Automatyczne sprawdzanie KSeF co godzinę lub rzadziej – Ty decydujesz
• Licznik nieprzejrzanych faktur na ikonie rozszerzenia
• Lista faktur z nazwą wystawcy, numerem i kwotą brutto
• Oznaczanie faktur jako przejrzane z możliwością cofnięcia
• Opcjonalne powiadomienia systemowe przy nowej fakturze
• Obsługa wielu NIP-ów – monitoruj kilka działalności jednocześnie

**Bezpieczeństwo**

Token KSeF jest szyfrowany lokalnie algorytmem AES-256-GCM. Klucz pochodzi z Twojego PIN-u i nigdy nie jest przechowywany. Rozszerzenie komunikuje się wyłącznie z api.ksef.mf.gov.pl – żadne dane nie trafiają do zewnętrznych serwerów.

**Wymagania**

• Przeglądarka Chrome 88+ lub Firefox 142+
• Token KSeF z uprawnieniem „przeglądanie faktur" (do wygenerowania w portalu ksef.podatki.gov.pl)

**Kontakt i zgłaszanie błędów**

Pytania i sugestie: ksef-monitor@pm.me
Błędy: github.com/olaf-wilkosz/ksef-monitor/issues

---

## DŁUGI OPIS – ENGLISH

KSeF Monitor is a browser extension that checks Poland's National e-Invoice System (KSeF) in the background and notifies you when a new purchase invoice arrives – no need to log into the portal manually.

**How it works**

After a one-time setup (paste your KSeF token, set a PIN), the extension works on its own. It authenticates with the KSeF API, checks for new invoices on a schedule, and displays the count on the extension icon. Click the icon to see a list with vendor name, invoice number, and amount.

**Key features**

• Automatic KSeF polling every hour or less frequently – your choice
• Unread invoice counter on the extension icon
• Invoice list with vendor name, number, and gross amount
• Mark invoices as reviewed with undo support
• Optional system notifications for new invoices
• Multi-NIP support – monitor multiple businesses simultaneously

**Security**

Your KSeF token is encrypted locally using AES-256-GCM. The encryption key is derived from your PIN and is never stored. The extension communicates only with api.ksef.mf.gov.pl – no data is sent to any third-party servers.

**Requirements**

• Chrome 88+ or Firefox 142+
• A KSeF token with "invoice viewing" permission (generated at ksef.podatki.gov.pl)

**Contact and bug reports**

Questions and feedback: ksef-monitor@pm.me
Bug reports: github.com/olaf-wilkosz/ksef-monitor/issues

---

## MANIFEST – pole description (do 132 znaków, używane w chrome://extensions)

Powiadomienia o nowych fakturach w Krajowym Systemie e-Faktur (KSeF API 2.0)
