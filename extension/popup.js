/**
 * popup.js – logika interfejsu popup
 *
 * Stan faktur (v1.1 multi-NIP):
 *   accounts    – lista kont z pollState i invoiceState per NIP
 *   activeNip   – aktywny NIP (wybrany przez użytkownika)
 *   config      – globalna konfiguracja (interwał, powiadomienia, threshold)
 *
 * Renderowanie: NipSelector u góry viewMain, lista faktur dla activeNip
 * Badge = zagregowana liczba pending ze wszystkich NIP-ów
 */

// ─── Stan ─────────────────────────────────────────────────────────────────────

let config = {};
let accounts = []; // [{ nip, companyName, environment, pendingCount, pollState }]
let activeNip = null;

// Skróty do danych aktywnego konta
const activeAccount = () => accounts.find((a) => a.nip === activeNip) ?? null;
const activeInvoices = () => activeAccount()?.invoiceState ?? { pendingInvoices: [], recentArchive: [] };
const activePollState = () => activeAccount()?.pollState ?? {};

// Toast
let toastTimer = null;
let toastInvoiceId = null;
let toastInvoiceType = null;
let toastBulkSnapshot = null;

// Reaguj na zmiany storage gdy popup jest otwarty
chrome.storage.onChanged.addListener(async (changes, area) => {
	if (area !== 'local') return;
	if (!changes.accounts) return;

	// Reaguj tylko gdy zmienia się lista NIP-ów (dodanie/usunięcie konta),
	// nie przy każdej aktualizacji pollState/invoiceState
	const prevNips = new Set(Object.keys(changes.accounts.oldValue ?? {}));
	const currNips = new Set(Object.keys(changes.accounts.newValue ?? {}));
	const nipListChanged = prevNips.size !== currNips.size || [...currNips].some((n) => !prevNips.has(n));

	if (!nipListChanged) return;

	const wasEmpty = prevNips.size === 0;
	await loadState();
	const ps = activePollState();
	if (ps.needsNewToken) {
		showView('viewNewToken');
		return;
	}
	if (ps.needsPin) {
		showView('viewPin');
		return;
	}

	renderMainView();
	// Pierwsze konto – idź do głównego widoku (użytkownik skończył onboarding)
	// Kolejne zmiany (dodanie/usunięcie) – zostań w ustawieniach
	if (wasEmpty) {
		showView('viewMain');
	} else {
		showSettingsView();
	}
});

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
	await loadState();
	determineAndShowView();
	bindEvents();
});

// Odśwież stan gdy popup odzyska focus (np. po zamknięciu okna onboardingu)
window.addEventListener('focus', async () => {
	const prevNips = accounts.map((a) => a.nip).join(',');
	const wasEmpty = accounts.length === 0;
	await loadState();
	const currNips = accounts.map((a) => a.nip).join(',');
	if (currNips !== prevNips) {
		renderMainView();
		if (wasEmpty) {
			showView('viewMain');
		} else {
			showSettingsView();
		}
	}
});

async function loadState() {
	// Globalna konfiguracja
	const cfgResult = await chrome.storage.local.get('config');
	config = cfgResult.config ?? {
		pollIntervalMinutes: 60,
		notificationsEnabled: false,
		pendingDaysThreshold: 'month',
	};

	// Pobierz podsumowanie wszystkich kont z background
	const response = await chrome.runtime.sendMessage({ type: 'GET_ACCOUNTS_SUMMARY' }).catch(() => null);
	if (response?.ok) {
		accounts = response.accounts ?? [];
		activeNip = response.activeNip ?? accounts[0]?.nip ?? null;
	} else {
		// Fallback: SW nie żyje jeszcze (zimny start) – czytaj bezpośrednio z storage
		const raw = await chrome.storage.local.get(['accounts', 'activeNip']);
		const storedAccounts = raw.accounts ?? {};
		accounts = Object.entries(storedAccounts).map(([nip, account]) => ({
			nip,
			companyName: account.companyName,
			environment: account.environment,
			pendingCount: account.invoiceState?.pendingInvoices?.length ?? 0,
			pollState: account.pollState ?? {},
			authState: account.authState ?? {},
			invoiceState: account.invoiceState ?? {
				allSeenIds: [],
				pendingInvoices: [],
				recentArchive: [],
				lastQueryTime: null,
			},
		}));
		activeNip = raw.activeNip ?? accounts[0]?.nip ?? null;
	}

	// envLabel w headerze: środowisko aktywnego konta
	const env = activeAccount()?.environment ?? 'production';
	const labels = { production: 'PRD', demo: 'DEMO', test: 'TEST' };
	document.getElementById('envLabel').textContent = labels[env] ?? 'PRD';
}

// ─── Routing ──────────────────────────────────────────────────────────────────

// UI-lock (nie crypto-lock): po 4h bezczynności popup wymaga PIN zanim pokaże dane.
// Background nadal polluje przez refresh token – weryfikacja kryptograficzna przez VERIFY_PIN.
const PIN_TIMEOUT_MS = 4 * 60 * 60 * 1000;

function determineAndShowView() {
	if (accounts.length === 0) {
		showView('viewSetup');
		return;
	}

	const ps = activePollState();

	if (ps.needsNewToken) {
		showView('viewNewToken');
		return;
	}
	if (ps.needsPin) {
		showView('viewPin');
		return;
	}

	// Nieaktywność > 4h → wymagaj PIN zanim pokażemy dane
	const lastSuccess = ps.lastSuccessTime ? new Date(ps.lastSuccessTime).getTime() : 0;
	if (lastSuccess && Date.now() - lastSuccess > PIN_TIMEOUT_MS) {
		showView('viewPin');
		return;
	}

	// accessToken jest w session storage – sprawdzamy tylko refreshToken
	const authState = activeAccount()?.authState ?? {};
	const validRefresh = authState.refreshToken && authState.refreshTokenExpiry > Date.now() + 30_000;
	if (!validRefresh && !lastSuccess) {
		showView('viewPin');
		return;
	}

	renderMainView();
	showView('viewMain');
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
	const account = activeAccount();
	const inv = activeInvoices();
	const ps = activePollState();
	const pending = inv.pendingInvoices ?? [];
	const archive = inv.recentArchive ?? [];
	const count = pending.length;

	// NipSelector
	renderNipSelector();

	// Licznik
	const countEl = document.getElementById('invoiceCount');
	countEl.textContent = count;
	countEl.className = 'counter-num' + (count === 0 ? ' zero' : '');

	// Czas ostatniego sprawdzenia
	const qt = ps.lastSuccessTime;
	document.getElementById('lastCheck').textContent = qt
		? 'Sprawdzono ' +
			new Date(qt).toLocaleString('pl-PL', {
				day: '2-digit',
				month: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
			})
		: 'Nigdy nie sprawdzono';

	// envLabel – środowisko aktywnego konta
	const labels = { production: 'PRD', demo: 'DEMO', test: 'TEST' };
	document.getElementById('envLabel').textContent = labels[account?.environment ?? 'production'] ?? 'PRD';

	renderStatusBadge();
	renderInvoiceList(pending, archive);
}

// ─── NipSelector ─────────────────────────────────────────────────────────────

function renderNipSelector() {
	const container = document.getElementById('nipSelector');
	if (!container) return;

	// Ukryj selector jeśli tylko jeden NIP
	if (accounts.length <= 1) {
		container.style.display = 'none';
		return;
	}

	container.style.display = 'flex';
	container.style.flexDirection = 'column';
	container.innerHTML = '';

	if (accounts.length <= 3) {
		// Do 3 NIP-ów → przyciski w kolumnie
		accounts.forEach((account) => {
			const btn = document.createElement('button');
			btn.className = 'nip-btn' + (account.nip === activeNip ? ' active' : '');
			const name = account.companyName || `NIP ${account.nip}`;
			const badge = account.pendingCount > 0 ? ` <span class="nip-badge">${account.pendingCount}</span>` : '';
			btn.innerHTML = `<span class="nip-btn-label">${escHtml(name)}</span>${badge}`;
			btn.setAttribute('aria-label', `${name}, ${account.pendingCount} nowych`);
			btn.addEventListener('click', () => switchNip(account.nip));
			container.appendChild(btn);
		});
	} else {
		// 3+ NIP-ów → dropdown
		const select = document.createElement('select');
		select.className = 'nip-select';
		select.setAttribute('aria-label', 'Wybierz NIP');
		accounts.forEach((account) => {
			const opt = document.createElement('option');
			opt.value = account.nip;
			const label = account.companyName
				? `${trunc(account.companyName, 20)} (${account.nip})`
				: `NIP ${account.nip}`;
			opt.textContent = account.pendingCount > 0 ? `${label} · ${account.pendingCount} nowych` : label;
			if (account.nip === activeNip) opt.selected = true;
			select.appendChild(opt);
		});
		select.addEventListener('change', () => switchNip(select.value));
		container.appendChild(select);
	}
}

async function switchNip(nip) {
	activeNip = nip;
	await chrome.runtime.sendMessage({ type: 'SET_ACTIVE_NIP', nip });
	renderedPendingCount = RENDER_PAGE;
	renderedArchiveCount = RENDER_PAGE;
	renderMainView();
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function renderStatusBadge() {
	const el = document.getElementById('pollStatus');
	const ps = activePollState();
	el.classList.remove('clickable', 's-ok', 's-warn', 's-err', 's-pin');

	if (ps.needsPin) {
		el.textContent = 'Wymagany PIN →';
		el.classList.add('s-pin', 'clickable');
		el.onclick = () => showView('viewPin');
	} else if (ps.backoffUntil && new Date(ps.backoffUntil) > new Date()) {
		const min = Math.ceil((new Date(ps.backoffUntil) - Date.now()) / 60000);
		el.textContent = `Backoff (${min} min)`;
		el.classList.add('s-warn');
		el.onclick = null;
	} else if ((ps.consecutiveErrors ?? 0) > 0) {
		el.textContent = `Błąd (${ps.consecutiveErrors}×)`;
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

// Render counters – ile pozycji aktualnie wyrenderowanych (reset przy renderMainView)
let renderedPendingCount = 10;
let renderedArchiveCount = 10;
const RENDER_PAGE = 10;

function makeSectionLabel(text, type, bodyEl, bodyId) {
	const lbl = document.createElement('div');
	lbl.className = `list-section-label${type === 'pending' ? ' pending' : ''}`;
	if (sectionCollapsed[type]) lbl.classList.add('collapsed');

	// Tekst – przewija listę do tej sekcji
	const btnScroll = document.createElement('button');
	btnScroll.className = 'section-label-text';
	btnScroll.textContent = text;
	btnScroll.setAttribute('aria-label', `Przewiń do sekcji ${type === 'pending' ? 'Nowe' : 'Wcześniejsze'}`);
	btnScroll.addEventListener('click', () => {
		const list = document.getElementById('invoiceList');
		if (type === 'pending') {
			// "Nowe" jest sticky – przewijamy listę do góry żeby odsłonić treść sekcji
			list.scrollTo({ top: 0, behavior: 'smooth' });
		} else {
			lbl.scrollIntoView({ behavior: 'smooth', block: 'start' });
		}
	});

	// Chevron – zwija/rozwija
	const btnToggle = document.createElement('button');
	btnToggle.className = 'section-chevron';
	btnToggle.innerHTML = CHEVRON_SVG;
	btnToggle.setAttribute('aria-expanded', sectionCollapsed[type] ? 'false' : 'true');
	if (bodyId) btnToggle.setAttribute('aria-controls', bodyId);
	btnToggle.setAttribute(
		'aria-label',
		`${sectionCollapsed[type] ? 'Rozwiń' : 'Zwiń'} sekcję ${type === 'pending' ? 'Nowe' : 'Wcześniejsze'}`
	);

	const toggle = () => {
		sectionCollapsed[type] = !sectionCollapsed[type];
		lbl.classList.toggle('collapsed', sectionCollapsed[type]);
		bodyEl.classList.toggle('collapsed', sectionCollapsed[type]);
		btnToggle.setAttribute('aria-expanded', sectionCollapsed[type] ? 'false' : 'true');
		btnToggle.setAttribute(
			'aria-label',
			`${sectionCollapsed[type] ? 'Rozwiń' : 'Zwiń'} sekcję ${type === 'pending' ? 'Nowe' : 'Wcześniejsze'}`
		);
	};
	btnToggle.addEventListener('click', toggle);

	lbl.appendChild(btnScroll);
	lbl.appendChild(btnToggle);
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
		const visible = sorted.slice(0, renderedPendingCount);
		const remaining = sorted.length - visible.length;

		const body = document.createElement('div');
		body.className = 'section-body' + (sectionCollapsed.pending ? ' collapsed' : '');
		body.id = 'sectionBodyPending';
		const inner = document.createElement('div'); // wymagane przez grid-trick

		visible.forEach((inv) => inner.appendChild(buildInvoiceRow(inv, 'pending')));

		// Przyciski na dole sekcji Nowe
		const actionsRow = document.createElement('div');
		actionsRow.className = 'section-actions';

		if (remaining > 0) {
			const btnMore = document.createElement('button');
			btnMore.className = 'btn-section-action';
			btnMore.textContent = `Pokaż kolejne ${Math.min(RENDER_PAGE, remaining)} nowe (${remaining} oczekujących)`;
			btnMore.addEventListener('click', () => {
				renderedPendingCount += RENDER_PAGE;
				const inv = activeInvoices();
				renderInvoiceList(inv.pendingInvoices ?? [], inv.recentArchive ?? []);
			});
			actionsRow.appendChild(btnMore);
		}

		const btnAll = document.createElement('button');
		btnAll.className = 'btn-section-action btn-section-action--all';
		btnAll.textContent = `Oznacz wszystkie ${sorted.length} nowe jako przejrzane`;
		btnAll.addEventListener('click', async () => {
			const snapshot = [...(activeInvoices().pendingInvoices ?? [])];
			if (snapshot.length === 0) return;
			await chrome.runtime.sendMessage({ type: 'MARK_ALL_NOTICED', nip: activeNip });
			// Aktualizuj lokalny stan konta
			const acc = activeAccount();
			if (acc) {
				acc.invoiceState.recentArchive = [...snapshot, ...(acc.invoiceState.recentArchive ?? [])];
				acc.invoiceState.pendingInvoices = [];
				acc.pendingCount = 0;
			}
			renderedPendingCount = RENDER_PAGE;
			renderMainView();
			showBulkToast(snapshot);
		});
		actionsRow.appendChild(btnAll);
		inner.appendChild(actionsRow);

		body.appendChild(inner);
		if (hasArchive) {
			const pendingLabel = makeSectionLabel(`Nowe (${pending.length})`, 'pending', body, 'sectionBodyPending');
			list.appendChild(pendingLabel);
			// Ustaw top dla "Wcześniejsze" po wyrenderowaniu Nowe – sticky stacking
			requestAnimationFrame(() => {
				const h = pendingLabel.getBoundingClientRect().height;
				const archiveLabel = list.querySelector('.list-section-label:not(.pending)');
				if (archiveLabel) archiveLabel.style.top = `${h}px`;
			});
		}
		list.appendChild(body);
	}

	if (hasArchive) {
		const sorted = [...archive].sort((a, b) =>
			(b.issueDate || b.fetchedAt || '').localeCompare(a.issueDate || a.fetchedAt || '')
		);
		const visible = sorted.slice(0, renderedArchiveCount);
		const remaining = sorted.length - visible.length;

		const body = document.createElement('div');
		body.className = 'section-body' + (sectionCollapsed.archive ? ' collapsed' : '');
		body.id = 'sectionBodyArchive';
		const inner = document.createElement('div'); // wymagane przez grid-trick

		visible.forEach((inv) => inner.appendChild(buildInvoiceRow(inv, 'archive')));

		if (remaining > 0) {
			const actionsRow = document.createElement('div');
			actionsRow.className = 'section-actions';
			const btnMore = document.createElement('button');
			btnMore.className = 'btn-section-action';
			btnMore.textContent = `Pokaż kolejne ${Math.min(RENDER_PAGE, remaining)} wcześniejsze (${remaining} pozostałych)`;
			btnMore.addEventListener('click', () => {
				renderedArchiveCount += RENDER_PAGE;
				const inv = activeInvoices();
				renderInvoiceList(inv.pendingInvoices ?? [], inv.recentArchive ?? []);
			});
			actionsRow.appendChild(btnMore);
			inner.appendChild(actionsRow);
		}

		body.appendChild(inner);
		list.appendChild(makeSectionLabel(`Wcześniejsze (${archive.length})`, 'archive', body, 'sectionBodyArchive'));
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
			? `<div class="inv-actions"><button class="inv-act inv-act-done" title="Oznacz jako przejrzaną">✓</button></div>`
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
		handleOpenInPortal(inv.ksefRef, activeAccount()?.environment ?? 'production');
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
	await chrome.runtime.sendMessage({ type: 'UNDO_NOTICED', invoiceId: inv.id, nip: activeNip });
	const acc = activeAccount();
	if (acc) {
		acc.invoiceState.pendingInvoices = [inv, ...(acc.invoiceState.pendingInvoices ?? [])];
		acc.invoiceState.recentArchive = (acc.invoiceState.recentArchive ?? []).filter((i) => i.id !== inv.id);
		acc.pendingCount = acc.invoiceState.pendingInvoices.length;
	}
	renderMainView();
}

async function handleDismissArchive(inv, itemEl) {
	itemEl.classList.add('dismissing');
	await chrome.runtime.sendMessage({ type: 'DISMISS_ARCHIVE', invoiceId: inv.id, nip: activeNip });
	const acc = activeAccount();
	if (acc) {
		acc.invoiceState._lastDismissed = inv; // zapamiętaj do undo
		acc.invoiceState.recentArchive = (acc.invoiceState.recentArchive ?? []).filter((i) => i.id !== inv.id);
	}
	renderMainView();
	showToast(inv, 'archive');
}

async function handleMarkNoticed(inv, itemEl) {
	// Animacja znikania
	itemEl.classList.add('dismissing');
	await chrome.runtime.sendMessage({ type: 'MARK_NOTICED', invoiceId: inv.id, nip: activeNip });
	// Aktualizuj lokalny stan
	const acc = activeAccount();
	if (acc) {
		acc.invoiceState.pendingInvoices = (acc.invoiceState.pendingInvoices ?? []).filter((i) => i.id !== inv.id);
		acc.invoiceState.recentArchive = [inv, ...(acc.invoiceState.recentArchive ?? [])];
		acc.pendingCount = acc.invoiceState.pendingInvoices.length;
	}
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
	document.getElementById('toastUndo').style.display = '';
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
		await chrome.runtime.sendMessage({ type: 'UNDO_MARK_ALL', invoices: snapshot, nip: activeNip });
		const acc = activeAccount();
		if (acc) {
			acc.invoiceState.pendingInvoices = [...(snapshot ?? []), ...(acc.invoiceState.pendingInvoices ?? [])];
			acc.invoiceState.recentArchive = (acc.invoiceState.recentArchive ?? []).filter(
				(inv) => !(snapshot ?? []).find((s) => s.id === inv.id)
			);
			acc.pendingCount = acc.invoiceState.pendingInvoices.length;
		}
	} else if (type === 'archive') {
		await chrome.runtime.sendMessage({ type: 'UNDO_DISMISS_ARCHIVE', invoiceId: id, nip: activeNip });
		const acc = activeAccount();
		if (acc) {
			const restored = acc.invoiceState._lastDismissed;
			if (restored) {
				acc.invoiceState.recentArchive = [restored, ...(acc.invoiceState.recentArchive ?? [])].sort((a, b) =>
					(b.issueDate || b.fetchedAt || '').localeCompare(a.issueDate || a.fetchedAt || '')
				);
				delete acc.invoiceState._lastDismissed;
			} else {
				await loadState();
			}
		}
	} else {
		// pending → przywróć z archiwum
		await chrome.runtime.sendMessage({ type: 'UNDO_NOTICED', invoiceId: id, nip: activeNip });
		const acc = activeAccount();
		if (acc) {
			const restored = (acc.invoiceState.recentArchive ?? []).find((i) => i.id === id);
			if (restored) {
				acc.invoiceState.pendingInvoices = [restored, ...(acc.invoiceState.pendingInvoices ?? [])];
				acc.invoiceState.recentArchive = (acc.invoiceState.recentArchive ?? []).filter((i) => i.id !== id);
				acc.pendingCount = acc.invoiceState.pendingInvoices.length;
			}
		}
	}

	renderMainView();
}

// ─── Zdarzenia ────────────────────────────────────────────────────────────────

function bindEvents() {
	document.getElementById('btnOpenOnboarding').addEventListener('click', () => {
		chrome.runtime.sendMessage({ type: 'OPEN_ONBOARDING', mode: 'setup' });
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
	document.getElementById('btnReinitArchive').addEventListener('click', handleReinitArchive);
	document.getElementById('btnSettings').addEventListener('click', showSettingsView);
	document.getElementById('btnSaveSettings').addEventListener('click', handleSaveSettings);
	document.getElementById('btnBackFromSettings').addEventListener('click', async () => {
		await loadState();
		renderMainView();
		showView('viewMain');
	});
	document.getElementById('btnAddNip')?.addEventListener('click', () => {
		chrome.runtime.sendMessage({ type: 'OPEN_ONBOARDING', mode: 'add' });
		// Nie zamykamy popupa – czekamy na storage.onChanged gdy nowe konto zostanie dodane
	});
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
	ids.forEach((id) => {
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

	if (lockout.lockedUntil && Date.now() >= lockout.lockedUntil) {
		// Reset attempts gdy lockout już minął
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
		const ps = activePollState();
		if (!ps.needsPin) {
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

		const response = await chrome.runtime.sendMessage({ type: 'POLL_NOW', pin, nip: activeNip });

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
			nip: nipFromToken ?? activeNip,
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
			await chrome.runtime.sendMessage({ type: 'CLEAR_BACKOFF', nip: activeNip });
			const pollResp = await chrome.runtime.sendMessage({ type: 'POLL_NOW', pin, nip: activeNip });
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
	await chrome.runtime.sendMessage({ type: 'CLEAR_BACKOFF', nip: activeNip }).catch(() => {});

	try {
		const response = await chrome.runtime.sendMessage({ type: 'POLL_NOW', nip: activeNip });
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
		const response = await chrome.runtime.sendMessage({ type: 'REINITIALIZE_ARCHIVE', nip: activeNip });
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
	document.getElementById('selectPendingDays').value = String(config.pendingDaysThreshold ?? 'month');
	document.getElementById('toggleNotifications').checked = !!config.notificationsEnabled;
	renderNipList();
	showView('viewSettings');
}

function renderNipList() {
	const container = document.getElementById('nipListSettings');
	if (!container) return;
	container.innerHTML = '';

	accounts.forEach((account) => {
		const row = document.createElement('div');
		row.className = 'nip-list-row';
		row.style.cssText = 'position:relative;margin-bottom:6px;display:flex;align-items:center;gap:6px;';

		// Jednolinijkowy input: 🏢 NIP · Nazwa
		const inputWrap = document.createElement('div');
		inputWrap.style.cssText = 'position:relative;flex:1;min-width:0;';

		const input = document.createElement('input');
		input.type = 'text';
		input.className = 'nip-card-name-input';
		const buildLabel = (name) => `🏢 NIP ${account.nip}${name ? '  ·  ' + name : ''}`;
		input.value = buildLabel(account.companyName);
		input.readOnly = true;
		input.style.cursor = 'default';
		input.setAttribute('aria-label', `NIP ${account.nip}`);

		const hint = document.createElement('span');
		hint.style.cssText =
			'position:absolute;right:8px;top:50%;transform:translateY(-50%);font-size:12px;cursor:pointer;';
		hint.textContent = '✏️';
		hint.setAttribute('role', 'button');
		hint.setAttribute('tabindex', '0');
		hint.setAttribute('aria-label', 'Edytuj nazwę firmy');

		const saveName = async () => {
			// Pole w trybie edycji zawiera tylko nazwę – czytamy wprost
			const newName = input.value.trim() || null;
			account.companyName = newName;
			const stored = (await chrome.storage.local.get('accounts')).accounts ?? {};
			if (stored[account.nip]) {
				stored[account.nip].companyName = newName;
				await chrome.storage.local.set({ accounts: stored });
			}
			input.value = buildLabel(newName);
			input.readOnly = true;
			input.style.cursor = 'default';
			hint.textContent = '✏️';
			if (account.nip === activeNip) renderNipSelector();
		};

		const startEdit = () => {
			// W trybie edycji pole zawiera tylko nazwę (bez prefiksu)
			input.value = account.companyName ?? '';
			input.readOnly = false;
			input.style.cursor = 'text';
			input.focus();
			input.select();
			hint.textContent = '✓';
		};

		hint.addEventListener('click', () => (input.readOnly ? startEdit() : saveName()));
		hint.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				hint.click();
			}
		});
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				saveName();
			}
			if (e.key === 'Escape') {
				input.value = buildLabel(account.companyName);
				input.readOnly = true;
				input.style.cursor = 'default';
				hint.textContent = '✏️';
			}
		});

		inputWrap.appendChild(input);
		inputWrap.appendChild(hint);

		const btnRemove = document.createElement('button');
		btnRemove.className = 'nip-list-remove';
		btnRemove.innerHTML = '🗑️';
		btnRemove.setAttribute('aria-label', `Usuń NIP ${account.nip}`);
		btnRemove.addEventListener('click', () => handleRemoveNip(account.nip));

		row.appendChild(inputWrap);
		row.appendChild(btnRemove);
		container.appendChild(row);
	});
}

async function handleSaveSettings() {
	// jeśli nazwa firmy była w trakcie edycji – zapisujemy co jest w polu
	const scInput = document.getElementById('settingsCompanyInput');
	if (scInput && !scInput.readOnly) {
		await saveSettingsCompanyName();
	}

	// Globalna konfiguracja
	config.pollIntervalMinutes = parseInt(document.getElementById('selectInterval').value, 10);
	config.pendingDaysThreshold = (() => {
		const v = document.getElementById('selectPendingDays').value;
		return v === 'month' ? 'month' : parseInt(v, 10);
	})();
	config.notificationsEnabled = document.getElementById('toggleNotifications').checked;
	await chrome.storage.local.set({ config });
	await chrome.runtime.sendMessage({ type: 'UPDATE_INTERVAL', minutes: config.pollIntervalMinutes });

	const labels = { production: 'PRD', demo: 'DEMO', test: 'TEST' };
	document.getElementById('envLabel').textContent = labels[activeAccount()?.environment ?? 'production'] ?? 'PRD';

	await loadState();
	renderMainView();
	showView('viewMain');
}

async function handleRemoveNip(nip) {
	if (!nip) return;

	const modal = document.getElementById('confirmModal');
	const btnOk = document.getElementById('confirmOk');
	const btnCxl = document.getElementById('confirmCancel');

	// Dostosuj tekst modalu
	const titleEl = document.getElementById('confirmModalTitle');
	const descEl = modal.querySelector('[style*="margin-bottom: 16px"]');
	const isLast = accounts.length === 1;
	if (titleEl) titleEl.textContent = isLast ? 'Usuń token i konfigurację?' : `Usuń NIP ${nip}?`;
	if (descEl)
		descEl.textContent = isLast
			? 'Rozszerzenie przestanie działać. Będziesz musiał przejść onboarding od nowa.'
			: `Faktury i historia dla NIP ${nip} zostaną usunięte.`;

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

		const response = await chrome.runtime.sendMessage({ type: 'REMOVE_ACCOUNT', nip });
		if (response.ok && response.remaining.length === 0) {
			// Ostatni NIP – wyczyść i wróć do setupu
			try {
				await chrome.action.setBadgeText({ text: '' });
			} catch {}
			accounts = [];
			activeNip = null;
			config = {};
			showView('viewSetup');
		} else {
			await loadState();
			renderMainView();
			showSettingsView();
		}
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
      <div><span class="log-code">${escHtml(e.code ?? 'ERR')}</span>${e.nip ? ` <span style="color:#888">(${e.nip})</span>` : ''}</div>
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
