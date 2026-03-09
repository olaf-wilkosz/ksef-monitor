# KSeF Monitor

![Wersja](https://img.shields.io/badge/wersja-1.0.0-013f71) ![Licencja](https://img.shields.io/badge/licencja-MIT-green) ![Chrome](https://img.shields.io/badge/Chrome-88%2B-yellow)

Rozszerzenie Chrome, które monitoruje nowe faktury zakupowe w Krajowym Systemie e-Faktur i powiadamia Cię gdy pojawi się coś nowego – bez logowania do portalu.

<img src="store/screenshots/screenshot-5.png" width="900" alt="Działa z Krajowym Systemem e-Faktur">

---

## Co robi

- Sprawdza KSeF w tle co godzinę (lub rzadziej – do wyboru)
- Pokazuje liczbę nieprzejrzanych faktur na ikonie w pasku przeglądarki
- Wyświetla listę nowych faktur z nazwą wystawcy, numerem i kwotą
- Wysyła powiadomienie push gdy przyjdzie nowa faktura (opcjonalnie)
- Działa na środowiskach **Produkcja**, **Demo (TR)** i **Test (TE)**

---

## Wymagania

- Przeglądarka Chrome, Edge lub Brave (wersja 88+)
- Token KSeF z uprawnieniem **„przeglądanie faktur"** – wygenerujesz go w [portalu KSeF](https://ksef.podatki.gov.pl) w zakładce *Zarządzaj tokenami*

---

## Instalacja

### Ze sklepu Chrome Web Store

Kliknij **Dodaj do Chrome** na [stronie rozszerzenia](https://chrome.google.com/webstore/detail/ksef-monitor) *(wkrótce)*.

### Ręcznie (tryb deweloperski)

1. Pobierz i rozpakuj archiwum ZIP z rozszerzeniem
2. Otwórz `chrome://extensions` w przeglądarce
3. Włącz **Tryb dewelopera** (przełącznik w prawym górnym rogu)
4. Kliknij **Załaduj rozpakowane** i wskaż folder `extension/`
5. Ikona KSeF Monitor pojawi się w pasku – kliknij ją i przejdź przez konfigurację

---

## Pierwsze uruchomienie

Po kliknięciu ikony pojawi się kreator w 3 krokach:

**Krok 1 – Token i środowisko**
Wklej token KSeF skopiowany z portalu. NIP i nazwa firmy zostaną odczytane automatycznie.

**Krok 2 – PIN**
Ustaw PIN – to hasło, którym rozszerzenie szyfruje token lokalnie. Zapamiętaj go, bo będzie potrzebny przy ponownym logowaniu.

**Krok 3 – Test połączenia**
Rozszerzenie sprawdza czy token działa i pobiera listę ostatnich faktur jako punkt wyjścia.

<img src="store/screenshots/screenshot-3.png" width="900" alt="Konfiguracja zakończona – KSeF Monitor aktywny">

---

## Codzienne użycie

<img src="store/screenshots/screenshot-1.png" width="900" alt="Lista faktur w KSeF Monitor">

**Ikona w pasku** pokazuje liczbę faktur wymagających uwagi. Kliknij ją by otworzyć listę.

**Lista faktur** jest podzielona na dwie sekcje:
- **Nowe** – faktury młodsze niż wybrany próg, pogrubione
- **Wcześniejsze** – starsze faktury zachowane jako kontekst

**Akcje na fakturze:**
- `✓` – oznacz jako przejrzaną (znika z licznika)
- `★` – przenieś z powrotem do nowych
- `✕` – ukryj z listy
- `↗` – otwórz portal KSeF

Po oznaczeniu możesz cofnąć akcję przez **Cofnij** (masz 4 sekundy).

**Sprawdź teraz** – wymusza natychmiastowe pobranie faktur poza harmonogramem.

---

## Ustawienia

Otwórz rozszerzenie → ikona ⚙️ w prawym górnym rogu.

<img src="store/screenshots/screenshot-2.png" width="900" alt="Konfiguracja KSeF Monitor – token i środowisko">

| Ustawienie | Opis |
|---|---|
| Interwał sprawdzania | Co ile godzin rozszerzenie odpytuje KSeF (min. 1h) |
| Nowe przez ostatnie | Faktury młodsze niż X dni trafiają do sekcji „Nowe" |
| Środowisko KSeF | Produkcja / Demo / Test |
| Powiadomienia push | Czy pokazywać powiadomienie systemowe przy nowej fakturze |
| Odśwież archiwum | Pobiera faktury od nowa (np. po przerwie) |
| Usuń token | Usuwa konfigurację i wraca do ekranu startowego |

---

## Bezpieczeństwo

<img src="store/screenshots/screenshot-4.png" width="900" alt="Bezpieczeństwo – dane zostają na Twoim komputerze">

Token KSeF jest **szyfrowany lokalnie** algorytmem AES-256-GCM. Klucz szyfrowania pochodzi z Twojego PIN-u – rozszerzenie nigdy go nie przechowuje. Bez znajomości PIN-u zaszyfrowany token jest bezużyteczny.

Rozszerzenie komunikuje się wyłącznie z `api.ksef.mf.gov.pl` (i odpowiednikami środowisk demo/test). Żadne dane nie są wysyłane do zewnętrznych serwerów.

---

## Często zadawane pytania

**Czy muszę być cały czas zalogowany do portalu KSeF?**
Nie. Rozszerzenie loguje się samodzielnie używając tokenu i utrzymuje sesję przez ~24 godziny. Po wygaśnięciu poprosi o ponowne wpisanie PIN-u.

**Dlaczego nie widzę faktur starszych niż X dni?**
Rozszerzenie pokazuje faktury od momentu instalacji. Starsze dostępne są bezpośrednio w portalu KSeF.

**Zmieniłem PIN w portalu KSeF / wygenerowano nowy token. Co robię?**
Wejdź w ustawienia → *Usuń token*, a następnie przejdź przez konfigurację od nowa z nowym tokenem.

**Co to jest PRD / TR / TE na ikonie?**
Skrót aktualnego środowiska: PRD = Produkcja, TR = Demo, TE = Test.

**Czy rozszerzenie działa na Firefoksie?**
Jeszcze nie – Firefox będzie obsługiwany w kolejnej wersji.

---

## Zgłaszanie błędów

Jeśli coś nie działa, przed zgłoszeniem sprawdź **Logi błędów** (link w stopce rozszerzenia) – tam znajdziesz szczegóły ostatnich błędów komunikacji z KSeF.

Zgłoszenia przyjmujemy przez [Issues na GitHubie](https://github.com/olaf-wilkosz/ksef-monitor/issues) lub e-mailem na [ksef-monitor@pm.me](mailto:ksef-monitor@pm.me).

---

## Prywatność

Rozszerzenie nie zbiera żadnych danych analitycznych. Wszystkie dane (token, faktury, konfiguracja) przechowywane są wyłącznie lokalnie w przeglądarce i nie są nigdzie przesyłane poza KSeF API Ministerstwa Finansów.

Pełna [polityka prywatności](store/privacy-policy.html).
