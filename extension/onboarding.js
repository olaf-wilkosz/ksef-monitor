/**
 * onboarding.js – KSeF Monitor
 * 3-krokowy onboarding: token+NIP → test+PIN → pobieranie
 *
 * Tryby:
 *   ?mode=add  – dodawanie kolejnego NIP-a (weryfikacja istniejącego PIN-u)
 *   (brak)     – pierwsze uruchomienie (ustawienie nowego PIN-u)
 */

import { encryptToken } from './crypto-utils.js';

const isAddMode = new URLSearchParams(window.location.search).get('mode') === 'add';

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

	if (step === 1) {
		['bodyHowTo', 'bodyAdvanced'].forEach((id) => {
			document.getElementById(id)?.classList.remove('open');
		});
		['arrowHowTo', 'arrowAdvanced'].forEach((id) => {
			document.getElementById(id)?.classList.remove('open');
		});
	}

	const focusMap = { 1: 'inputToken', 2: 'pinBox0' };
	const targetId = focusMap[step];
	if (targetId) requestAnimationFrame(() => document.getElementById(targetId)?.focus());
}

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
	// Tryb add: dostosuj nagłówki i etykiety PIN
	if (isAddMode) {
		applyAddModeUI();
	}

	requestAnimationFrame(() => document.getElementById('inputToken')?.focus());

	// Collapsibles
	bindCollapsible('btnHowTo', 'bodyHowTo', 'arrowHowTo');
	bindCollapsible('btnAdvanced', 'bodyAdvanced', 'arrowAdvanced');

	// Token: ekstrakcja NIP live
	document.getElementById('inputToken').addEventListener('input', function () {
		const btn1 = document.getElementById('btn1Next');
		const nipInput = document.getElementById('inputNip');
		const nipError = document.getElementById('nipError');
		const token = this.value.trim();

		const progressEl = document.getElementById('progress');
		if (progressEl) {
			progressEl.style.width = token.length >= 20 ? '30%' : '20%';
		}

		const TOKEN_RE =
			/^(\d{4})(\d{2})(\d{2})-[A-Z0-9]{2}-[A-F0-9]{10}-[A-F0-9]{10}-[A-Z0-9]{2}\|nip-(\d{10})\|[a-f0-9]+$/;
		const match = token.match(TOKEN_RE);
		if (match) {
			pendingConfig.nip = match[4];
			pendingConfig.companyName = null;
			nipInput.value = match[4];
			nipInput.style.color = '#013f71';
			nipInput.style.background = '#edf2f7';
			nipInput.style.borderColor = '#b0c8e0';
			nipError.textContent = '';

			const tokenDateEl = document.getElementById('tokenDate');
			tokenDateEl.textContent = `Token wygenerowany: ${match[3]}.${match[2]}.${match[1]}`;
			tokenDateEl.style.opacity = '1';

			if (btn1) btn1.disabled = false;
			lookupCompanyName(match[4]);
		} else {
			pendingConfig.nip = null;
			pendingConfig.companyName = null;
			nipInput.value = '';
			document.getElementById('tokenDate').textContent = '';
			document.getElementById('tokenDate').style.opacity = '0';
			nipInput.style.color = '#aaa';
			nipInput.style.background = 'transparent';
			nipInput.style.borderColor = 'transparent';
			const wrap = document.getElementById('companyBadgeWrap');
			if (wrap) wrap.style.visibility = 'hidden';
			document.getElementById('companyBadge').value = '';
			if (token.length >= 20) {
				nipError.textContent = /\|nip-\d{10}\|/.test(token)
					? 'Nieprawidłowy format tokenu – sprawdź czy skopiowałeś go w całości'
					: 'Token nie zawiera NIPu – sprawdź czy token pochodzi z portalu KSeF';
				if (btn1) btn1.disabled = true;
			} else {
				nipError.textContent = '';
				if (btn1) btn1.disabled = token.length < 10;
			}
		}
	});

	// Edycja nazwy firmy
	document.getElementById('companyEditHint').addEventListener('click', function () {
		const el = document.getElementById('companyBadge');
		if (!el.readOnly) {
			pendingConfig.companyName = el.value.trim() || null;
			el.readOnly = true;
			el.style.cursor = 'default';
			this.textContent = '✏️';
		} else {
			el.readOnly = false;
			el.style.cursor = 'text';
			el.focus();
			el.select();
			this.textContent = '✓';
		}
	});
	document.getElementById('companyEditHint').addEventListener('keydown', function (e) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			this.click();
		}
	});
	document.getElementById('companyBadge').addEventListener('keydown', function (e) {
		if (e.key === 'Enter') {
			e.preventDefault();
			pendingConfig.companyName = this.value.trim() || null;
			this.readOnly = true;
			this.style.cursor = 'default';
			const hint = document.getElementById('companyEditHint');
			if (hint) hint.textContent = '✏️';
		}
	});
	document.getElementById('companyBadge').addEventListener('input', function () {
		if (!this.readOnly) pendingConfig.companyName = this.value.trim() || null;
	});

	// Nawigacja
	document.getElementById('btn1Next').addEventListener('click', validateStep1);
	document.getElementById('btn2Back').addEventListener('click', () => goToStep(1));
	document.getElementById('btnRetryTest').addEventListener('click', () => {
		try {
			chrome.runtime.sendMessage({ type: 'CLEAR_BACKOFF' });
		} catch {}
		resetTestUI();
		runTokenTest();
	});
	document.getElementById('btnConfirmPin').addEventListener('click', confirmPin);

	// OTP boxes
	initOtpBoxes();

	// Toggle powiadomień
	document.addEventListener('change', (e) => {
		if (e.target.id === 'toggleNotificationsOnboarding') {
			const on = e.target.checked;
			document.getElementById('notifSlider').style.background = on ? '#013f71' : '#ccc';
			document.getElementById('notifThumb').style.transform = on ? 'translateX(18px)' : '';
		}
	});

	// Toggle podglądu PIN
	document.getElementById('pinToggle').addEventListener('click', () => {
		const toggle = document.getElementById('pinToggle');
		const boxes = otpBoxes();
		const isHidden = boxes[0].type === 'password';
		boxes.forEach((b) => (b.type = isHidden ? 'text' : 'password'));
		toggle.style.color = isHidden ? '#1565c0' : '#aaa';
		toggle.setAttribute('aria-pressed', isHidden ? 'true' : 'false');
		toggle.setAttribute('aria-label', isHidden ? 'Ukryj PIN' : 'Pokaż PIN');
	});

	// Zamknij / dodaj kolejny NIP
	document.getElementById('btnClose').addEventListener('click', async () => {
		const notifEnabled = document.getElementById('toggleNotificationsOnboarding')?.checked ?? false;
		if (notifEnabled) {
			const result = await chrome.storage.local.get('config');
			const cfg = result.config ?? {};
			cfg.notificationsEnabled = true;
			await chrome.storage.local.set({ config: cfg });
		}
		window.close();
	});

	document.getElementById('btnAddAnother')?.addEventListener('click', () => {
		chrome.runtime.sendMessage({ type: 'OPEN_ONBOARDING', mode: 'add' });
		window.close();
	});
});

// ── Tryb add: dostosowanie UI ─────────────────────────────────────────────────

function applyAddModeUI() {
	// Nagłówek kroku 1
	const title1 = document.getElementById('step1title');
	if (title1) title1.textContent = 'Dodaj kolejny NIP';
	const sub1 = document.getElementById('step1subtitle');
	if (sub1) sub1.textContent = 'Wklej token KSeF dla nowej działalności';

	// Etykieta PIN – zamiast "Ustaw PIN" pokazujemy "Potwierdź PIN"
	// (etykieta aktualizowana dynamicznie w onTokenTestSuccess)
}

// ── Collapsible ───────────────────────────────────────────────────────────────

function bindCollapsible(triggerId, bodyId, arrowId) {
	const trigger = document.getElementById(triggerId);
	trigger.addEventListener('click', () => {
		const body = document.getElementById(bodyId);
		const arrow = document.getElementById(arrowId);
		const open = body.classList.toggle('open');
		arrow.classList.toggle('open', open);
		trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
		if (open) body.removeAttribute('inert');
		else body.setAttribute('inert', '');
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
		setCompanyBadge(null);
	}
}

function setCompanyBadge(state) {
	const el = document.getElementById('companyBadge');
	const hint = document.getElementById('companyEditHint');
	const wrap = document.getElementById('companyBadgeWrap');
	if (!el) return;
	if (state === 'loading') {
		if (wrap) wrap.style.visibility = 'hidden';
	} else if (state) {
		el.value = state;
		el.readOnly = true;
		el.style.cursor = 'default';
		if (hint) hint.textContent = '✏️';
		if (wrap) wrap.style.visibility = 'visible';
	} else {
		el.value = '';
		el.placeholder = 'Nazwa firmy (opcjonalnie)';
		el.readOnly = false;
		el.style.cursor = 'text';
		if (hint) hint.textContent = '✓';
		if (wrap) wrap.style.visibility = 'visible';
	}
}

// ── Walidacja kroku 1 ─────────────────────────────────────────────────────────

function validateStep1() {
	let valid = true;

	const token = document.getElementById('inputToken').value.trim();
	document.getElementById('tokenError').textContent = '';
	const TOKEN_RE = /^\d{8}-[A-Z0-9]{2}-[A-F0-9]{10}-[A-F0-9]{10}-[A-Z0-9]{2}\|nip-\d{10}\|[a-f0-9]+$/;
	const NIP_PRESENT_RE = /\|nip-\d{10}\|/;

	if (!token) {
		document.getElementById('tokenError').textContent = 'Wklej token KSeF z portalu podatki.gov.pl';
		valid = false;
	} else if (!TOKEN_RE.test(token)) {
		document.getElementById('tokenError').textContent = NIP_PRESENT_RE.test(token)
			? 'Token jest niekompletny – skopiuj go w całości z portalu KSeF'
			: 'Token nie zawiera NIPu – wklej token wygenerowany w portalu KSeF';
		valid = false;
	} else {
		pendingConfig.ksefToken = token;
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
	document.getElementById('pinSection').classList.remove('visible');
}

async function runTokenTest() {
	const envUrls = {
		production: 'https://api.ksef.mf.gov.pl/v2',
		demo: 'https://api-demo.ksef.mf.gov.pl/v2',
		test: 'https://api-test.ksef.mf.gov.pl/v2',
	};
	const baseUrl = envUrls[pendingConfig.environment] || envUrls.production;

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
	} catch {
		setIcon('iconKey', '❌');
		showError('Brak połączenia z KSeF', 'Sprawdź połączenie internetowe lub status serwisów MF.', [
			'Sprawdź połączenie internetowe',
			'Status serwisów: ksef.podatki.gov.pl',
		]);
		return;
	}
	setIcon('iconKey', '✅');

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
					response?.error || 'Błąd autoryzacji',
					[
						'Upewnij się, że token ma uprawnienie "przeglądanie faktur"',
						'Sprawdź czy NIP odpowiada właścicielowi tokenu',
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

	// W trybie add – "Potwierdź PIN", w normalnym – "Ustaw PIN"
	document.getElementById('step2title').textContent = isAddMode ? '🔒 Potwierdź PIN' : '🔒 Ustaw PIN';
	document.getElementById('step2subtitle').textContent = isAddMode
		? 'Wprowadź istniejący PIN aby zaszyfrować nowy token'
		: 'Token OK – zabezpiecz go PIN-em';
	document.getElementById('step2indicator').textContent = 'Krok 2 z 3';
	const pinSectionTitle = document.getElementById('pinSectionTitle');
	if (pinSectionTitle) pinSectionTitle.textContent = isAddMode ? '🔒 Potwierdź PIN' : '🔒 Ustaw PIN';

	const pinSection = document.getElementById('pinSection');
	pinSection.classList.add('visible');
	setTimeout(() => document.getElementById('pinBox0').focus(), 350);
	document.getElementById('btnConfirmPin').style.display = 'inline-flex';
}

function showError(title, detail, hints, mode = 'retry') {
	setPanel('testPanel', 'error', title, detail);
	if (hints?.length) {
		const list = document.getElementById('hintsList');
		list.innerHTML = '';
		hints.forEach((h) => {
			const li = document.createElement('li');
			li.textContent = h;
			list.appendChild(li);
		});
		document.getElementById('hintsBox').style.display = 'block';
	}
	const retryBtn = document.getElementById('btnRetryTest');
	const backBtn = document.getElementById('btn2Back');
	if (mode === 'back') {
		retryBtn.textContent = '← Zmień token';
		retryBtn.onclick = () => goToStep(1);
		if (backBtn) backBtn.style.display = 'none';
	} else {
		retryBtn.textContent = '🔄 Spróbuj ponownie';
		retryBtn.onclick = null;
		if (backBtn) backBtn.style.display = '';
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
				else confirmPin();
			} else {
				box.classList.remove('filled');
			}
		});
		box.addEventListener('focus', () => box.select());
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

	// W trybie add: weryfikuj istniejący PIN przed szyfrowaniem
	if (isAddMode) {
		const verify = await chrome.runtime.sendMessage({ type: 'VERIFY_PIN', pin });
		if (!verify.ok) {
			errEl.textContent = 'Nieprawidłowy PIN – to musi być PIN który ustawiłeś przy pierwszym NIP-ie';
			otpBoxes().forEach((b) => {
				b.value = '';
				b.classList.remove('filled');
			});
			otpBoxes()[0].focus();
			return;
		}
	}

	pendingConfig.pin = pin;

	const btn = document.getElementById('btnConfirmPin');
	btn.disabled = true;
	btn.innerHTML = '<div class="spinner spinner-white"></div> Szyfrowanie...';

	try {
		const encrypted = await encryptToken(pendingConfig.ksefToken, pendingConfig.pin);
		pendingConfig.ksefToken = ''; // wymaż plain text z pamięci

		// Wyślij ADD_ACCOUNT do background – dodaje konto i ustawia alarm
		const addResponse = await chrome.runtime.sendMessage({
			type: 'ADD_ACCOUNT',
			nip: pendingConfig.nip,
			encryptedToken: encrypted,
			companyName: pendingConfig.companyName ?? null,
			environment: pendingConfig.environment,
		});

		if (!addResponse?.ok) {
			errEl.textContent = addResponse?.error ?? 'Nie udało się dodać konta.';
			return;
		}

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
			nip: pendingConfig.nip,
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
			setPanel(
				'fetchPanel',
				'error',
				'Nie udało się pobrać faktur',
				(response?.error || 'Nieznany błąd') +
					'\n\nRozszerzenie zostało skonfigurowane. Użyj Odśwież archiwum w ustawieniach kiedy będziesz gotowy.'
			);
		}
	} catch {
		setPanel(
			'fetchPanel',
			'error',
			'Błąd połączenia',
			'Rozszerzenie zostało skonfigurowane. Spróbuj odświeżyć archiwum z poziomu ustawień.'
		);
	}

	const summary = document.getElementById('finalSummary');
	if (summary) summary.style.display = 'block';
	document.getElementById('step3title').textContent = '🎉 KSeF Monitor aktywny!';
	document.getElementById('step3subtitle').textContent = 'Rozszerzenie jest gotowe do pracy.';
	document.getElementById('finalInterval').textContent = pendingConfig.pollIntervalMinutes;
	document.getElementById('finalInterval2').textContent = pendingConfig.pollIntervalMinutes;
	document.getElementById('btnClose').style.display = 'inline-flex';
	document.getElementById('toolbarHint').style.display = 'block';

	// Pokaż przycisk "Dodaj kolejny NIP"
	const btnAddAnother = document.getElementById('btnAddAnother');
	if (btnAddAnother) btnAddAnother.style.display = 'inline-flex';
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
