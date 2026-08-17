const state = {
  granularity: 'current_week',
  view: 'calculator',
  mappings: [],
  mappingMeta: {},
  visibleMappingIds: new Set(),
  mappingSort: {
    field: '',
    direction: 'asc',
  },
};

const els = {
  startDate: document.querySelector('#startDate'),
  endDate: document.querySelector('#endDate'),
  runButton: document.querySelector('#runButton'),
  statusStrip: document.querySelector('#statusStrip'),
  logoutButton: document.querySelector('#logoutButton'),
  netSales: document.querySelector('#netSales'),
  unitsSold: document.querySelector('#unitsSold'),
  asp: document.querySelector('#asp'),
  generatedAt: document.querySelector('#generatedAt'),
  resultsBody: document.querySelector('#resultsBody'),
  segments: [...document.querySelectorAll('.segment')],
  viewTabs: [...document.querySelectorAll('.view-tab')],
  calculatorView: document.querySelector('#calculatorView'),
  mappingView: document.querySelector('#mappingView'),
  mappingBody: document.querySelector('#mappingBody'),
  mappingStatus: document.querySelector('#mappingStatus'),
  mappingSortButtons: [...document.querySelectorAll('[data-mapping-sort]')],
  refreshShopifyMappingsButton: document.querySelector('#refreshShopifyMappingsButton'),
  saveMappingButton: document.querySelector('#saveMappingButton'),
};

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 0,
});

initialize();

function initialize() {
  const { start, end } = currentWeekRange();
  els.startDate.value = start;
  els.endDate.value = end;

  els.segments.forEach((button) => {
    button.addEventListener('click', () => setGranularity(button.dataset.granularity));
  });

  els.viewTabs.forEach((button) => {
    button.addEventListener('click', () => setView(button.dataset.view));
  });

  els.mappingSortButtons.forEach((button) => {
    button.addEventListener('click', () => setMappingSort(button.dataset.mappingSort));
  });

  els.runButton.addEventListener('click', () => loadAsp());
  els.logoutButton.addEventListener('click', () => logout());
  els.refreshShopifyMappingsButton.addEventListener('click', () => refreshShopifyMappings());
  els.saveMappingButton.addEventListener('click', () => saveMappings());
  els.mappingBody.addEventListener('input', () => setMappingStatus('Unsaved changes'));
  els.mappingBody.addEventListener('change', () => setMappingStatus('Unsaved changes'));

  loadMappings();
  loadAsp();
}

function setView(view) {
  state.view = view;
  const isMapping = view === 'mapping';
  els.calculatorView.classList.toggle('active', !isMapping);
  els.mappingView.classList.toggle('active', isMapping);

  els.viewTabs.forEach((button) => {
    const active = button.dataset.view === view;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function setGranularity(granularity) {
  state.granularity = granularity;

  if (granularity === 'current_week') {
    const { start, end } = currentWeekRange();
    els.startDate.value = start;
    els.endDate.value = end;
  }

  els.segments.forEach((button) => {
    const active = button.dataset.granularity === granularity;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

async function loadMappings() {
  setMappingStatus('Loading...');

  try {
    const response = await fetch('/api/mappings');
    const payload = await response.json();
    if (response.status === 401) return redirectToLogin();
    if (!response.ok) throw new Error(payload.detail || payload.error || 'Mapping request failed');

    state.mappingMeta = payload;
    state.mappings = payload.mappings || [];
    renderMappingRows(state.mappings);
    setMappingStatus(`${payload.summary?.active || 0} active`);
  } catch (error) {
    setMappingStatus(error.message);
  }
}

async function refreshShopifyMappings() {
  els.refreshShopifyMappingsButton.disabled = true;
  setMappingStatus('Loading Shopify SKUs...');

  try {
    const response = await fetch('/api/mappings/shopify-source', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        startDate: els.startDate.value,
        endDate: els.endDate.value,
      }),
    });

    const payload = await response.json();
    if (response.status === 401) return redirectToLogin();
    if (!response.ok) throw new Error(payload.detail || payload.error || 'Shopify SKU request failed');

    const sourceMappings = payload.mappings || [];
    const preservedMappings = payload.preservedMappings || [];
    state.mappingMeta = payload;
    state.mappings = [...sourceMappings, ...preservedMappings];
    renderMappingRows(sourceMappings);
    setMappingStatus(`${payload.sourceSummary?.total || sourceMappings.length} Shopify SKUs · ${payload.summary?.active || 0} active`);
  } catch (error) {
    setMappingStatus(error.message);
  } finally {
    els.refreshShopifyMappingsButton.disabled = false;
  }
}

async function saveMappings() {
  const mappings = collectMappingRows();
  const visibleIds = new Set(state.visibleMappingIds);
  els.saveMappingButton.disabled = true;
  setMappingStatus('Saving...');

  try {
    const response = await fetch('/api/mappings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: state.mappingMeta.version || 1,
        sourceFiles: state.mappingMeta.sourceFiles || [],
        mappings,
      }),
    });

    const payload = await response.json();
    if (response.status === 401) return redirectToLogin();
    if (!response.ok) throw new Error(payload.detail || payload.error || 'Mapping save failed');

    state.mappingMeta = payload;
    state.mappings = payload.mappings || [];
    const visibleMappings = state.mappings.filter((mapping) => visibleIds.has(String(mapping.id || '')));
    renderMappingRows(visibleMappings.length ? visibleMappings : state.mappings);
    setMappingStatus(`${payload.summary?.active || 0} active`);
    await loadAsp();
  } catch (error) {
    setMappingStatus(error.message);
  } finally {
    els.saveMappingButton.disabled = false;
  }
}

function renderMappingRows(mappings) {
  mappings = mappings || [];
  state.visibleMappingIds = new Set((mappings || []).map((mapping) => String(mapping.id || '')));
  updateMappingSortHeaders();

  if (!mappings.length) {
    els.mappingBody.innerHTML = `<tr><td class="empty" colspan="4">No mappings yet.</td></tr>`;
    return;
  }

  els.mappingBody.innerHTML = sortedMappingRows(mappings).map((mapping) => mappingRowTemplate(mapping)).join('');
}

function mappingRowTemplate(mapping) {
  return `
    <tr data-mapping-id="${escapeHtml(mapping.id || '')}">
      <td>
        <input class="mapping-check" type="checkbox" data-field="active" ${mapping.active ? 'checked' : ''} aria-label="Include in ASP">
      </td>
      <td><input class="mapping-input code" data-field="shopifySku" value="${escapeHtml(mapping.shopifySku || '')}"></td>
      <td><input class="mapping-input code" data-field="netsuiteItem" value="${escapeHtml(mapping.netsuiteItem || '')}"></td>
      <td><input class="mapping-input factor" type="number" min="0" step="0.01" data-field="candleUnitsPerNetSuiteUnit" value="${numberInput(mapping.candleUnitsPerNetSuiteUnit ?? 1)}"></td>
    </tr>
  `;
}

function collectMappingRows() {
  const visibleMappings = collectVisibleMappingRows();
  const visibleIds = new Set(visibleMappings.map((mapping) => String(mapping.id || '')));
  const preservedMappings = state.mappings
    .filter((mapping) => !visibleIds.has(String(mapping.id || '')))
    .map((mapping) => cleanMapping(mapping));

  return [...visibleMappings, ...preservedMappings];
}

function collectVisibleMappingRows() {
  const existingById = new Map(state.mappings.map((mapping) => [String(mapping.id || ''), mapping]));

  return [...els.mappingBody.querySelectorAll('tr[data-mapping-id]')].map((row, index) => {
    const value = (field) => row.querySelector(`[data-field="${field}"]`);
    const existing = existingById.get(row.dataset.mappingId || '') || {};

    return {
      id: row.dataset.mappingId || `map-${index + 1}`,
      active: Boolean(value('active')?.checked),
      shopifySku: value('shopifySku')?.value || '',
      shopifyTitle: existing.shopifyTitle || '',
      netsuiteItem: value('netsuiteItem')?.value || '',
      netsuiteName: existing.netsuiteName || '',
      candleUnitsPerNetSuiteUnit: Number(value('candleUnitsPerNetSuiteUnit')?.value ?? 1),
      notes: existing.notes || '',
    };
  });
}

function cleanMapping(mapping) {
  return {
    id: mapping.id || '',
    active: Boolean(mapping.active),
    shopifySku: mapping.shopifySku || '',
    shopifyTitle: mapping.shopifyTitle || '',
    netsuiteItem: mapping.netsuiteItem || '',
    netsuiteName: mapping.netsuiteName || '',
    candleUnitsPerNetSuiteUnit: Number(mapping.candleUnitsPerNetSuiteUnit ?? 1),
    notes: mapping.notes || '',
  };
}

function setMappingSort(field) {
  const visibleMappings = collectVisibleMappingRows();
  const sameField = state.mappingSort.field === field;

  state.mappingSort = {
    field,
    direction: sameField && state.mappingSort.direction === 'asc' ? 'desc' : defaultSortDirection(field),
  };

  renderMappingRows(visibleMappings);
}

function defaultSortDirection(field) {
  return field === 'active' ? 'desc' : 'asc';
}

function sortedMappingRows(mappings) {
  if (!state.mappingSort.field) return mappings;

  const direction = state.mappingSort.direction === 'desc' ? -1 : 1;
  return [...mappings].sort((left, right) => {
    const result = compareMappingValues(
      mappingSortValue(left, state.mappingSort.field),
      mappingSortValue(right, state.mappingSort.field)
    );

    if (result !== 0) return result * direction;
    return compareMappingValues(mappingSortValue(left, 'shopifySku'), mappingSortValue(right, 'shopifySku'));
  });
}

function mappingSortValue(mapping, field) {
  if (field === 'active') return mapping.active ? 1 : 0;
  if (field === 'candleUnitsPerNetSuiteUnit') return Number(mapping.candleUnitsPerNetSuiteUnit || 0);
  if (field === 'netsuiteItem') return String(mapping.netsuiteItem || '').toUpperCase();
  return String(mapping.shopifySku || '').toUpperCase();
}

function compareMappingValues(left, right) {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left > right ? 1 : -1;
  }

  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function updateMappingSortHeaders() {
  els.mappingSortButtons.forEach((button) => {
    const isActive = button.dataset.mappingSort === state.mappingSort.field;
    const direction = isActive ? state.mappingSort.direction : '';
    const indicator = button.querySelector('.sort-indicator');

    button.classList.toggle('active', isActive);
    button.setAttribute('aria-pressed', String(isActive));
    button.closest('th')?.setAttribute('aria-sort', isActive ? (direction === 'desc' ? 'descending' : 'ascending') : 'none');
    if (indicator) indicator.textContent = isActive ? (direction === 'desc' ? ' v' : ' ^') : '';
  });
}

function setMappingStatus(message) {
  els.mappingStatus.textContent = message;
}

async function loadAsp() {
  setLoading(true);
  renderError('');

  try {
    const response = await fetch('/api/asp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        startDate: els.startDate.value,
        endDate: els.endDate.value,
        granularity: state.granularity,
      }),
    });

    const payload = await response.json();
    if (response.status === 401) return redirectToLogin();
    if (!response.ok) throw new Error(payload.detail || payload.error || 'ASP request failed');

    render(payload);
  } catch (error) {
    renderError(error.message);
  } finally {
    setLoading(false);
  }
}

async function logout() {
  els.logoutButton.disabled = true;

  try {
    await fetch('/api/logout', { method: 'POST' });
  } finally {
    window.location.assign('/login');
  }
}

function redirectToLogin() {
  window.location.assign('/login');
}

function render(payload) {
  const summary = payload.summary || {};

  els.netSales.textContent = currency(summary.netSales);
  els.unitsSold.textContent = decimalNumber(summary.unitsSold);
  els.asp.textContent = currency(summary.asp);
  els.generatedAt.textContent = payload.generatedAt
    ? `Updated ${new Date(payload.generatedAt).toLocaleString()}`
    : '';

  renderStatus(payload);
  renderRows(payload.rows || []);
}

function renderStatus(payload) {
  const chips = [];
  chips.push(chip(payload.dataMode === 'live' ? 'Live data' : 'Demo data', payload.dataMode === 'live' ? 'live' : 'demo'));
  chips.push(chip(payload.config?.shopify?.configured ? 'Shopify set' : 'Shopify pending'));
  chips.push(chip(payload.config?.netsuite?.configured ? 'NetSuite set' : 'NetSuite pending'));
  if (payload.mappings) chips.push(chip(`${payload.mappings.active || 0} mappings`, 'live'));
  els.statusStrip.innerHTML = chips.join('');
}

function renderRows(rows) {
  if (!rows.length) {
    els.resultsBody.innerHTML = `<tr><td class="empty" colspan="5">No rows returned.</td></tr>`;
    return;
  }

  els.resultsBody.innerHTML = rows
    .map((row) => {
      return `
        <tr>
          <td>${escapeHtml(row.label)}</td>
          <td>${currency(row.netSales)}</td>
          <td>${decimalNumber(row.unitsSold)}</td>
          <td>${wholeNumber(row.orders)}</td>
          <td>${currency(row.asp)}</td>
        </tr>
      `;
    })
    .join('');
}

function renderError(message) {
  if (!message) return;

  els.resultsBody.innerHTML = `<tr><td class="error" colspan="5">${escapeHtml(message)}</td></tr>`;
  els.statusStrip.innerHTML = chip('Needs attention', 'demo');
}

function setLoading(isLoading) {
  els.runButton.disabled = isLoading;
  els.runButton.textContent = isLoading ? 'Running...' : 'Run ASP';
}

function chip(label, tone = '') {
  return `<span class="chip ${tone}">${escapeHtml(label)}</span>`;
}

function currency(value) {
  return currencyFormatter.format(Number(value || 0));
}

function wholeNumber(value) {
  return numberFormatter.format(Number(value || 0));
}

function decimalNumber(value) {
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: Number(value || 0) % 1 === 0 ? 0 : 2,
  }).format(Number(value || 0));
}

function numberInput(value) {
  const number = Number(value ?? 1);
  return Number.isFinite(number) ? String(number) : '1';
}

function currentWeekRange() {
  const today = new Date();
  const dayIndex = today.getDay();
  const start = new Date(today);
  start.setDate(today.getDate() - dayIndex);

  return {
    start: isoDate(start),
    end: isoDate(today),
  };
}

function isoDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
