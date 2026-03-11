/**
 * onboarding.js – KSeF Monitor v0.8
 * 3-krokowy onboarding: token+NIP → test+PIN → pobieranie
 */

import { encryptToken } from './crypto-utils.js';

const pendingConfig = {
	nip: null,
	companyName: null,
	environment: 'production',
	pollIntervalMinutes: 60,
	ksefToken: '',
	pin: '',
};

const PROGRESS = { 1: 20, 2: 60, 3: 100, final: 100 };

// ── Nawigacja ─────────────────────────────────────────────────────────────────

function goToStep(step) {
	document.querySelectorAll('.step-page').forEach((p) => p.classList.remove('active'));
	const id = step === 'final' ? 'stepFinal' : 'step' + step;
	document.getElementById(id).classList.add('active');
	document.getElementById('progress').style.width = (PROGRESS[step] || 0) + '%';
	window.scrollTo({ top: 0, behavior: 'smooth' });

	// Wracając do kroku 1 – zwiń collapsibles żeby Dalej był widoczny
	if (step === 1) {
		['bodyHowTo', 'bodyAdvanced'].forEach((id) => {
			document.getElementById(id)?.classList.remove('open');
		});
		['arrowHowTo', 'arrowAdvanced'].forEach((id) => {
			document.getElementById(id)?.classList.remove('open');
		});
	}

	// Auto-focus
	const focusMap = { 1: 'inputToken', 4: 'pinBox0' };
	const targetId = focusMap[step];
	if (targetId) requestAnimationFrame(() => document.getElementById(targetId)?.focus());
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
	// Focus od razu na pole tokenu
	requestAnimationFrame(() => document.getElementById('inputToken')?.focus());

	// Collapsibles
	bindCollapsible('btnHowTo', 'bodyHowTo', 'arrowHowTo');
	bindCollapsible('btnAdvanced', 'bodyAdvanced', 'arrowAdvanced');

	// Środowisko
	['optProd', 'optDemo', 'optTest'].forEach((id) => {
		document.getElementById(id).addEventListener('click', function () {
			document.querySelectorAll('.radio-option').forEach((o) => o.classList.remove('selected'));
			this.classList.add('selected');
			pendingConfig.environment = this.querySelector('input').value;
		});
	});

	// Token: ekstrakcja NIP live
	document.getElementById('inputToken').addEventListener('input', function () {
		const btn1 = document.getElementById('btn1Next');
		const nipInput = document.getElementById('inputNip');
		const nipError = document.getElementById('nipError');
		const token = this.value.trim();

		const match = token.match(/\|nip-(\d{10})\|/);
		if (match) {
			pendingConfig.nip = match[1];
			pendingConfig.companyName = null;
			nipInput.value = match[1];
			nipInput.style.color = '#013f71';
			nipInput.style.background = '#edf2f7';
			nipInput.style.borderColor = '#b0c8e0';
			nipError.textContent = '';

			const dateMatch = token.match(/^(\d{4})(\d{2})(\d{2})/);
			const tokenDateEl = document.getElementById('tokenDate');
			if (dateMatch) {
				tokenDateEl.textContent = `Wygenerowano: ${dateMatch[3]}.${dateMatch[2]}.${dateMatch[1]}`;
				tokenDateEl.style.opacity = '1';
			}

			if (btn1) btn1.disabled = false;
			lookupCompanyName(match[1]);
		} else {
			pendingConfig.nip = null;
			pendingConfig.companyName = null;
			nipInput.value = '';
			document.getElementById('tokenDate').textContent = '';
			document.getElementById('tokenDate').style.opacity = '0';
			nipInput.style.color = '#aaa';
			nipInput.style.background = 'transparent';
			nipInput.style.borderColor = 'transparent';
			setCompanyBadge(null);
			if (token.length >= 20) {
				nipError.textContent = 'Token nie zawiera NIPu – sprawdź czy token pochodzi z portalu KSeF';
				if (btn1) btn1.disabled = true;
			} else {
				nipError.textContent = '';
				if (btn1) btn1.disabled = token.length < 10;
			}
		}
	});

	// inputNip jest readonly – blur listener niepotrzebny

	// Krok 1 → 2
	document.getElementById('btn1Next').addEventListener('click', validateStep1);

	// Krok 2: wstecz, retry, potwierdź PIN
	document.getElementById('btn2Back').addEventListener('click', () => goToStep(1));
	document.getElementById('btnRetryTest').addEventListener('click', () => {
		try {
			chrome.runtime.sendMessage({ type: 'CLEAR_BACKOFF' });
		} catch {}
		resetTestUI();
		runTokenTest();
	});
	document.getElementById('btnConfirmPin').addEventListener('click', confirmPin);

	// OTP boxes – auto-advance, backspace, cyfry only
	initOtpBoxes();

	// Toggle podglądu PIN
	document.getElementById('pinToggle').addEventListener('click', () => {
		const boxes = otpBoxes();
		const isHidden = boxes[0].type === 'password';
		boxes.forEach((b) => (b.type = isHidden ? 'text' : 'password'));
		document.getElementById('pinToggle').style.color = isHidden ? '#1565c0' : '#aaa';
	});

	// Krok 3 → final
	document.getElementById('btnClose').addEventListener('click', () => window.close());
});

// ── Collapsible ───────────────────────────────────────────────────────────────

function bindCollapsible(triggerId, bodyId, arrowId) {
	document.getElementById(triggerId).addEventListener('click', () => {
		const body = document.getElementById(bodyId);
		const arrow = document.getElementById(arrowId);
		const open = body.classList.toggle('open');
		arrow.classList.toggle('open', open);
	});
}

// ── NIP lookup (Biała Lista MF) ───────────────────────────────────────────────

async function lookupCompanyName(nip) {
	setCompanyBadge('loading');
	try {
		const date = new Date().toISOString().slice(0, 10);
		const res = await fetch(`https://wl-api.mf.gov.pl/api/search/nip/${nip}?date=${date}`, {
			headers: { Accept: 'application/json' },
		});
		if (!res.ok) {
			setCompanyBadge(null);
			return;
		}
		const data = await res.json();
		const name = data?.result?.subject?.name ?? null;
		pendingConfig.companyName = name;
		setCompanyBadge(name);
	} catch {
		// Biała Lista niedostępna – nie blokujemy, cicho ignorujemy
		setCompanyBadge(null);
	}
}

function setCompanyBadge(state) {
	const el = document.getElementById('companyBadge');
	if (!el) return;
	if (state === 'loading') {
		el.textContent = '⏳ Sprawdzam...';
		el.style.color = '#aaa';
		el.style.borderColor = 'transparent';
		el.style.background = 'transparent';
		el.style.fontStyle = 'italic';
	} else if (state) {
		el.textContent = state;
		el.style.color = '#444';
		el.style.borderColor = '#dde0ea';
		el.style.background = '#fafbff';
		el.style.fontStyle = 'normal';
	} else {
		el.textContent = '';
		el.style.borderColor = 'transparent';
		el.style.background = 'transparent';
	}
}

// ── Walidacja kroku 1 ─────────────────────────────────────────────────────────

function validateStep1() {
	let valid = true;

	const token = document.getElementById('inputToken').value.trim();
	document.getElementById('tokenError').textContent = '';
	if (!token || token.length < 20) {
		document.getElementById('tokenError').textContent = 'Wklej pełny token KSeF (co najmniej 20 znaków)';
		valid = false;
	} else {
		pendingConfig.ksefToken = token;
	}

	// NIP jest zawsze wyciągany z tokenu – jeśli brak, token jest nieprawidłowy
	if (!pendingConfig.nip) {
		document.getElementById('nipError').textContent =
			'Token nie zawiera NIPu – wklej token wygenerowany w portalu KSeF';
		valid = false;
	}

	pendingConfig.pollIntervalMinutes = parseInt(document.getElementById('inputInterval').value, 10) || 60;

	if (valid) {
		goToStep(2);
		resetTestUI();
		runTokenTest();
	}
}

// ── Test tokenu ───────────────────────────────────────────────────────────────

function resetTestUI() {
	const backBtn = document.getElementById('btn2Back');
	if (backBtn) backBtn.style.display = '';
	setPanel('testPanel', 'loading', 'Łączę z KSeF API...', '');
	setIcon('iconKey', '⏳');
	setIcon('iconAuth', '⏳');
	document.getElementById('hintsBox').style.display = 'none';
	document.getElementById('hintsList').innerHTML = '';
	document.getElementById('btnRetryTest').style.display = 'none';
	document.getElementById('btnConfirmPin').style.display = 'none';
	// Ukryj PIN sekcję
	document.getElementById('pinSection').classList.remove('visible');
}

async function runTokenTest() {
	const envUrls = {
		production: 'https://api.ksef.mf.gov.pl/v2',
		demo: 'https://api-demo.ksef.mf.gov.pl/v2',
		test: 'https://api-test.ksef.mf.gov.pl/v2',
	};
	const baseUrl = envUrls[pendingConfig.environment] || envUrls.production;

	// ── Krok 1: sieć / klucz publiczny ──────────────────────────────────────
	setPanel('testPanel', 'loading', 'Pobieranie klucza publicznego MF...', '');
	try {
		const probe = await fetch(baseUrl + '/security/public-key-certificates', {
			method: 'GET',
			headers: { Accept: 'application/json' },
		});
		if (!probe.ok) {
			setIcon('iconKey', '❌');
			showError(`Serwer KSeF zwrócił HTTP ${probe.status}`, `URL: ${baseUrl}/security/public-key-certificates`, [
				'Sprawdź czy wybrane środowisko zgadza się z tokenem',
				'Serwery KSeF mogą być chwilowo niedostępne – sprawdź ksef.podatki.gov.pl',
			]);
			return;
		}
	} catch (err) {
		setIcon('iconKey', '❌');
		showError('Brak połączenia z KSeF', 'Sprawdź połączenie internetowe lub status serwisów MF.', [
			'Sprawdź połączenie internetowe',
			'Status serwisów: ksef.podatki.gov.pl',
		]);
		return;
	}
	setIcon('iconKey', '✅');

	// ── Krok 2: autoryzacja tokenem ──────────────────────────────────────────
	setPanel('testPanel', 'loading', 'Weryfikuję token...', 'Autoryzacja RSA-OAEP → JWT');
	try {
		const response = await chrome.runtime.sendMessage({
			type: 'TEST_TOKEN_PLAIN',
			token: pendingConfig.ksefToken,
			nip: pendingConfig.nip,
			environment: pendingConfig.environment,
		});

		if (response?.ok) {
			setIcon('iconAuth', '✅');
			onTokenTestSuccess();
		} else {
			setIcon('iconAuth', '❌');
			const msg = response?.error || 'Błąd autoryzacji';
			const is450 = response?.code === 'AUTH_FAILED_450';
			if (is450) {
				showError(
					'Token unieważniony lub wygasły',
					'Wróć i wklej nowy token wygenerowany w portalu KSeF.',
					['Token został unieważniony w portalu KSeF', 'Tokeny wygasają 31.12.2026 – sprawdź datę ważności'],
					'back'
				);
			} else {
				showError(
					'Autoryzacja nieudana',
					msg,
					[
						"Upewnij się, że token ma uprawnienie 'przeglądanie faktur'",
						'Sprawdź czy NIP odpowiada właścicielowi tokenu',
						'Token produkcyjny działa od 1.02.2026 (duże podmioty) lub 1.04.2026 (pozostałe)',
						'Sprawdź czy wybrane środowisko zgadza się z tokenem',
					],
					'back'
				);
			}
		}
	} catch (err) {
		setIcon('iconAuth', '❌');
		showError('Błąd komunikacji z rozszerzeniem', err.message, [
			'Spróbuj ponownie – to może być chwilowy błąd service workera',
		]);
	}
}

function onTokenTestSuccess() {
	setPanel('testPanel', 'success', '✅ Token zweryfikowany!', 'Możesz teraz ustawić PIN.');

	// Aktualizuj nagłówek kroku
	document.getElementById('step2title').textContent = '🔒 Ustaw PIN';
	document.getElementById('step2subtitle').textContent = 'Token OK – zabezpiecz go PIN-em';
	document.getElementById('step2indicator').textContent = 'Krok 2 z 3';

	// Pokaż sekcję PIN
	const pinSection = document.getElementById('pinSection');
	pinSection.classList.add('visible');
	// Focus na pierwszy PIN po animacji
	setTimeout(() => document.getElementById('pinBox0').focus(), 350);

	document.getElementById('btnConfirmPin').style.display = 'inline-flex';
}

function showError(title, detail, hints, mode = 'retry') {
	// mode: "retry" = błąd sieci/serwera → Spróbuj ponownie + Wstecz widoczny
	//       "back"  = zły token/450/auth  → tylko Zmień token (Wstecz zbędny)
	setPanel('testPanel', 'error', title, detail);
	if (hints?.length) {
		const list = document.getElementById('hintsList');
		list.innerHTML = hints.map((h) => `<li>${h}</li>`).join('');
		document.getElementById('hintsBox').style.display = 'block';
	}
	const retryBtn = document.getElementById('btnRetryTest');
	const backBtn = document.getElementById('btn2Back');
	if (mode === 'back') {
		retryBtn.textContent = '← Zmień token';
		retryBtn.onclick = () => goToStep(1);
		if (backBtn) backBtn.style.display = 'none'; // duplikat – chowamy
	} else {
		retryBtn.textContent = '🔄 Spróbuj ponownie';
		retryBtn.onclick = null;
		if (backBtn) backBtn.style.display = ''; // przywróć
	}
	retryBtn.style.display = 'inline-flex';
}

// ── OTP PIN boxes ─────────────────────────────────────────────────────────────

function otpBoxes() {
	return [0, 1, 2, 3].map((i) => document.getElementById('pinBox' + i));
}

function initOtpBoxes() {
	const boxes = otpBoxes();
	boxes.forEach((box, i) => {
		box.addEventListener('keydown', (e) => {
			if (e.key === 'Backspace') {
				if (box.value) {
					box.value = '';
					box.classList.remove('filled');
				} else if (i > 0) {
					boxes[i - 1].focus();
					boxes[i - 1].value = '';
					boxes[i - 1].classList.remove('filled');
				}
				e.preventDefault();
			} else if (e.key === 'ArrowLeft' && i > 0) {
				boxes[i - 1].focus();
			} else if (e.key === 'ArrowRight' && i < 3) {
				boxes[i + 1].focus();
			} else if (e.key === 'Enter') {
				confirmPin();
			}
		});
		box.addEventListener('input', (e) => {
			const val = e.data?.replace(/\D/g, '') ?? '';
			box.value = val ? val[val.length - 1] : '';
			if (box.value) {
				box.classList.add('filled');
				if (i < 3) boxes[i + 1].focus();
				else confirmPin(); // auto-submit po 4. cyfrze
			} else {
				box.classList.remove('filled');
			}
		});
		box.addEventListener('focus', () => box.select());
		// Wklej cały PIN naraz
		box.addEventListener('paste', (e) => {
			e.preventDefault();
			const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, 4);
			boxes.forEach((b, j) => {
				b.value = digits[j] || '';
				b.classList.toggle('filled', !!b.value);
			});
			const next = Math.min(digits.length, 3);
			boxes[next].focus();
			if (digits.length === 4) confirmPin();
		});
	});
}

// ── PIN confirm → szyfrowanie ─────────────────────────────────────────────────

async function confirmPin() {
	const errEl = document.getElementById('pinError');
	errEl.textContent = '';

	const pin = otpBoxes()
		.map((b) => b.value)
		.join('');
	if (pin.length < 4) {
		errEl.textContent = 'Wpisz 4-cyfrowy PIN';
		return;
	}
	if (!/^\d{4}$/.test(pin)) {
		errEl.textContent = 'PIN musi składać się z cyfr';
		return;
	}

	pendingConfig.pin = pin;

	const btn = document.getElementById('btnConfirmPin');
	btn.disabled = true;
	btn.innerHTML = '<div class="spinner spinner-white"></div> Szyfrowanie...';

	try {
		const encrypted = await encryptToken(pendingConfig.ksefToken, pendingConfig.pin);
		await chrome.storage.local.set({
			encryptedToken: encrypted,
			config: {
				nip: pendingConfig.nip,
				companyName: pendingConfig.companyName ?? null,
				environment: pendingConfig.environment,
				pollIntervalMinutes: pendingConfig.pollIntervalMinutes,
				pendingDaysThreshold: 'month',
				notificationsEnabled: false,
			},
		});
		pendingConfig.ksefToken = ''; // wymaż plain text z pamięci

		goToStep(3);
		await runFetchInvoices();
	} catch (err) {
		errEl.textContent = 'Błąd szyfrowania: ' + err.message;
	} finally {
		btn.disabled = false;
		btn.textContent = 'Szyfruj i dalej →';
	}
}

// ── Krok 3: Pobieranie faktur ─────────────────────────────────────────────────

async function runFetchInvoices() {
	setPanel('fetchPanel', 'loading', 'Pobieram faktury...', 'Archiwum z bieżącego miesiąca');

	try {
		const response = await chrome.runtime.sendMessage({
			type: 'SETUP_TOKEN',
			pin: pendingConfig.pin,
		});
		pendingConfig.pin = '';

		if (response?.ok) {
			const count = response.invoiceCount ?? 0;
			setPanel(
				'fetchPanel',
				'success',
				`Pobrano ${count} ${pluralFaktury(count)}.`,
				count > 0 ? `${count} nieprzejrzanych z bieżącego miesiąca.` : 'Brak faktur z bieżącego miesiąca.'
			);
			await chrome.runtime.sendMessage({
				type: 'UPDATE_INTERVAL',
				minutes: pendingConfig.pollIntervalMinutes,
			});
		} else {
			// Błąd pobierania NIE blokuje – rozszerzenie jest już skonfigurowane
			setPanel(
				'fetchPanel',
				'error',
				'Nie udało się pobrać faktur',
				(response?.error || 'Nieznany błąd') +
					'\n\nRozszerzenie zostało skonfigurowane. Użyj Odśwież archiwum w ustawieniach kiedy będziesz gotowy.'
			);
		}
	} catch (err) {
		setPanel(
			'fetchPanel',
			'error',
			'Błąd połączenia',
			'Rozszerzenie zostało skonfigurowane. Spróbuj odświeżyć archiwum z poziomu ustawień.'
		);
	}

	// Pokaż podsumowanie końcowe i przycisk Zamknij
	const summary = document.getElementById('finalSummary');
	if (summary) summary.style.display = 'block';
	document.getElementById('step3title').textContent = '🎉 KSeF Monitor aktywny!';
	document.getElementById('step3subtitle').textContent = 'Rozszerzenie jest gotowe do pracy.';
	document.getElementById('finalInterval').textContent = pendingConfig.pollIntervalMinutes;
	document.getElementById('finalInterval2').textContent = pendingConfig.pollIntervalMinutes;
	document.getElementById('btnClose').style.display = 'inline-flex';
	document.getElementById('toolbarHint').style.display = 'block';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setPanel(panelId, type, title, detail) {
	const panel = document.getElementById(panelId);
	panel.className = 'status-panel ' + type;

	const iconEl = panel.querySelector('.status-icon');
	if (type === 'loading') {
		iconEl.innerHTML = '<div class="spinner"></div>';
	} else if (type === 'success') {
		iconEl.textContent = '✅';
	} else {
		iconEl.textContent = '❌';
	}

	const titleId = panelId === 'testPanel' ? 'testTitle' : 'fetchTitle';
	const detailId = panelId === 'testPanel' ? 'testDetail' : 'fetchDetail';
	document.getElementById(titleId).textContent = title;
	document.getElementById(detailId).textContent = detail;
	document.getElementById(detailId).style.whiteSpace = 'pre-line';
}

function setIcon(id, icon) {
	const el = document.getElementById(id);
	if (el) el.textContent = icon;
}

function pluralFaktury(n) {
	if (n === 1) return 'fakturę';
	if (n >= 2 && n <= 4) return 'faktury';
	return 'faktur';
}
