# KSeF Monitor

![Wersja](https://img.shields.io/badge/wersja-1.0.0-013f71) ![Licencja](https://img.shields.io/badge/licencja-MIT-green) ![Chrome](https://img.shields.io/badge/Chrome-88%2B-yellow)

Rozszerzenie Chrome, które monitoruje nowe faktury zakupowe w Krajowym Systemie e-Faktur i powiadamia Cię gdy pojawi się coś nowego – bez logowania do portalu.

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
- NIP firmy, do której należy token

---

## Instalacja

### Ze sklepu Chrome Web Store

Kliknij **Dodaj do Chrome** na [stronie rozszerzenia](https://chrome.google.com/webstore/detail/ksef-monitor) *(wkrótce)*.

### Ręcznie (tryb deweloperski)

1. Pobierz i rozpakuj archiwum ZIP z rozszerzeniem
2. Otwórz `chrome://extensions` w przeglądarce
3. Włącz **Tryb dewelopera** (przełącznik w prawym górnym rogu)
4. Kliknij **Załaduj rozpakowane** i wskaż folder z plikami
5. Ikona KSeF Monitor pojawi się w pasku – kliknij ją i przejdź przez konfigurację

---

## Pierwsze uruchomienie

Po kliknięciu ikony pojawi się kreator w 3 krokach:

**Krok 1 – Środowisko i NIP**
Wybierz środowisko KSeF (zazwyczaj *Produkcja*) i wpisz NIP firmy.

**Krok 2 – Token i PIN**
Wklej token KSeF skopiowany z portalu. Ustaw PIN – to hasło, którym rozszerzenie szyfruje token lokalnie. Zapamiętaj go, bo będzie potrzebny przy ponownym logowaniu.

**Krok 3 – Test połączenia**
Rozszerzenie sprawdza czy token działa i pobiera listę ostatnich faktur jako punkt wyjścia. Faktury z ostatnich 7 dni trafią od razu do listy nieprzejrzanych.

---

## Codzienne użycie

**Ikona w pasku** pokazuje liczbę faktur wymagających uwagi. Kliknij ją by otworzyć listę.

**Lista faktur** jest podzielona na dwie sekcje:
- **Nowe** – faktury z ostatnich 7 dni (lub innego okresu wg ustawień), pogrubione
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

Otwórz rozszerzenie → ikona koła zębatego (⚙) w prawym górnym rogu.

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

Token KSeF jest **szyfrowany lokalnie** algorytmem AES-256-GCM. Klucz szyfrowania pochodzi z Twojego PIN-u – rozszerzenie nigdy go nie przechowuje. Bez znajomości PIN-u zaszyfrowany token jest bezużyteczny.

Rozszerzenie komunikuje się wyłącznie z `api.ksef.mf.gov.pl` (i odpowiednikami środowisk demo/test). Żadne dane nie są wysyłane do zewnętrznych serwerów.

---

## Często zadawane pytania

**Czy muszę być cały czas zalogowany do portalu KSeF?**
Nie. Rozszerzenie loguje się samodzielnie używając tokenu i utrzymuje sesję przez ~24 godziny. Po wygaśnięciu poprosi o ponowne wpisanie PIN-u.

**Dlaczego nie widzę faktur starszych niż X dni?**
Rozszerzenie pokazuje faktury od momentu instalacji. Starsze dostępne są bezpośrednio w portalu KSeF.

**Co oznacza „Sprawdzono 04.03, 22:45"?**
Godzina ostatniego udanego połączenia z KSeF. Jeśli jest stara, sprawdź logi błędów (link *Logi błędów* w stopce).

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
