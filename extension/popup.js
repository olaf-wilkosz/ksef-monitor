/**
 * popup.js – logika interfejsu popup
 *
 * Stan faktur:
 *   pendingInvoices  – nowe, nieprzejrzane (czarne, bold, z checkboxem)
 *   recentArchive    – ostatnich 5 przejrzanych (szare, bez checkboxa, punkt wyjścia)
 *
 * FIFO wyświetlania: wszystkie pending + max 5 archive
 * Licznik + badge = pendingInvoices.length
 */

// ─── Stan ─────────────────────────────────────────────────────────────────────

let config = {};
let pollState = {};
let invoiceState = { allSeenIds: [], pendingInvoices: [], recentArchive: [], lastQueryTime: null };

// Toast – timer i aktywne cofnięcie
let toastTimer = null;
let toastInvoiceId = null;
let toastInvoiceType = null; // "pending" | "archive" | "bulk"
let toastBulkSnapshot = null; // snapshot pending[] dla undo "oznacz wszystkie"

// Reaguj na zmiany storage gdy popup jest otwarty
// (np. sesja wygasa podczas gdy popup jest widoczny)
chrome.storage.onChanged.addListener((changes, area) => {
	if (area !== 'local') return;
	if (changes.pollState?.newValue?.needsNewToken) {
		showView('viewNewToken');
	} else if (changes.pollState?.newValue?.needsPin) {
		showView('viewPin');
	}
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
	await loadState();
	determineAndShowView();
	bindEvents();
});

async function loadState() {
	const result = await chrome.storage.local.get([
		'config',
		'authState',
		'pollState',
		'invoiceState',
		'encryptedToken',
	]);
	config = result.config ?? {
		environment: 'production',
		pollIntervalMinutes: 60,
		notificationsEnabled: false,
		companyName: null,
	};
	pollState = result.pollState ?? {};
	invoiceState = migrateInvoiceState(result.invoiceState);

	const labels = { production: 'PRD', demo: 'DEMO', test: 'TEST' };
	document.getElementById('envLabel').textContent = labels[config.environment] ?? 'PRD';
}

/** Migracja starszego schematu – bezpieczna fallback. */
function migrateInvoiceState(raw) {
	if (!raw) return { allSeenIds: [], pendingInvoices: [], recentArchive: [], lastQueryTime: null };
	if (raw.allSeenIds !== undefined) return raw; // v0.3 – OK
	// v0.2.0 / v0.1.x
	return {
		allSeenIds: raw.lastSeenIds ?? [],
		pendingInvoices: raw.pendingInvoices ?? [],
		recentArchive: [],
		lastQueryTime: raw.lastQueryTime ?? null,
	};
}

// ─── Routing ──────────────────────────────────────────────────────────────────

// UI-lock (nie crypto-lock): po 4h bezczynności popup wymaga PIN zanim pokaże dane.
// Background nadal polluje przez refresh token – PIN nie jest weryfikowany kryptograficznie.
// Pełna weryfikacja kryptograficzna następuje dopiero gdy background ustawi needsPin=true
// (wygaśnięcie refresh tokena ~24h). To jest świadoma decyzja projektowa.
const PIN_TIMEOUT_MS = 4 * 60 * 60 * 1000;

function determineAndShowView() {
	chrome.storage.local.get(['encryptedToken', 'authState', 'pollState'], (result) => {
		const hasToken = !!result.encryptedToken;
		const auth = result.authState ?? {};
		const ps = result.pollState ?? {};

		if (!hasToken) {
			showView('viewSetup');
			return;
		}

		if (ps.needsNewToken) {
			showView('viewNewToken');
			return;
		}
		if (ps.needsPin) {
			showView('viewPin');
			return;
		}

		// Nieaktywność > 4h (np. po uśpieniu) → wymagaj PIN zanim pokażemy dane
		const lastSuccess = ps.lastSuccessTime ? new Date(ps.lastSuccessTime).getTime() : 0;
		if (lastSuccess && Date.now() - lastSuccess > PIN_TIMEOUT_MS) {
			showView('viewPin');
			return;
		}

		// accessToken jest w session storage (od v1.0.2) – sprawdzamy tylko refreshToken w local
		const validRefresh = auth.refreshToken && auth.refreshTokenExpiry > Date.now() + 30_000;

		if (!validRefresh && !lastSuccess) {
			showView('viewPin');
			return;
		}

		renderMainView();
		showView('viewMain');
	});
}

function showView(id) {
	document.querySelectorAll('.view').forEach((v) => {
		v.classList.remove('active');
		v.setAttribute('aria-hidden', 'true');
	});
	const activeView = document.getElementById(id);
	activeView?.classList.add('active');
	activeView?.setAttribute('aria-hidden', 'false');

	// Auto-focus – kursor od razu w odpowiednim polu
	const focusMap = {
		viewPin: 'pinBox0',
		viewNewToken: 'newTokenInput',
		viewSettings: 'selectInterval',
	};
	const targetId = focusMap[id];
	if (targetId) {
		// rAF żeby poczekać na display:block zanim focus zadziała
		requestAnimationFrame(() => document.getElementById(targetId)?.focus());
	}
}

// ─── Widok główny ─────────────────────────────────────────────────────────────

function renderMainView() {
	const pending = invoiceState.pendingInvoices ?? [];
	const archive = invoiceState.recentArchive ?? [];
	const count = pending.length;

	// Licznik
	const countEl = document.getElementById('invoiceCount');
	countEl.textContent = count;
	countEl.className = 'counter-num' + (count === 0 ? ' zero' : '');

	document.getElementById('btnMarkAll').classList.toggle('visible', count > 0);

	// Czas ostatniego sprawdzenia
	const qt = pollState.lastSuccessTime;
	document.getElementById('lastCheck').textContent = qt
		? 'Sprawdzono ' +
			new Date(qt).toLocaleString('pl-PL', {
				day: '2-digit',
				month: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			})
		: 'Nigdy nie sprawdzono';

	// Status badge
	renderStatusBadge();

	// Lista faktur
	renderInvoiceList(pending, archive);
}

function renderStatusBadge() {
	const el = document.getElementById('pollStatus');
	el.classList.remove('clickable', 's-ok', 's-warn', 's-err', 's-pin');

	if (pollState.needsPin) {
		el.textContent = 'Wymagany PIN →';
		el.classList.add('s-pin', 'clickable');
		el.onclick = () => showView('viewPin');
	} else if (pollState.backoffUntil && new Date(pollState.backoffUntil) > new Date()) {
		const min = Math.ceil((new Date(pollState.backoffUntil) - Date.now()) / 60000);
		el.textContent = `Backoff (${min} min)`;
		el.classList.add('s-warn');
		el.onclick = null;
	} else if ((pollState.consecutiveErrors ?? 0) > 0) {
		el.textContent = `Błąd (${pollState.consecutiveErrors}×)`;
		el.classList.add('s-err');
		el.onclick = null;
	} else {
		el.textContent = 'OK';
		el.classList.add('s-ok');
		el.onclick = null;
	}
}

// ─── Lista faktur ─────────────────────────────────────────────────────────────

const CHEVRON_SVG = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
  <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

// Persists collapse state across re-renders during the session
const sectionCollapsed = { pending: false, archive: false };

function makeSectionLabel(text, type, bodyEl) {
	const lbl = document.createElement('div');
	lbl.className = `list-section-label${type === 'pending' ? ' pending' : ''}`;
	if (sectionCollapsed[type]) lbl.classList.add('collapsed');

	lbl.innerHTML = `<span>${text}</span><span class="section-chevron">${CHEVRON_SVG}</span>`;

	const toggle = () => {
		sectionCollapsed[type] = !sectionCollapsed[type];
		lbl.classList.toggle('collapsed', sectionCollapsed[type]);
		bodyEl.classList.toggle('collapsed', sectionCollapsed[type]);
	};
	lbl.addEventListener('click', toggle);
	return lbl;
}

function renderInvoiceList(pending, archive) {
	const list = document.getElementById('invoiceList');
	list.innerHTML = '';

	const hasPending = pending.length > 0;
	const hasArchive = archive.length > 0;

	if (!hasPending && !hasArchive) {
		list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="18" cy="18" r="17" stroke="#c5cae9" stroke-width="1.5"/>
            <path d="M11 18.5l5 5 9-9" stroke="#1565c0" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </div>
        <div class="empty-state-text">Wszystko przejrzane</div>
        <div class="empty-state-sub">Powiadomimy Cię o nowych fakturach</div>
      </div>`;
		return;
	}

	if (hasPending) {
		const sorted = [...pending].sort((a, b) =>
			(b.issueDate || b.fetchedAt || '').localeCompare(a.issueDate || a.fetchedAt || '')
		);
		const rows = sorted.map((inv) => buildInvoiceRow(inv, 'pending'));

		if (hasArchive) {
			const body = document.createElement('div');
			body.className = 'section-body' + (sectionCollapsed.pending ? ' collapsed' : '');
			const inner = document.createElement('div'); // wymagane przez grid-trick
			rows.forEach((r) => inner.appendChild(r));
			body.appendChild(inner);
			list.appendChild(makeSectionLabel(`Nowe (${pending.length})`, 'pending', body));
			list.appendChild(body);
		} else {
			rows.forEach((r) => list.appendChild(r));
		}
	}

	if (hasArchive) {
		const body = document.createElement('div');
		body.className = 'section-body' + (sectionCollapsed.archive ? ' collapsed' : '');
		const inner = document.createElement('div'); // wymagane przez grid-trick
		archive.forEach((inv) => inner.appendChild(buildInvoiceRow(inv, 'archive')));
		body.appendChild(inner);
		list.appendChild(makeSectionLabel(`Wcześniejsze (${archive.length})`, 'archive', body));
		list.appendChild(body);
	}
}

function buildInvoiceRow(inv, type) {
	const item = document.createElement('div');
	item.className = `inv-item ${type}`;
	item.dataset.id = inv.id;

	const date = inv.issueDate
		? new Date(inv.issueDate).toLocaleDateString('pl-PL', { day: '2-digit', month: '2-digit', year: '2-digit' })
		: '';
	const amount =
		inv.grossAmount != null
			? inv.grossAmount.toLocaleString('pl-PL', {
					style: 'currency',
					currency: inv.currency || 'PLN',
					maximumFractionDigits: 2,
				})
			: '';

	const portalTitle = inv.ksefRef
		? `Otwórz Aplikację Podatnika KSeF\n(numer ${inv.ksefRef} zostanie skopiowany do schowka)`
		: 'Otwórz Aplikację Podatnika KSeF';

	// Akcje na poziomie meta (wiersz 2, prawa kolumna)
	const actionsHtml =
		type === 'pending'
			? `<div class="inv-actions">
         <button class="inv-act inv-act-done" title="Oznacz jako przejrzaną">✓</button>
       </div>`
			: `<div class="inv-actions">
         <button class="inv-act inv-act-star" title="Przywróć do nowych">★</button>
         <button class="inv-act inv-act-hide" title="Ukryj z listy">✕</button>
       </div>`;

	// Grid: seller + portal (wiersz 1), meta + akcje (wiersz 2)
	item.innerHTML = `
    <div class="inv-seller" title="${escHtml(inv.sellerName)}">${escHtml(trunc(inv.sellerName, 40))}</div>
    <button class="inv-portal" title="${escHtml(portalTitle)}">↗</button>
    <div class="inv-meta">
      <span class="inv-meta-date">${date}</span>
      <span class="inv-meta-number" title="${escHtml(inv.invoiceNumber)}">${escHtml(trunc(inv.invoiceNumber, 30))}</span>
      <span class="inv-meta-amount">${amount}</span>
    </div>
    ${actionsHtml}`;

	item.querySelector('.inv-portal').addEventListener('click', (e) => {
		e.stopPropagation();
		handleOpenInPortal(inv.ksefRef, config.environment);
	});

	if (type === 'pending') {
		item.querySelector('.inv-act-done').addEventListener('click', (e) => {
			e.stopPropagation();
			handleMarkNoticed(inv, item);
		});
	} else {
		item.querySelector('.inv-act-star').addEventListener('click', (e) => {
			e.stopPropagation();
			handleRestoreToPending(inv, item);
		});
		item.querySelector('.inv-act-hide').addEventListener('click', (e) => {
			e.stopPropagation();
			handleDismissArchive(inv, item);
		});
	}

	return item;
}

// ─── Mark as noticed + undo toast ─────────────────────────────────────────────

async function handleRestoreToPending(inv, itemEl) {
	itemEl.classList.add('dismissing');
	await chrome.runtime.sendMessage({ type: 'UNDO_NOTICED', invoiceId: inv.id });
	invoiceState.pendingInvoices = [inv, ...(invoiceState.pendingInvoices ?? [])];
	invoiceState.recentArchive = (invoiceState.recentArchive ?? []).filter((i) => i.id !== inv.id);
	renderMainView();
}

async function handleDismissArchive(inv, itemEl) {
	itemEl.classList.add('dismissing');
	await chrome.runtime.sendMessage({ type: 'DISMISS_ARCHIVE', invoiceId: inv.id });
	invoiceState.recentArchive = (invoiceState.recentArchive ?? []).filter((i) => i.id !== inv.id);
	invoiceState._lastDismissed = inv; // zapamiętaj do undo
	renderMainView();
	showToast(inv, 'archive');
}

async function handleMarkNoticed(inv, itemEl) {
	// Animacja znikania
	itemEl.classList.add('dismissing');

	await chrome.runtime.sendMessage({ type: 'MARK_NOTICED', invoiceId: inv.id });

	// Aktualizuj lokalny stan
	invoiceState.pendingInvoices = (invoiceState.pendingInvoices ?? []).filter((i) => i.id !== inv.id);
	invoiceState.recentArchive = [inv, ...(invoiceState.recentArchive ?? [])].slice(0, 5);

	renderMainView();
	showToast(inv);
}

function showToast(inv, type = 'pending') {
	if (toastTimer) {
		clearTimeout(toastTimer);
		toastTimer = null;
	}
	toastInvoiceId = inv.id;
	toastInvoiceType = type;
	toastBulkSnapshot = null;
	document.getElementById('toastMsg').textContent = `✓ ${trunc(inv.sellerName || 'Faktura', 28)}`;
	document.getElementById('toastUndo').style.display = '';
	document.getElementById('toast').classList.add('visible');
	toastTimer = setTimeout(dismissToast, 4000);
}

function showInfoToast(msg) {
	if (toastTimer) {
		clearTimeout(toastTimer);
		toastTimer = null;
	}
	toastInvoiceId = null;
	toastInvoiceType = null;
	toastBulkSnapshot = null;
	document.getElementById('toastMsg').textContent = msg;
	document.getElementById('toastUndo').style.display = 'none';
	document.getElementById('toast').classList.add('visible');
	toastTimer = setTimeout(dismissToast, 3000);
}

function showBulkToast(snapshot) {
	if (toastTimer) {
		clearTimeout(toastTimer);
		toastTimer = null;
	}
	toastInvoiceId = '__bulk__';
	toastInvoiceType = 'bulk';
	toastBulkSnapshot = snapshot;
	const n = snapshot.length;
	document.getElementById('toastMsg').textContent =
		`✓ Oznaczono ${n} ${n === 1 ? 'fakturę' : n < 5 ? 'faktury' : 'faktur'}`;
	document.getElementById('toastUndo').style.display = ''; // przywróć – showInfoToast go chowa
	document.getElementById('toast').classList.add('visible');
	toastTimer = setTimeout(dismissToast, 4000);
}

function dismissToast() {
	document.getElementById('toast').classList.remove('visible');
	toastInvoiceId = null;
	toastInvoiceType = null;
	toastBulkSnapshot = null;
	toastTimer = null;
}

async function handleUndoNoticed() {
	if (!toastInvoiceId) return;
	const id = toastInvoiceId;
	const type = toastInvoiceType;
	const snapshot = toastBulkSnapshot;
	dismissToast();

	if (type === 'bulk') {
		// Przywróć wszystkie z powrotem do pending
		await chrome.runtime.sendMessage({ type: 'UNDO_MARK_ALL', invoices: snapshot });
		invoiceState.pendingInvoices = [...(snapshot ?? []), ...(invoiceState.pendingInvoices ?? [])];
		invoiceState.recentArchive = (invoiceState.recentArchive ?? []).filter(
			(inv) => !(snapshot ?? []).find((s) => s.id === inv.id)
		);
	} else if (type === 'archive') {
		await chrome.runtime.sendMessage({ type: 'UNDO_DISMISS_ARCHIVE', invoiceId: id });
		const restored = invoiceState._lastDismissed;
		if (restored) {
			invoiceState.recentArchive = [restored, ...(invoiceState.recentArchive ?? [])]
				.slice(0, 5)
				.sort((a, b) => (b.issueDate || b.fetchedAt || '').localeCompare(a.issueDate || a.fetchedAt || ''));
			delete invoiceState._lastDismissed;
		} else {
			await loadState();
		}
	} else {
		// pending → przywróć z archiwum
		await chrome.runtime.sendMessage({ type: 'UNDO_NOTICED', invoiceId: id });
		const restored = (invoiceState.recentArchive ?? []).find((i) => i.id === id);
		if (restored) {
			invoiceState.pendingInvoices = [restored, ...(invoiceState.pendingInvoices ?? [])];
			invoiceState.recentArchive = (invoiceState.recentArchive ?? []).filter((i) => i.id !== id);
		}
	}

	renderMainView();
}

// ─── Zdarzenia ────────────────────────────────────────────────────────────────

function bindEvents() {
	// Edycja nazwy firmy w ustawieniach
	const scHint = document.getElementById('settingsCompanyHint');
	const scInput = document.getElementById('settingsCompanyInput');
	if (scHint && scInput) {
		scHint.addEventListener('click', () => {
			if (!scInput.readOnly) {
				// ✓ – zatwierdź
				saveSettingsCompanyName();
			} else {
				// ✏️ – odblokuj
				scInput.readOnly = false;
				scInput.style.cursor = 'text';
				scInput.value = config.companyName ?? '';
				scInput.focus();
				scInput.select();
				scHint.textContent = '✓';
			}
		});
		scInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				saveSettingsCompanyName();
			}
			if (e.key === 'Escape') {
				cancelSettingsCompanyEdit();
			}
		});
	}

	document.getElementById('btnOpenOnboarding').addEventListener('click', async () => {
		const W = 580,
			H = 680,
			MARGIN = 16;
		let left = 100,
			top = 60;
		try {
			const win = await chrome.windows.getCurrent();
			left = (win.left ?? 0) + (win.width ?? 1200) - W - MARGIN;
			top = (win.top ?? 0) + MARGIN;
		} catch {}
		chrome.windows.create({
			url: chrome.runtime.getURL('onboarding.html'),
			type: 'popup',
			width: W,
			height: H,
			left,
			top,
		});
		window.close();
	});

	document.getElementById('btnPinConfirm').addEventListener('click', handlePinConfirm);
	document.getElementById('btnNewTokenConfirm').addEventListener('click', handleNewTokenConfirm);

	// Live NIP extraction from new token input
	document.getElementById('newTokenInput').addEventListener('input', () => {
		const val = document.getElementById('newTokenInput').value.trim();
		const nipInfo = document.getElementById('newTokenNipConfirm');
		const match = val.match(/\|nip-(\d{10})\|/);
		if (match) {
			nipInfo.textContent = `✓ Wykryto NIP: ${match[1]}`;
			nipInfo.style.display = 'block';
		} else {
			nipInfo.style.display = 'none';
		}
	});
	// OTP boxes dla viewPin i viewNewToken
	initPopupOtp(['pinBox0', 'pinBox1', 'pinBox2', 'pinBox3'], 'pinToggle', handlePinConfirm);
	initPopupOtp(
		['newTokenPinBox0', 'newTokenPinBox1', 'newTokenPinBox2', 'newTokenPinBox3'],
		'newTokenPinToggle',
		handleNewTokenConfirm
	);

	document.getElementById('btnCheckNow').addEventListener('click', handleCheckNow);

	document.getElementById('btnMarkAll').addEventListener('click', async () => {
		const snapshot = [...(invoiceState.pendingInvoices ?? [])];
		if (snapshot.length === 0) return;

		await chrome.runtime.sendMessage({ type: 'MARK_ALL_NOTICED' });
		invoiceState.recentArchive = [...snapshot, ...(invoiceState.recentArchive ?? [])].slice(0, 5);
		invoiceState.pendingInvoices = [];
		renderMainView();
		showBulkToast(snapshot);
	});

	document.getElementById('btnReinitArchive').addEventListener('click', handleReinitArchive);
	document.getElementById('btnSettings').addEventListener('click', showSettingsView);
	document.getElementById('btnSaveSettings').addEventListener('click', handleSaveSettings);
	document.getElementById('btnBackFromSettings').addEventListener('click', async () => {
		await loadState();
		renderMainView();
		showView('viewMain');
	});
	document.getElementById('btnRemoveToken').addEventListener('click', handleRemoveToken);

	document.getElementById('btnErrorBack').addEventListener('click', determineAndShowView);
	document.getElementById('btnLogsBack').addEventListener('click', determineAndShowView);
	document.getElementById('btnClearLogs').addEventListener('click', async () => {
		await chrome.storage.local.remove('errorLog');
		renderLogsList([]);
	});
	document.getElementById('lnkLogs').addEventListener('click', (e) => {
		e.preventDefault();
		showErrorLogs();
	});

	document.getElementById('lnkContact').addEventListener('click', async (e) => {
		e.preventDefault();
		// Mailto z pre-wypełnionym tematem zawierającym wersję – ułatwia sortowanie zgłoszeń
		const manifest = chrome.runtime.getManifest();
		const subject = encodeURIComponent(`KSeF Monitor v${manifest.version} – feedback`);
		const body = encodeURIComponent('Cześć,\n\nChciałem zgłosić / zapytać o:\n\n');
		window.open(`mailto:ksef-monitor@pm.me?subject=${subject}&body=${body}`, '_blank');
	});

	document.getElementById('toastUndo').addEventListener('click', handleUndoNoticed);

	// Wstrzymaj odliczanie gdy kursor na toaście
	const toastEl = document.getElementById('toast');
	toastEl.addEventListener('mouseenter', () => {
		if (toastTimer) {
			clearTimeout(toastTimer);
			toastTimer = null;
		}
	});
	toastEl.addEventListener('mouseleave', () => {
		if (toastInvoiceId) toastTimer = setTimeout(dismissToast, 2000);
	});
}

// ─── PIN ──────────────────────────────────────────────────────────────────────

// ── OTP PIN helpers ───────────────────────────────────────────────────────────

function setPinError(errEl, msg) {
	if (!errEl) return;
	if (msg) {
		errEl.textContent = msg;
		const controls = document.querySelector('.pin-controls');
		if (controls && !controls.contains(errEl)) {
			const btnRow = controls.querySelector('.btn-row');
			controls.insertBefore(errEl, btnRow);
		}
		requestAnimationFrame(() => errEl.classList.add('visible'));
	} else {
		errEl.classList.remove('visible');
		setTimeout(() => {
			if (errEl && !errEl.classList.contains('visible') && errEl.parentNode) {
				const parking = document.getElementById('pinErrorParking');
				if (parking) parking.appendChild(errEl);
				errEl.textContent = '';
			}
		}, 200);
	}
}

function clearPinBoxes(ids) {
	ids.forEach((id, i) => {
		const b = document.getElementById(id);
		if (b) {
			b.value = '';
			b.classList.remove('filled');
		}
	});
	const first = document.getElementById(ids[0]);
	if (first) first.focus();
}

let _lockoutTimer = null;
function showLockoutCountdown(errEl, lockedUntil) {
	if (_lockoutTimer) clearInterval(_lockoutTimer);
	const update = () => {
		const secs = Math.ceil((lockedUntil - Date.now()) / 1000);
		if (secs <= 0) {
			clearInterval(_lockoutTimer);
			_lockoutTimer = null;
			setPinError(errEl, '');
			return;
		}
		setPinError(errEl, `Zbyt wiele błędnych prób. Poczekaj ${secs}s.`);
	};
	update();
	_lockoutTimer = setInterval(update, 1000);
}

function getOtpValue(ids) {
	return ids.map((id) => document.getElementById(id)?.value ?? '').join('');
}

function initPopupOtp(ids, toggleId, onComplete) {
	const boxes = ids.map((id) => document.getElementById(id));
	if (boxes.some((b) => !b)) return; // view nie wyrenderowany jeszcze

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
			} else if (e.key === 'ArrowRight' && i < boxes.length - 1) {
				boxes[i + 1].focus();
			} else if (e.key === 'Enter') {
				onComplete();
			}
		});
		box.addEventListener('input', (e) => {
			const val = (e.data || '').replace(/\D/g, '');
			box.value = val ? val[val.length - 1] : '';
			box.classList.toggle('filled', !!box.value);
			if (box.value && i < boxes.length - 1) boxes[i + 1].focus();
			else if (box.value && i === boxes.length - 1) onComplete();
		});
		box.addEventListener('focus', () => box.select());
		box.addEventListener('paste', (e) => {
			e.preventDefault();
			const digits = (e.clipboardData.getData('text') || '').replace(/\D/g, '').slice(0, boxes.length);
			boxes.forEach((b, j) => {
				b.value = digits[j] || '';
				b.classList.toggle('filled', !!b.value);
			});
			const next = Math.min(digits.length, boxes.length - 1);
			boxes[next].focus();
			if (digits.length === boxes.length) onComplete();
		});
	});

	const toggle = document.getElementById(toggleId);
	if (toggle) {
		toggle.addEventListener('click', () => {
			const hidden = boxes[0].type === 'password';
			boxes.forEach((b) => (b.type = hidden ? 'text' : 'password'));
			toggle.classList.toggle('active', hidden);
			toggle.setAttribute('aria-pressed', hidden ? 'true' : 'false');
			toggle.setAttribute('aria-label', hidden ? 'Ukryj PIN' : 'Pokaż PIN');
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────

async function handlePinConfirm() {
	const pin = getOtpValue(['pinBox0', 'pinBox1', 'pinBox2', 'pinBox3']);
	const errEl = document.getElementById('pinError');
	if (pin.length < 4) {
		setPinError(errEl, 'Wpisz 4-cyfrowy PIN.');
		return;
	}

	// Sprawdź lockout
	const PIN_MAX_ATTEMPTS = 5;
	const PIN_LOCKOUT_MS = 30_000;
	const lockoutData = await chrome.storage.local.get('pinLockout');
	let lockout = lockoutData.pinLockout ?? { attempts: 0, lockedUntil: null };

	// Reset attempts gdy lockout już minął
	if (lockout.lockedUntil && Date.now() >= lockout.lockedUntil) {
		lockout = { attempts: 0, lockedUntil: null };
		await chrome.storage.local.remove('pinLockout');
	}

	if (lockout.lockedUntil && Date.now() < lockout.lockedUntil) {
		showLockoutCountdown(errEl, lockout.lockedUntil);
		return;
	}

	const btn = document.getElementById('btnPinConfirm');
	btn.disabled = true;
	btn.innerHTML = `<div class="spinner"></div> Autoryzuję...`;
	setPinError(errEl, '');

	try {
		// Przy UI-lock (needsPin=false) background akceptuje dowolny PIN przez refresh token.
		// Weryfikujemy kryptograficznie przed wysłaniem żeby lockout działał poprawnie.
		const psData = await chrome.storage.local.get('pollState');
		const needsPin = psData.pollState?.needsPin ?? false;
		if (!needsPin) {
			const verifyResponse = await chrome.runtime.sendMessage({ type: 'VERIFY_PIN', pin });
			if (!verifyResponse.ok) {
				const attempts = (lockout.attempts ?? 0) + 1;
				const lockedUntil = attempts >= PIN_MAX_ATTEMPTS ? Date.now() + PIN_LOCKOUT_MS : null;
				await chrome.storage.local.set({ pinLockout: { attempts, lockedUntil } });
				const remaining = PIN_MAX_ATTEMPTS - attempts;
				if (lockedUntil) {
					showLockoutCountdown(errEl, lockedUntil);
				} else {
					setPinError(errEl, `Nieprawidłowy PIN. Pozostało prób: ${remaining}.`);
				}
				clearPinBoxes(['pinBox0', 'pinBox1', 'pinBox2', 'pinBox3']);
				btn.disabled = false;
				btn.textContent = 'Zaloguj ponownie';
				return;
			}
		}

		const response = await chrome.runtime.sendMessage({ type: 'POLL_NOW', pin });

		if (response.ok) {
			await chrome.storage.local.remove('pinLockout');
			['pinBox0', 'pinBox1', 'pinBox2', 'pinBox3'].forEach((id) => {
				const b = document.getElementById(id);
				if (b) {
					b.value = '';
					b.classList.remove('filled');
				}
			});
			await loadState();
			renderMainView();
			determineAndShowView();
		} else {
			const err = response.error ?? '';
			const isInvalidPin =
				err.includes('INVALID_PIN') ||
				err.toLowerCase().includes('pin') ||
				err.toLowerCase().includes('invalid') ||
				err.toLowerCase().includes('decrypt');

			if (isInvalidPin) {
				const attempts = (lockout.attempts ?? 0) + 1;
				const lockedUntil = attempts >= PIN_MAX_ATTEMPTS ? Date.now() + PIN_LOCKOUT_MS : null;
				await chrome.storage.local.set({ pinLockout: { attempts, lockedUntil } });
				const remaining = PIN_MAX_ATTEMPTS - attempts;
				if (lockedUntil) {
					showLockoutCountdown(errEl, lockedUntil);
				} else {
					setPinError(errEl, `Nieprawidłowy PIN. Pozostało prób: ${remaining}.`);
				}
				clearPinBoxes(['pinBox0', 'pinBox1', 'pinBox2', 'pinBox3']);
			} else {
				setPinError(errEl, `Błąd: ${err}`);
			}
		}
	} catch (err) {
		setPinError(errEl, 'Błąd połączenia: ' + err.message);
	} finally {
		btn.disabled = false;
		btn.textContent = 'Zaloguj ponownie';
	}
}

// ─── Nowy token (po unieważnieniu) ────────────────────────────────────────────

function extractNipFromToken(token) {
	const match = token.match(/\|nip-(\d{10})\|/);
	return match ? match[1] : null;
}

async function handleNewTokenConfirm() {
	const token = document.getElementById('newTokenInput').value.trim();
	const pin = getOtpValue(['newTokenPinBox0', 'newTokenPinBox1', 'newTokenPinBox2', 'newTokenPinBox3']);
	const errEl = document.getElementById('newTokenError');
	const btn = document.getElementById('btnNewTokenConfirm');
	errEl.textContent = '';

	if (!token || token.length < 20) {
		errEl.textContent = 'Token jest za krótki – wklej pełny token z portalu KSeF.';

		return;
	}
	if (pin.length < 4) {
		errEl.textContent = 'Wprowadź 4-cyfrowy PIN.';

		return;
	}

	const nipFromToken = extractNipFromToken(token);

	btn.disabled = true;
	btn.innerHTML = `<div class="spinner"></div> Zapisuję...`;

	try {
		const response = await chrome.runtime.sendMessage({
			type: 'UPDATE_TOKEN',
			token,
			pin,
			nip: nipFromToken,
		});
		if (response.ok) {
			document.getElementById('newTokenInput').value = '';
			['newTokenPinBox0', 'newTokenPinBox1', 'newTokenPinBox2', 'newTokenPinBox3'].forEach((id) => {
				const b = document.getElementById(id);
				if (b) {
					b.value = '';
					b.classList.remove('filled');
				}
			});
			await chrome.runtime.sendMessage({ type: 'CLEAR_BACKOFF' });
			const pollResp = await chrome.runtime.sendMessage({ type: 'POLL_NOW', pin });
			await loadState();
			if (pollResp.ok) {
				renderMainView();
				determineAndShowView();
			} else {
				errEl.textContent = `Token zapisany, ale połączenie nieudane: ${pollResp.error}`;
			}
		} else {
			errEl.textContent = response.error ?? 'Nie udało się zapisać tokenu.';
		}
	} catch (err) {
		errEl.textContent = 'Błąd: ' + err.message;
	} finally {
		btn.disabled = false;
		btn.textContent = 'Zapisz nowy token';
	}
}

async function handleCheckNow() {
	const btn = document.getElementById('btnCheckNow');
	btn.disabled = true;
	btn.innerHTML = `<div class="spinner"></div> Sprawdzam...`;

	await chrome.runtime.sendMessage({ type: 'CLEAR_BACKOFF' }).catch(() => {});

	try {
		const response = await chrome.runtime.sendMessage({ type: 'POLL_NOW' });
		await loadState();

		if (response.ok) {
			renderMainView();
		} else if (
			response.status === 401 ||
			response.error?.includes('PIN') ||
			response.error?.includes('AUTH') ||
			response.error?.includes('Sesja')
		) {
			showView('viewPin');
		} else {
			showError('Błąd sprawdzania', response.error);
		}
	} catch (err) {
		showError('Błąd połączenia', err.message);
	} finally {
		btn.disabled = false;
		btn.innerHTML = '🔄 Sprawdź teraz';
	}
}

// ─── Odśwież archiwum ─────────────────────────────────────────────────────────

async function handleReinitArchive() {
	const btn = document.getElementById('btnReinitArchive');
	const errEl = document.getElementById('reinitError');
	btn.disabled = true;
	btn.textContent = '⏳ Pobieranie...';
	errEl.textContent = '';

	try {
		const response = await chrome.runtime.sendMessage({ type: 'REINITIALIZE_ARCHIVE' });

		if (response.ok) {
			await loadState();
			renderMainView();
			showView('viewMain');
			showInfoToast(`✓ Pobrano ${response.count ?? 0} faktur`);
		} else if (response.status === 401 || response.error?.includes('PIN') || response.error?.includes('Sesja')) {
			errEl.textContent = 'Sesja wygasła. Wróć i użyj \u201eSprawdź teraz\u201d żeby ponownie się zalogować.';
		} else if (
			response.status === 429 ||
			response.error?.includes('RATE_LIMIT') ||
			response.error?.includes('429')
		) {
			const match = response.error?.match(/(\d+)s/);
			const wait = match ? `Odczekaj ${Math.ceil(match[1] / 60)} min.` : 'Odczekaj chwilę.';
			errEl.textContent = `Limit zapytań KSeF (HTTP 429). ${wait}`;
		} else {
			errEl.textContent = response.error ?? 'Nieznany błąd';
		}
	} catch (err) {
		errEl.textContent = 'Błąd połączenia: ' + err.message;
	} finally {
		btn.disabled = false;
		btn.textContent = '🔄 Odśwież archiwum faktur';
	}
}

// ─── Ustawienia ───────────────────────────────────────────────────────────────

function showSettingsView() {
	document.getElementById('selectInterval').value = String(config.pollIntervalMinutes ?? 60);
	document.getElementById('selectEnv').value = config.environment ?? 'production';
	document.getElementById('selectPendingDays').value = String(config.pendingDaysThreshold ?? 'month');

	const companyEl = document.getElementById('settingsCompany');
	const companyInput = document.getElementById('settingsCompanyInput');
	if (config.nip) {
		const label = '🏢 NIP ' + config.nip + (config.companyName ? '  ·  ' + config.companyName : '');
		companyInput.value = label;
		companyEl.style.display = 'block';
	} else {
		companyEl.style.display = 'none';
	}
	document.getElementById('toggleNotifications').checked = !!config.notificationsEnabled;
	showView('viewSettings');
}

async function saveSettingsCompanyName() {
	const scInput = document.getElementById('settingsCompanyInput');
	const scHint = document.getElementById('settingsCompanyHint');
	const newName = scInput.value.trim() || null;
	config.companyName = newName;
	await chrome.storage.local.set({ config });
	scInput.readOnly = true;
	scInput.style.cursor = 'default';
	scHint.textContent = '✏️';
	// odśwież wyświetlany label (z NIP)
	const label = '🏢 NIP ' + config.nip + (newName ? '  ·  ' + newName : '');
	scInput.value = label;
}

function cancelSettingsCompanyEdit() {
	const scInput = document.getElementById('settingsCompanyInput');
	const scHint = document.getElementById('settingsCompanyHint');
	scInput.readOnly = true;
	scInput.style.cursor = 'default';
	scHint.textContent = '✏️';
	const label = '🏢 NIP ' + config.nip + (config.companyName ? '  ·  ' + config.companyName : '');
	scInput.value = label;
}

async function handleSaveSettings() {
	// jeśli nazwa firmy była w trakcie edycji – zapisujemy co jest w polu
	const scInput = document.getElementById('settingsCompanyInput');
	if (scInput && !scInput.readOnly) {
		config.companyName = scInput.value.trim() || null;
		cancelSettingsCompanyEdit();
	}

	config.pollIntervalMinutes = parseInt(document.getElementById('selectInterval').value, 10);
	config.environment = document.getElementById('selectEnv').value;
	const rawDays = document.getElementById('selectPendingDays').value;
	config.pendingDaysThreshold = rawDays === 'month' ? 'month' : parseInt(rawDays, 10);
	config.notificationsEnabled = document.getElementById('toggleNotifications').checked;

	await chrome.storage.local.set({ config });
	await chrome.runtime.sendMessage({ type: 'UPDATE_INTERVAL', minutes: config.pollIntervalMinutes });

	document.getElementById('envLabel').textContent =
		{ production: 'PRD', demo: 'DEMO', test: 'TEST' }[config.environment] ?? 'PRD';

	await loadState();
	renderMainView();
	showView('viewMain');
}

async function handleRemoveToken() {
	const modal = document.getElementById('confirmModal');
	const btnOk = document.getElementById('confirmOk');
	const btnCxl = document.getElementById('confirmCancel');

	modal.style.display = 'flex';
	btnCxl.focus(); // fokus na "Anuluj" przy otwarciu – bezpieczniejsza opcja domyślna

	await new Promise((resolve) => {
		const focusableEls = [btnCxl, btnOk];
		const trapFocus = (e) => {
			if (e.key !== 'Tab') return;
			const first = focusableEls[0];
			const last = focusableEls[focusableEls.length - 1];
			if (e.shiftKey) {
				if (document.activeElement === first) {
					e.preventDefault();
					last.focus();
				}
			} else {
				if (document.activeElement === last) {
					e.preventDefault();
					first.focus();
				}
			}
		};
		const cleanup = (doIt) => {
			modal.style.display = 'none';
			btnOk.removeEventListener('click', onOk);
			btnCxl.removeEventListener('click', onCancel);
			modal.removeEventListener('click', onOverlay);
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('keydown', trapFocus);
			resolve(doIt);
		};
		const onOk = () => cleanup(true);
		const onCancel = () => cleanup(false);
		const onOverlay = (e) => {
			if (e.target === modal) cleanup(false);
		};
		const onKey = (e) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				cleanup(false);
			}
		};
		btnOk.addEventListener('click', onOk);
		btnCxl.addEventListener('click', onCancel);
		modal.addEventListener('click', onOverlay);
		document.addEventListener('keydown', onKey);
		document.addEventListener('keydown', trapFocus);
	}).then(async (confirmed) => {
		if (!confirmed) return;
		await chrome.storage.local.clear();
		try {
			await chrome.action.setBadgeText({ text: '' });
		} catch {
			/* ignore */
		}
		config = {};
		pollState = {};
		invoiceState = { allSeenIds: [], pendingInvoices: [], recentArchive: [], lastQueryTime: null };
		showView('viewSetup');
	});
}

// ─── Logi ─────────────────────────────────────────────────────────────────────

async function showErrorLogs() {
	const result = await chrome.storage.local.get('errorLog');
	renderLogsList(result.errorLog ?? []);
	showView('viewLogs');
}

function renderLogsList(logs) {
	const listEl = document.getElementById('logsList');
	const emptyEl = document.getElementById('logsEmpty');
	listEl.innerHTML = '';

	if (logs.length === 0) {
		listEl.style.display = 'none';
		emptyEl.style.display = 'block';
		return;
	}

	listEl.style.display = 'flex';
	emptyEl.style.display = 'none';

	logs.slice(0, 20).forEach((e) => {
		const entry = document.createElement('div');
		entry.className = 'log-entry error';
		entry.innerHTML = `
      <div class="log-time">${new Date(e.time).toLocaleString('pl-PL')}</div>
      <div><span class="log-code">${escHtml(e.code ?? 'ERR')}</span></div>
      <div class="log-msg">${escHtml(e.message ?? '')}</div>`;
		listEl.appendChild(entry);
	});
}

// ─── Error view ───────────────────────────────────────────────────────────────

function showError(title, message) {
	document.getElementById('errorTitle').textContent = title;
	document.getElementById('errorMessage').textContent = message;
	showView('viewError');
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function trunc(str, max) {
	if (!str) return '';
	return str.length <= max ? str : str.substring(0, max - 1) + '…';
}

function escHtml(str) {
	return String(str ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/**
 * Kopiuje numer KSeF do schowka i otwiera portal.
 * Nie istnieją publiczne deep linki do konkretnych faktur w portalu MF.
 */
function handleOpenInPortal(ksefRef, environment) {
	const portalUrl = environment === 'production' ? 'https://ap.ksef.mf.gov.pl' : 'https://ap-demo.ksef.mf.gov.pl';

	if (ksefRef) {
		navigator.clipboard.writeText(ksefRef).catch(() => {});
	}
	chrome.tabs.create({ url: portalUrl });
}
