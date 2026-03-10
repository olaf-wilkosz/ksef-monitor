/**
 * storage.js – warstwa dostępu do chrome.storage.local
 *
 * Schemat invoiceState (v0.3):
 *   allSeenIds:      string[]   – wszystkie ID jakie kiedykolwiek pobraliśmy (deduplikacja)
 *   pendingInvoices: Invoice[]  – nowe, nieprzejrzane (licznik + badge)
 *   recentArchive:   Invoice[]  – max 5 ostatnio przejrzanych (szare, punkt wyjścia)
 *   lastQueryTime:   string|null
 */

const KEYS = {
	ENCRYPTED_TOKEN: 'encryptedToken',
	CONFIG: 'config',
	AUTH_STATE: 'authState',
	POLL_STATE: 'pollState',
	INVOICE_STATE: 'invoiceState',
	ERROR_LOG: 'errorLog',
	ARCHIVE_UNDO_BUFFER: 'archiveUndoBuffer',
};

const ARCHIVE_MAX = 5;

// ─── Primitives ───────────────────────────────────────────────────────────────

async function get(key) {
	return new Promise((res, rej) => {
		chrome.storage.local.get(key, (result) => {
			if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
			else res(result[key] ?? null);
		});
	});
}

async function set(key, value) {
	return new Promise((res, rej) => {
		chrome.storage.local.set({ [key]: value }, () => {
			if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
			else res();
		});
	});
}

async function remove(key) {
	return new Promise((res, rej) => {
		chrome.storage.local.remove(key, () => {
			if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
			else res();
		});
	});
}

// ─── Config ───────────────────────────────────────────────────────────────────

export async function getConfig() {
	return (
		(await get(KEYS.CONFIG)) ?? {
			nip: null,
			environment: 'production',
			pollIntervalMinutes: 60,
			notificationsEnabled: false,
			pendingDaysThreshold: 'month',
		}
	);
}
export async function saveConfig(config) {
	await set(KEYS.CONFIG, config);
}

// ─── Token KSeF ───────────────────────────────────────────────────────────────

export async function getEncryptedToken() {
	return await get(KEYS.ENCRYPTED_TOKEN);
}
export async function saveEncryptedToken(data) {
	await set(KEYS.ENCRYPTED_TOKEN, data);
}
export async function hasToken() {
	return (await get(KEYS.ENCRYPTED_TOKEN)) !== null;
}
export async function clearToken() {
	await remove(KEYS.ENCRYPTED_TOKEN);
	await remove(KEYS.AUTH_STATE);
}

// ─── Auth state ───────────────────────────────────────────────────────────────

export async function getAuthState() {
	return (
		(await get(KEYS.AUTH_STATE)) ?? {
			accessToken: null,
			accessTokenExpiry: 0,
			refreshToken: null,
			refreshTokenExpiry: 0,
		}
	);
}
export async function saveAuthState(state) {
	await set(KEYS.AUTH_STATE, state);
}
export async function clearAuthState() {
	await remove(KEYS.AUTH_STATE);
}

// ─── Poll state ───────────────────────────────────────────────────────────────

export async function getPollState() {
	return (
		(await get(KEYS.POLL_STATE)) ?? {
			lastPollTime: null,
			lastSuccessTime: null,
			consecutiveErrors: 0,
			backoffUntil: null,
			needsPin: false,
			needsNewToken: false,
			lastError: null,
		}
	);
}
export async function savePollState(state) {
	await set(KEYS.POLL_STATE, state);
}

export async function recordPollSuccess() {
	const cur = await getPollState();
	await savePollState({
		...cur,
		lastPollTime: new Date().toISOString(),
		lastSuccessTime: new Date().toISOString(),
		consecutiveErrors: 0,
		backoffUntil: null,
		needsPin: false,
		needsNewToken: false,
		lastError: null,
	});
}

/** Wygasła sesja – czeka na PIN. Zero backoffu, zero counter. */
export async function recordNeedsPin() {
	const cur = await getPollState();
	await savePollState({
		...cur,
		lastPollTime: new Date().toISOString(),
		needsPin: true,
		needsNewToken: false,
		backoffUntil: null,
		consecutiveErrors: 0,
		lastError: null,
	});
}

/** Token unieważniony lub błędny (450) – wymaga wprowadzenia nowego tokenu. */
export async function recordNeedsNewToken(message) {
	const cur = await getPollState();
	await savePollState({
		...cur,
		lastPollTime: new Date().toISOString(),
		needsNewToken: true,
		needsPin: false,
		backoffUntil: null,
		consecutiveErrors: 0,
		lastError: { code: 'TOKEN_INVALID', message, time: new Date().toISOString() },
	});
	await appendErrorLog({ code: 'AUTH_FAILED_450', message });
}

/** Błąd sieciowy/serwera. Backoff: 1h → 2h → 4h → max 24h. */
export async function recordPollError(code, message) {
	const cur = await getPollState();
	const errors = (cur.consecutiveErrors ?? 0) + 1;
	await savePollState({
		...cur,
		lastPollTime: new Date().toISOString(),
		consecutiveErrors: errors,
		backoffUntil: new Date(Date.now() + Math.min(24, Math.pow(2, errors - 1)) * 3_600_000).toISOString(),
		needsPin: false,
		lastError: { code, message, time: new Date().toISOString() },
	});
	await appendErrorLog({ code, message });
}

export async function recordRateLimit(seconds) {
	const cur = await getPollState();
	await savePollState({
		...cur,
		lastPollTime: new Date().toISOString(),
		backoffUntil: new Date(Date.now() + seconds * 1000).toISOString(),
		lastError: { code: 429, message: `Rate limit – retry after ${seconds}s`, time: new Date().toISOString() },
	});
}

// ─── Invoice state ────────────────────────────────────────────────────────────

export async function saveInvoiceState(state) {
	await set(KEYS.INVOICE_STATE, state);
}

export async function getInvoiceState() {
	const raw = await get(KEYS.INVOICE_STATE);
	// Migracja z v0.1.x / v0.2.0 (stary schemat: lastSeenIds, newCount)
	if (raw && (raw.lastSeenIds || raw.newCount != null) && !raw.allSeenIds) {
		return {
			allSeenIds: raw.lastSeenIds ?? [],
			pendingInvoices: [],
			recentArchive: [],
			lastQueryTime: raw.lastQueryTime ?? null,
		};
	}
	return (
		raw ?? {
			allSeenIds: [],
			pendingInvoices: [],
			recentArchive: [],
			lastQueryTime: null,
		}
	);
}

/** Normalizuje surowy obiekt faktury z KSeF API. */
export function normalizeInvoice(raw) {
	// Szeroki fallback na ID – KSeF API może zwracać różne nazwy pola
	const ref =
		raw.ksefNumber || // ✓ faktyczna nazwa pola w KSeF API 2.0
		raw.ksefReferenceNumber ||
		raw.KsefReferenceNumber ||
		raw.referenceNumber ||
		raw.invoiceId ||
		raw.id ||
		'';

	// Seller name – faktyczna struktura: raw.seller.name
	const sellerName =
		raw.seller?.name ||
		raw.subjectBy?.subjectName ||
		raw.subjectBy?.name ||
		raw.sellerName ||
		raw.issuerName ||
		'Nieznany wystawca';

	// NIP sprzedawcy – faktyczna struktura: raw.seller.nip
	const sellerNip =
		raw.seller?.nip ||
		raw.subjectBy?.issuedToIdentifier?.value ||
		raw.subjectBy?.identifier?.value ||
		raw.sellerNip ||
		raw.issuerNip ||
		'';

	// Numer faktury
	const invoiceNumber = raw.invoiceReferenceNumber || raw.invoiceNumber || raw.number || '';

	// Data wystawienia
	const issueDate = raw.invoicingDate || raw.issueDate || raw.issuedAt || raw.dateOfIssue || '';

	return {
		id: ref,
		ksefRef: ref,
		sellerName,
		sellerNip,
		invoiceNumber,
		issueDate,
		grossAmount: raw.grossAmount ?? raw.totalAmountWithTax ?? raw.totalGrossAmount ?? null,
		currency: raw.currency || 'PLN',
		fetchedAt: new Date().toISOString(),
		_raw: undefined, // nie przechowujemy surowych danych
	};
}

/**
 * Inicjalizuje stan po onboardingu.
 *
 * Faktury z ostatnich 7 dni → pendingInvoices (nowe, licznik + badge).
 * Starsze → recentArchive (max 5, szare, punkt wyjścia).
 *
 * Dzięki temu użytkownik od razu widzi faktury które mogły przyjść
 * podczas gdy nie miał jeszcze rozszerzenia. Wszystkie ID trafiają
 * do allSeenIds – następny poll nie uzna ich za "nowe".
 *
 * @returns {number} liczba faktur w pending (do ustawienia badge)
 */
export async function initializeArchive(rawInvoices) {
	const cfg = await getConfig();
	const threshold = cfg.pendingDaysThreshold ?? 'month';
	const cutoff =
		threshold === 'month'
			? new Date(new Date().getFullYear(), new Date().getMonth(), 1) // 1. dzień bieżącego miesiąca
			: new Date(Date.now() - Number(threshold) * 24 * 3_600_000);

	const normalized = rawInvoices
		.map(normalizeInvoice)
		.filter((inv) => inv.id)
		.sort((a, b) => (b.issueDate || b.fetchedAt || '').localeCompare(a.issueDate || a.fetchedAt || ''));

	const pending = normalized.filter((inv) => inv.issueDate && new Date(inv.issueDate) >= cutoff);
	const older = normalized.filter((inv) => !inv.issueDate || new Date(inv.issueDate) < cutoff);

	const oldestDate =
		normalized.length > 0
			? normalized[normalized.length - 1].issueDate || new Date(Date.now() - 90 * 24 * 3_600_000).toISOString()
			: new Date(Date.now() - 90 * 24 * 3_600_000).toISOString();

	await set(KEYS.INVOICE_STATE, {
		allSeenIds: [...new Set(normalized.map((inv) => inv.id))],
		pendingInvoices: pending,
		recentArchive: older.slice(0, ARCHIVE_MAX),
		lastQueryTime: oldestDate,
	});

	return pending.length;
}

/**
 * Aktualizuje stan podczas regularnego pollingu.
 * Nowe faktury (nieznane) → pendingInvoices.
 * @returns {number} liczba nowych faktur
 */
export async function updateInvoices(rawInvoices) {
	const state = await getInvoiceState();
	const seenSet = new Set(state.allSeenIds);

	const normalized = rawInvoices.map(normalizeInvoice).filter((inv) => inv.id);
	const trulyNew = normalized.filter((inv) => !seenSet.has(inv.id));

	const newAllIds = [...new Set([...state.allSeenIds, ...normalized.map((inv) => inv.id)])];

	await set(KEYS.INVOICE_STATE, {
		allSeenIds: newAllIds,
		pendingInvoices: [...state.pendingInvoices, ...trulyNew],
		recentArchive: state.recentArchive,
		lastQueryTime: new Date().toISOString(),
	});

	return trulyNew.length;
}

/**
 * Przenosi fakturę z pendingInvoices → recentArchive (FIFO, max 5).
 * @returns {Invoice|null} przeniesiona faktura (do undo)
 */
export async function markNoticed(invoiceId) {
	const state = await getInvoiceState();
	const invoice = state.pendingInvoices.find((inv) => inv.id === invoiceId);
	if (!invoice) return null;

	await set(KEYS.INVOICE_STATE, {
		...state,
		pendingInvoices: state.pendingInvoices.filter((inv) => inv.id !== invoiceId),
		recentArchive: [invoice, ...state.recentArchive].slice(0, ARCHIVE_MAX),
	});
	return invoice;
}

/**
 * Cofa markNoticed – przenosi z recentArchive z powrotem do pendingInvoices.
 */
export async function undoNoticed(invoiceId) {
	const state = await getInvoiceState();
	const invoice = state.recentArchive.find((inv) => inv.id === invoiceId);
	if (!invoice) return;

	await set(KEYS.INVOICE_STATE, {
		...state,
		pendingInvoices: [invoice, ...state.pendingInvoices],
		recentArchive: state.recentArchive.filter((inv) => inv.id !== invoiceId),
	});
}

/**
 * Wypełnia recentArchive najnowszymi fakturami jeśli jest puste.
 * Działa tylko gdy dostajemy jakiekolwiek faktury z bieżącego pollu.
 * @param {object[]} rawInvoices – surowe faktury z ostatniego pollu
 */
export async function ensureArchiveBackfill(rawInvoices) {
	const state = await getInvoiceState();
	if (state.recentArchive.length > 0) return; // już jest archiwum

	if (!rawInvoices || rawInvoices.length === 0) return;

	const seenSet = new Set(state.allSeenIds);
	const archive = rawInvoices
		.map(normalizeInvoice)
		.filter((inv) => inv.id && seenSet.has(inv.id))
		.sort((a, b) => (b.issueDate || b.fetchedAt || '').localeCompare(a.issueDate || a.fetchedAt || ''))
		.slice(0, ARCHIVE_MAX);

	if (archive.length === 0) return;

	await set(KEYS.INVOICE_STATE, { ...state, recentArchive: archive });
}

/** Usuwa fakturę z archiwum (inbox zero dla archiwalnych). */
export async function dismissFromArchive(invoiceId) {
	const state = await getInvoiceState();
	const invoice = state.recentArchive.find((inv) => inv.id === invoiceId);
	if (invoice) await set(KEYS.ARCHIVE_UNDO_BUFFER, invoice); // zapamiętaj do undo (4s)
	await set(KEYS.INVOICE_STATE, {
		...state,
		recentArchive: state.recentArchive.filter((inv) => inv.id !== invoiceId),
	});
}

/** Cofa dismissFromArchive – przywraca fakturę do archiwum na właściwej pozycji (sort by issueDate). */
export async function undoDismissArchive(invoiceId) {
	const undoBuffer = await get(KEYS.ARCHIVE_UNDO_BUFFER);
	if (!undoBuffer || undoBuffer.id !== invoiceId) return;
	const state = await getInvoiceState();
	const merged = [undoBuffer, ...state.recentArchive]
		.slice(0, ARCHIVE_MAX)
		.sort((a, b) => (b.issueDate || b.fetchedAt || '').localeCompare(a.issueDate || a.fetchedAt || ''));
	await set(KEYS.INVOICE_STATE, { ...state, recentArchive: merged });
	await remove(KEYS.ARCHIVE_UNDO_BUFFER);
}

/** Oznacza wszystkie oczekujące jako przejrzane. */
export async function markAllNoticed() {
	const state = await getInvoiceState();
	await set(KEYS.INVOICE_STATE, {
		...state,
		pendingInvoices: [],
		recentArchive: [...state.pendingInvoices, ...state.recentArchive].slice(0, ARCHIVE_MAX),
	});
}

// ─── Error log ────────────────────────────────────────────────────────────────

async function appendErrorLog(entry) {
	const log = (await get(KEYS.ERROR_LOG)) ?? [];
	log.unshift({ ...entry, time: new Date().toISOString() });
	if (log.length > 50) log.length = 50;
	await set(KEYS.ERROR_LOG, log);
}
export async function getErrorLog() {
	return (await get(KEYS.ERROR_LOG)) ?? [];
}

export async function clearAll() {
	return new Promise((res, rej) => {
		chrome.storage.local.clear(() => {
			if (chrome.runtime.lastError) rej(chrome.runtime.lastError);
			else res();
		});
	});
}
